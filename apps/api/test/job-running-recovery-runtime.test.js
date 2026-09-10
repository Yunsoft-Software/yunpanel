import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningInspectionRecoveryFromStores } from '../src/job-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('running inspection recovery runtime opens only server/job state and local host operations', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable-job-registry' };
  const result = await runRunningInspectionRecoveryFromStores({
    serverId,
    jobId,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname: 'host-1' }; },
    }),
    jobRegistryFactory: () => ({ marker: 'raw-job-registry' }),
    recoveryStoreFactory: () => ({ marker: 'recovery-store' }),
    durableRegistryFactory: (options) => {
      calls.push(['durable.create', options.filePath]);
      return fakeJobRegistry;
    },
    hostOperationsFactory: () => ({
      executeOperation: async (operation, payload) => {
        calls.push(['host.execute', operation, payload]);
        return { safe: true };
      },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.equal(input.serverId, serverId);
      assert.equal(input.jobId, jobId);
      assert.deepEqual(await input.executeOperation('system.packages.inspect', {}), { safe: true });
      return {
        serverId,
        jobId,
        operation: 'system.packages.inspect',
        status: 'succeeded',
        recoveryMethod: 'safe_read_only_reexecution',
      };
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.statePaths.serverStore, '/work/state/servers.json');
  assert.equal(result.statePaths.jobStore, '/work/state/jobs.json');
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['host.execute', 'system.packages.inspect', {}],
  ]);
});

test('running inspection recovery refuses an unknown server before constructing host operations', async () => {
  let hostFactories = 0;
  await assert.rejects(
    runRunningInspectionRecoveryFromStores({
      serverId,
      jobId,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return null; } }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      hostOperationsFactory: () => { hostFactories += 1; return { executeOperation: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_not_found' },
  );
  assert.equal(hostFactories, 0);
});
