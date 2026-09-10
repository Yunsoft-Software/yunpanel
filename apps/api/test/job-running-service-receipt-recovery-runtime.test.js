import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningServiceReceiptRecoveryFromStores } from '../src/job-running-service-receipt-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'host-1';

test('receipt-backed service runtime exposes only private receipt and read-only host evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const result = await runRunningServiceReceiptRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname }; },
    }),
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => {
      calls.push(['context.create', filePath]);
      return { async read(id) { calls.push(['context.read', id]); return { id, payload: { serviceId: 'nginx' } }; } };
    },
    receiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) {
        calls.push(['receipt.read', receiptServerId, receiptJobId]);
        return { serverId: receiptServerId, jobId: receiptJobId, serviceId: 'nginx' };
      },
    }),
    managedServiceManagerFactory: () => ({
      async inspect(serviceId) {
        calls.push(['service.inspect', serviceId]);
        return { id: serviceId, installed: true, active: true };
      },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId, payload: { serviceId: 'nginx' } });
      assert.equal((await input.readMutationReceipt(serverId, jobId)).jobId, jobId);
      assert.deepEqual(await input.inspectServiceState('nginx'), { id: 'nginx', installed: true, active: true });
      return {
        serverId,
        jobId,
        operation: 'system.service.install',
        serviceId: 'nginx',
        action: null,
        status: 'succeeded',
        recoveryMethod: 'verified_managed_service_receipt_and_state',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['context.create', '/work/state/jobs.json'],
    ['context.read', jobId],
    ['receipt.read', serverId, jobId],
    ['service.inspect', 'nginx'],
  ]);
});

test('receipt-backed service runtime refuses wrong host before recovery stores or inspectors open', async () => {
  let durableFactories = 0;
  let contextFactories = 0;
  let receiptFactories = 0;
  let managerFactories = 0;
  await assert.rejects(
    runRunningServiceReceiptRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => { durableFactories += 1; return {}; },
      contextReaderFactory: () => { contextFactories += 1; return { read: async () => ({}) }; },
      receiptStoreFactory: () => { receiptFactories += 1; return { read: async () => ({}) }; },
      managedServiceManagerFactory: () => { managerFactories += 1; return { inspect: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(durableFactories, 0);
  assert.equal(contextFactories, 0);
  assert.equal(receiptFactories, 0);
  assert.equal(managerFactories, 0);
});
