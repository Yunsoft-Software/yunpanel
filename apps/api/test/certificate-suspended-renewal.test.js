import assert from 'node:assert/strict';import test from 'node:test';import { randomUUID } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';import { createDomainRegistry } from '../src/domain-registry.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';import { reconcileCompletedJob } from '../src/job-reconciliation.js';

async function fixture() {
  const serverId = randomUUID(), domains = createDomainRegistry(), certificates = createCertificateRegistry();
  const domain = await domains.createDomain({ serverId, primaryDomain: 'mail.example.com', aliases: [],
    targetType: 'static', target: { root: '/var/www/mail.example.com' }, httpsMode: 'managed' });
  const cert = await certificates.createForDomain({ serverId, domainId: domain.id, domains: ['mail.example.com'],
    email: 'ops@example.com', staging: false });
  const base = '/etc/letsencrypt/live/mail.example.com';const leaf = { certName: 'mail.example.com',
    domains: ['mail.example.com'], certificatePath: base + '/cert.pem', fullchainPath: base + '/fullchain.pem', privateKeyPath: base + '/privkey.pem',
    fingerprint256: Array(32).fill('AB').join(':'), validFrom: '2026-10-10T00:00:00.000Z', validTo: '2027-01-08T00:00:00.000Z' };
  await certificates.setState(cert.id, 'issuing');await certificates.markActive(cert.id, leaf);
  await domains.attachCertificate(domain.id, cert.id, { domains: leaf.domains });
  await domains.markStaged(domain.id, { checksum: 'a'.repeat(64), configName: 'yunpanel-mail.example.com.conf' });
  const active = await domains.markApplied(domain.id, { checksum: 'a'.repeat(64) });
  const suspended = await domains.markSuspended(domain.id, { expectedRevision: active.desiredRevision, checksum: 'a'.repeat(64), operationId: randomUUID() });
  return { serverId, domains, certificates, cert, leaf, suspended };
}

test('renewal of the selected certificate preserves a suspended mail routing record exactly', async () => {
  const f = await fixture();await f.certificates.setState(f.cert.id, 'renewing');
  const renewed = { ...f.leaf, fingerprint256: Array(32).fill('CD').join(':'), validTo: '2027-01-09T00:00:00.000Z', dryRun: false, status: 'renewed',
    reloadOutcome: { service: 'nginx', status: 'succeeded', stage: 'reload' },
    mailReloadOutcome: { service: 'mail', status: 'succeeded', stage: 'reload', imapFingerprintVerified: true, smtpFingerprintVerified: true } };
  const job = { id: randomUUID(), serverId: f.serverId, resourceType: 'certificate', resourceId: f.cert.id,
    operation: OPERATIONS.SSL_RENEW, status: 'succeeded', result: renewed };
  const input = { domainRegistry: f.domains, certificateRegistry: f.certificates,
    mailServiceIdentityRegistry: { getForServer: async () => ({ webDomainId: f.suspended.id, hostname: 'mail.example.com' }) }, job };
  assert.equal((await reconcileCompletedJob(input)).reconciled, true);
  assert.deepEqual(await f.domains.getDomain(f.suspended.id), f.suspended);
  const certificate = await f.certificates.getCertificate(f.cert.id);assert.equal(certificate.state, 'active');
  assert.equal(certificate.fingerprint256, renewed.fingerprint256);assert.equal(certificate.lastReloadOutcome.status, 'succeeded');
  assert.equal((await reconcileCompletedJob(input)).reconciled, true);
  assert.equal((await f.certificates.getCertificate(f.cert.id)).lastRenewedAt, certificate.lastRenewedAt);
});

test('a suspended domain still rejects a replacement certificate and mismatched names', async () => {
  const f = await fixture();await assert.rejects(f.domains.attachCertificate(f.suspended.id, randomUUID(), { domains: ['mail.example.com'] }),
    { code: 'domain_suspended_update_blocked' });
  await assert.rejects(f.domains.attachCertificate(f.suspended.id, f.cert.id, { domains: ['other.example.com'] }), { code: 'certificate_domain_mismatch' });
  assert.deepEqual(await f.domains.getDomain(f.suspended.id), f.suspended);
});
