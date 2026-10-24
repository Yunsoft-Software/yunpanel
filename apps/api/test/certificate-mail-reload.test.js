import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { reloadCertificateMail } from '../src/certificate-mail-reload.js';
import { createLocalHostOperations } from '../src/local-host-operations.js';
import { createJobRegistry, jobPublicView } from '../src/job-registry.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';

const leaf = { certName: 'mail.example.com', fullchainPath: '/etc/letsencrypt/live/mail.example.com/fullchain.pem',
  privateKeyPath: '/etc/letsencrypt/live/mail.example.com/privkey.pem', certificatePath: '/etc/letsencrypt/live/mail.example.com/cert.pem',
  fingerprint256: Array(32).fill('AB').join(':'), validFrom: '2026-10-12T00:00:00.000Z', validTo: '2027-01-10T00:00:00.000Z', dryRun: false };
const success = { service: 'mail', status: 'succeeded', stage: 'reload', imapFingerprintVerified: true, smtpFingerprintVerified: true };
function fixture(patch = {}) {
  let binding = { serverId: 'server-1', webDomainId: 'domain-1', hostname: leaf.certName, certificateId: 'certificate-1', revision: 1 };
  const certificate = { ...leaf, id: 'certificate-1', serverId: 'server-1', domainId: 'domain-1', state: 'renewing',
    source: 'acme', staging: false, domains: [leaf.certName], ...patch };
  const calls = [];
  return { calls, certificate, changeBinding: value => { binding = value; }, options: {
    serverId: 'server-1', certificateId: 'certificate-1', result: leaf,
    mailServiceIdentityRegistry: { getForServer: async () => binding },
    certificateRegistry: { getCertificate: async () => certificate },
    domainRegistry: { getDomain: async () => ({ id: 'domain-1', serverId: 'server-1', primaryDomain: leaf.certName, certificateId: 'certificate-1' }) },
    reload: async identity => { calls.push(identity); return success; },
  } };
}
test('renewing mail identity resolves only the current certificate and passes its newly inspected fingerprint privately', async () => {
  const f = fixture(); assert.deepEqual(await reloadCertificateMail(f.options), success);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].fingerprint256, leaf.fingerprint256);
  assert.equal(f.calls[0].fullchainPath, leaf.fullchainPath);
});
test('unbound and unrelated certificates leave mail services alone', async () => {
  const f = fixture({ domainId: 'other-domain', certName: 'other.example.com', domains: ['other.example.com'] });
  assert.equal(await reloadCertificateMail(f.options), null); assert.equal(f.calls.length, 0);
  f.changeBinding(null); assert.equal(await reloadCertificateMail(f.options), null);
});

test('the existing single-label wildcard mail identity remains valid, while a deeper hostname is rejected', async () => {
  const f = fixture({ certName: 'example.com', certificateNames: ['example.com', '*.example.com'],
    fullchainPath: '/etc/letsencrypt/live/example.com/fullchain.pem', privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem' });
  f.options.result = { ...leaf, certName: f.certificate.certName, fullchainPath: f.certificate.fullchainPath, privateKeyPath: f.certificate.privateKeyPath };
  assert.deepEqual(await reloadCertificateMail(f.options), success);assert.equal(f.calls[0].hostname, 'mail.example.com');
  f.changeBinding({ serverId: 'server-1', webDomainId: 'domain-1', hostname: 'deep.mail.example.com', certificateId: 'certificate-1', revision: 2 });
  f.options.domainRegistry.getDomain = async () => ({ serverId: 'server-1', primaryDomain: 'deep.mail.example.com', certificateId: 'certificate-1' });
  assert.equal((await reloadCertificateMail(f.options)).status, 'failed');assert.equal(f.calls.length, 1);
});
for (const patch of [{ serverId: 'other-server' }, { staging: true }, { state: 'retired' }, { source: 'custom' }, { fullchainPath: '/foreign/cert.pem' }]) {
  test(`private renewal consumer rejects drift ${Object.keys(patch)[0]} before host reload`, async () => {
    const f = fixture(patch); assert.equal((await reloadCertificateMail(f.options)).status, 'failed'); assert.equal(f.calls.length, 0);
  });
}
test('consumer revision changes during reload and private provider errors are masked', async () => {
  const f = fixture(); f.options.reload = async () => { f.changeBinding({ revision: 2 }); return success; };
  assert.equal((await reloadCertificateMail(f.options)).status, 'failed');
  f.options.mailServiceIdentityRegistry.getForServer = async () => { throw new Error('PRIVATE_KEY=/secret/path'); };
  assert.equal(JSON.stringify(await reloadCertificateMail(f.options)).includes('PRIVATE'), false);
});
for (const status of ['renewed', 'unchanged']) test(`${status} runs both native consumers and keeps mail proof in durable and public results`, async () => {
  const f = fixture(); const operations = createLocalHostOperations({
    acmeManager: { renewCertificate: async () => ({ ...leaf, status }) },
    nginxManager: { reloadConfiguration: async () => ({ service: 'nginx', status: 'succeeded', stage: 'reload' }) },
    mailConfigActivator: { reloadTlsIdentity: f.options.reload, activateConfiguration: async () => { throw Error('must not reapply mail configuration'); } },
    loadCertificateMailReload: (result, execution, reload) => reloadCertificateMail({ ...f.options, result, reload,
      serverId: execution.serverId, certificateId: execution.resourceId }),
  });
  const native = await operations.executeOperation(OPERATIONS.SSL_RENEW, { certName: leaf.certName }, { serverId: 'server-1', resourceId: 'certificate-1' });
  assert.deepEqual(native.mailReloadOutcome, success);
  const jobs = createJobRegistry({ serverExists: async () => true });const j = await jobs.enqueue({ serverId: 'server-1',
    type: 'ssl.renew', operation: OPERATIONS.SSL_RENEW, resourceType: 'certificate', resourceId: 'certificate-1', payload: { certName: leaf.certName } });
  await jobs.claimNext('server-1');const completed = await jobs.complete({ serverId: 'server-1', jobId: j.id, status: 'succeeded', result: native });
  assert.deepEqual(jobPublicView(completed).result.mailReloadOutcome, success);
  assert.equal(JSON.stringify(jobPublicView(completed).result).includes('/etc/letsencrypt'), false);
});
test('dry run never resolves or reloads a mail consumer', async () => {
  const operations = createLocalHostOperations({ acmeManager: { renewCertificate: async () => ({ dryRun: true, status: 'validated' }) },
    loadCertificateMailReload: () => { throw Error('must not reload'); } });
  assert.equal((await operations.executeOperation(OPERATIONS.SSL_RENEW, {})).dryRun, true);
});
for (const nginxStatus of ['succeeded', 'failed']) test(`mail success cannot hide ${nginxStatus} Nginx reload`, async () => {
  let final, rebound = false;const f = fixture({ state: 'active', purpose: 'web' });
  const result = await reconcileCompletedJob({
    domainRegistry: { attachCertificate: async () => {} },
    certificateRegistry: { markActive: async () => f.certificate, commitSelection: async () => {}, recordReloadOutcome: async (id, outcome) => { final = outcome; } },
    mailServiceIdentityRegistry: { getForServer: f.options.mailServiceIdentityRegistry.getForServer, bind: () => { rebound = true; } },
    job: { id: 'job-1', resourceId: 'certificate-1', resourceType: 'certificate', operation: OPERATIONS.SSL_RENEW, status: 'succeeded',
      result: { ...leaf, mailReloadOutcome: success, reloadOutcome: { service: 'nginx', status: nginxStatus, stage: 'reload' } } },
  });
  assert.equal(rebound, false);assert.equal(final.status, nginxStatus === 'failed' ? 'partial' : 'succeeded');
  assert.equal(result.outcome === 'partial', nginxStatus === 'failed');
});
test('legacy terminal mail renewal missing consumer proof retains recovery and preserves the valid certificate', async () => {
  const f = fixture({ state: 'active', purpose: 'web' });let failed = false;
  await assert.rejects(reconcileCompletedJob({ domainRegistry: { attachCertificate: async () => {} },
    certificateRegistry: { markActive: async () => f.certificate, commitSelection: async () => {}, recordReloadOutcome: async () => {}, markFailed: async () => { failed = true; } },
    mailServiceIdentityRegistry: f.options.mailServiceIdentityRegistry,
    job: { id: 'job-1', operation: OPERATIONS.SSL_RENEW, resourceType: 'certificate', resourceId: 'certificate-1', status: 'succeeded', result: leaf },
  }), { code: 'reconcile_certificate_mail_reload_evidence_missing' });assert.equal(failed, false);
});

test('public consumer outcomes retain canonical failure without provider strings or secret material', () => {
  for (const outcome of [success, { service: 'mail', stage: 'reload', status: 'failed', error: 'PRIVATE_NATIVE_PASSWORD' }]) {
    const result = jobPublicView({ operation: OPERATIONS.SSL_RENEW, result: { ...leaf,
      mailReloadOutcome: { ...outcome, privateKeyPath: '/secret/key', stderr: 'PRIVATE_OUTPUT' } } }).result;
    assert.equal(result.mailReloadOutcome.status, outcome.status);
    assert.equal(/PRIVATE|secret\/key|letsencrypt/.test(JSON.stringify(result)), false);
  }
});
