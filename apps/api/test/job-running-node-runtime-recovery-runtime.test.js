import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningNodeRuntimeRecoveryFromStores } from '../src/job-running-node-runtime-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';

test('Node runtime recovery runtime binds the exact host, private job context and read-only inventory', async () => {
  const calls = [];
  const fakeRegistry = { durable: true };
  const recovered = await runRunningNodeRuntimeRecoveryFromStores({
    serverId,
    jobId,
    hostname: 'runtime-host',
    env: { YUNPANEL_SERVER_STORE: '/state/servers.json', YUNPANEL_JOB_STORE: '/state/jobs.json' },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname: 'runtime-host' }; },
    }),
    jobRegistryFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable', filePath]); return fakeRegistry; },
    recoveryStoreFactory: () => ({}),
    contextReaderFactory: ({ filePath }) => ({ async read(id) { calls.push(['context', filePath, id]); return { id }; } }),
    runtimeManagerFactory: () => ({ async inspect() { calls.push(['runtime.inspect']); return { managedRuntimes: [] }; } }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId });
      assert.deepEqual(await input.inspectNodeRuntimes(), { managedRuntimes: [] });
      return { serverId, jobId, operation: 'system.node-runtime.install', status: 'succeeded', recoveryMethod: 'verified_managed_node_runtime' };
    },
  });
  assert.equal(recovered.recoveryMethod, 'verified_managed_node_runtime');
  assert.deepEqual(calls, [
    ['server.init', '/state/servers.json'], ['server.get', serverId], ['durable', '/state/jobs.json'],
    ['context', '/state/jobs.json', jobId], ['runtime.inspect'],
  ]);
});
