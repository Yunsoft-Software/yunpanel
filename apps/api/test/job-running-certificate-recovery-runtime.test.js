import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningCertificateRecoveryFromStores } from '../src/job-running-certificate-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const hostname = 'host-1';

test('certificate recovery runtime exposes exact registries, private receipt and read-only X.509 inspection', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const fakeDomainRegistry = { async init() { calls.push(['domain.init']); } };
  const fakeCertificateRegistry = { async init() { calls.push(['certificate.init']); } };

  const result = await runRunningCertificateRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
      YUNPANEL_DOMAIN_STORE: '/work/state/domains.json',
      YUNPANEL_CERTIFICATE_STORE: '/work/state/certificates.json',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname }; },
    }),
    domainRegistryFactory: ({ filePath }) => { calls.push(['domain.create', filePath]); return fakeDomainRegistry; },
    certificateRegistryFactory: ({ filePath }) => { calls.push(['certificate.create', filePath]); return fakeCertificateRegistry; },
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => ({
      async read(id) { calls.push(['context.read', filePath, id]); return { id }; },
    }),
    receiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) {
        calls.push(['receipt.read', receiptServerId, receiptJobId]);
        return { serverId: receiptServerId, jobId: receiptJobId };
      },
    }),
    acmeManagerFactory: () => ({
      async inspectCertificate(certName) {
        calls.push(['certificate.inspect', certName]);
        return { certName };
      },
      issueHttp01: async () => { throw new Error('must not be exposed'); },
      renew: async () => { throw new Error('must not be exposed'); },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.equal(input.domainRegistry, fakeDomainRegistry);
      assert.equal(input.certificateRegistry, fakeCertificateRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId });
      assert.equal((await input.readCertificateReceipt(serverId, jobId)).jobId, jobId);
      assert.deepEqual(await input.inspectCertificate('example.com'), { certName: 'example.com' });
      return {
        serverId,
        jobId,
        operation: 'ssl.issue',
        certificateId: 'certificate-1',
        status: 'succeeded',
        recoveryMethod: 'verified_certificate_receipt_and_live_x509',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['domain.create', '/work/state/domains.json'],
    ['domain.init'],
    ['certificate.create', '/work/state/certificates.json'],
    ['certificate.init'],
    ['context.read', '/work/state/jobs.json', jobId],
    ['receipt.read', serverId, jobId],
    ['certificate.inspect', 'example.com'],
  ]);
});

test('wrong host stops certificate recovery before resource registries and ACME evidence open', async () => {
  let domainFactories = 0;
  let certificateFactories = 0;
  let durableFactories = 0;
  let receiptFactories = 0;
  let acmeFactories = 0;
  await assert.rejects(
    runRunningCertificateRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      domainRegistryFactory: () => { domainFactories += 1; return { async init() {} }; },
      certificateRegistryFactory: () => { certificateFactories += 1; return { async init() {} }; },
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => { durableFactories += 1; return {}; },
      contextReaderFactory: () => ({ read: async () => ({}) }),
      receiptStoreFactory: () => { receiptFactories += 1; return { read: async () => ({}) }; },
      acmeManagerFactory: () => { acmeFactories += 1; return { inspectCertificate: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(domainFactories, 0);
  assert.equal(certificateFactories, 0);
  assert.equal(durableFactories, 0);
  assert.equal(receiptFactories, 0);
  assert.equal(acmeFactories, 0);
});
