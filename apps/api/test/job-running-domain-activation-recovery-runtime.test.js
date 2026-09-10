import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningDomainActivationRecoveryFromStores } from '../src/job-running-domain-activation-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'host-1';

function resourceFactory(label, calls) {
  return ({ filePath }) => ({ async init() { calls.push([`${label}.init`, filePath]); } });
}

test('domain activation runtime wires exact host, resources, private receipt and active Nginx evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const result = await runRunningDomainActivationRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_DOMAIN_STORE: '/work/state/domains.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
      YUNPANEL_CERTIFICATE_STORE: '/work/state/certificates.json',
      YUNPANEL_APPLICATION_STORE: '/work/state/applications.json',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname }; },
    }),
    domainRegistryFactory: resourceFactory('domain', calls),
    certificateRegistryFactory: resourceFactory('certificate', calls),
    applicationRegistryFactory: resourceFactory('application', calls),
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => {
      calls.push(['context.create', filePath]);
      return { async read(id) { calls.push(['context.read', id]); return { id, payload: { primaryDomain: 'example.com' } }; } };
    },
    receiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) {
        calls.push(['receipt.read', receiptServerId, receiptJobId]);
        return { serverId: receiptServerId, jobId: receiptJobId };
      },
    }),
    nginxManagerFactory: () => ({
      async inspectActiveDomain(intent) { calls.push(['nginx.active', intent]); return { satisfied: true, result: {} }; },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.equal((await input.readActivationReceipt(serverId, jobId)).jobId, jobId);
      assert.deepEqual(await input.inspectActiveEvidence({ primaryDomain: 'example.com' }), { satisfied: true, result: {} });
      return { serverId, jobId, operation: 'domain.activate', status: 'succeeded', recoveryMethod: 'verified_domain_activation_receipt_and_active_config', reconciled: true };
    },
  });

  assert.equal(result.reconciled, true);
  assert.ok(calls.some(([name]) => name === 'domain.init'));
  assert.ok(calls.some(([name]) => name === 'receipt.read'));
  assert.ok(calls.some(([name]) => name === 'nginx.active'));
});

test('domain activation runtime rejects wrong host before resource or receipt construction', async () => {
  let resources = 0;
  let receipts = 0;
  let nginx = 0;
  await assert.rejects(
    runRunningDomainActivationRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      domainRegistryFactory: () => { resources += 1; return { async init() {} }; },
      certificateRegistryFactory: () => { resources += 1; return { async init() {} }; },
      applicationRegistryFactory: () => { resources += 1; return { async init() {} }; },
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => ({ read: async () => ({}) }),
      receiptStoreFactory: () => { receipts += 1; return { read: async () => ({}) }; },
      nginxManagerFactory: () => { nginx += 1; return { inspectActiveDomain: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(resources, 0);
  assert.equal(receipts, 0);
  assert.equal(nginx, 0);
});
