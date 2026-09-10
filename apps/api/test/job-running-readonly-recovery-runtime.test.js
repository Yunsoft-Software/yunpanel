import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningReadOnlyRecoveryFromStores } from '../src/job-running-readonly-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'host-1';

test('read-only recovery runtime binds exact host, private context and local inspection adapter', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const result = await runRunningReadOnlyRecoveryFromStores({
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
      async read(id) { calls.push(['context.read', filePath, id]); return { id, payload: { serviceId: 'nginx' } }; },
    }),
    hostOperationsFactory: () => ({
      async executeOperation(operation, payload) {
        calls.push(['host.execute', operation, payload]);
        return { safe: true };
      },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId, payload: { serviceId: 'nginx' } });
      assert.deepEqual(await input.executeOperation('system.services.inspect', { serviceId: 'nginx' }), { safe: true });
      return { serverId, jobId, operation: 'system.services.inspect', status: 'succeeded', recoveryMethod: 'safe_read_only_reexecution' };
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['context.read', '/work/state/jobs.json', jobId],
    ['host.execute', 'system.services.inspect', { serviceId: 'nginx' }],
  ]);
});

test('wrong host blocks private read-only recovery before context and host operations open', async () => {
  let durableFactories = 0;
  let contextFactories = 0;
  let hostFactories = 0;
  await assert.rejects(
    runRunningReadOnlyRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => { durableFactories += 1; return {}; },
      contextReaderFactory: () => { contextFactories += 1; return { read: async () => ({}) }; },
      hostOperationsFactory: () => { hostFactories += 1; return { executeOperation: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(durableFactories, 0);
  assert.equal(contextFactories, 0);
  assert.equal(hostFactories, 0);
});
