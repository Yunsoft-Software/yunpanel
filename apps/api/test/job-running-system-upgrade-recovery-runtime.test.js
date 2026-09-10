import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningSystemUpgradeRecoveryFromStores } from '../src/job-running-system-upgrade-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const hostname = 'host-1';

test('system upgrade recovery runtime exposes private receipt and read-only package state only', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const result = await runRunningSystemUpgradeRecoveryFromStores({
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
    contextReaderFactory: ({ filePath }) => ({
      async read(id) { calls.push(['context.read', filePath, id]); return { id, payload: {} }; },
    }),
    receiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) {
        calls.push(['receipt.read', receiptServerId, receiptJobId]);
        return { serverId: receiptServerId, jobId: receiptJobId, packageName: 'yunpanel' };
      },
    }),
    packageManagerFactory: () => ({
      async inspect() {
        calls.push(['package.inspect']);
        return { packageName: 'yunpanel', installed: true, installedVersion: '0.4.0', candidateVersion: '0.4.0', updateAvailable: false };
      },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId, payload: {} });
      assert.equal((await input.readUpgradeReceipt(serverId, jobId)).jobId, jobId);
      assert.equal((await input.inspectPackageState()).installedVersion, '0.4.0');
      return {
        serverId,
        jobId,
        operation: 'system.upgrade',
        status: 'succeeded',
        upgraded: true,
        recoveryMethod: 'verified_system_upgrade_receipt_and_package_state',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['context.read', '/work/state/jobs.json', jobId],
    ['receipt.read', serverId, jobId],
    ['package.inspect'],
  ]);
});

test('wrong host blocks system upgrade recovery before recovery evidence providers open', async () => {
  let durableFactories = 0;
  let contextFactories = 0;
  let receiptFactories = 0;
  let packageFactories = 0;
  await assert.rejects(
    runRunningSystemUpgradeRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => { durableFactories += 1; return {}; },
      contextReaderFactory: () => { contextFactories += 1; return { read: async () => ({}) }; },
      receiptStoreFactory: () => { receiptFactories += 1; return { read: async () => ({}) }; },
      packageManagerFactory: () => { packageFactories += 1; return { inspect: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(durableFactories, 0);
  assert.equal(contextFactories, 0);
  assert.equal(receiptFactories, 0);
  assert.equal(packageFactories, 0);
});
