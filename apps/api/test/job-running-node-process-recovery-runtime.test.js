import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningNodeProcessRecoveryFromStores } from '../src/job-running-node-process-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const hostname = 'host-1';

test('Node process runtime binds exact host, Application state, private context and read-only process inspector', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const fakeApplicationRegistry = { async init() { calls.push(['application.init']); } };
  const result = await runRunningNodeProcessRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
      YUNPANEL_APPLICATION_STORE: '/work/state/applications.json',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname }; },
    }),
    applicationRegistryFactory: ({ filePath }) => { calls.push(['application.create', filePath]); return fakeApplicationRegistry; },
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => ({
      async read(id) { calls.push(['context.read', filePath, id]); return { id }; },
    }),
    processManagerFactory: () => ({
      async inspectNodeProcess(intent) { calls.push(['process.inspect', intent]); return { action: intent.action }; },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.equal(input.applicationRegistry, fakeApplicationRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId });
      assert.deepEqual(await input.inspectNodeProcess({ action: 'stop' }), { action: 'stop' });
      return { serverId, jobId, operation: 'app.node.process', status: 'succeeded', recoveryMethod: 'verified_node_process_state', reconciled: true };
    },
  });

  assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['application.create', '/work/state/applications.json'],
    ['application.init'],
    ['context.read', '/work/state/jobs.json', jobId],
    ['process.inspect', { action: 'stop' }],
  ]);
});

test('wrong host stops Node process recovery before Application or inspector construction', async () => {
  let applicationFactories = 0;
  let processFactories = 0;
  await assert.rejects(
    runRunningNodeProcessRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      applicationRegistryFactory: () => { applicationFactories += 1; return { async init() {} }; },
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => ({ read: async () => ({}) }),
      processManagerFactory: () => { processFactories += 1; return { inspectNodeProcess: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(applicationFactories, 0);
  assert.equal(processFactories, 0);
});
