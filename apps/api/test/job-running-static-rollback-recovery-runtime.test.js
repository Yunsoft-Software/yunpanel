import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningStaticRollbackRecoveryFromStores } from '../src/job-running-static-rollback-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const hostname = 'host-1';

test('static rollback runtime binds exact host, application state, private context and read-only evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const fakeApplicationRegistry = { async init() { calls.push(['application.init']); } };
  const result = await runRunningStaticRollbackRecoveryFromStores({
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
    evidenceInspectorFactory: () => ({
      async inspect(intent) { calls.push(['evidence.inspect', intent]); return { satisfied: true, result: {} }; },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.equal(input.applicationRegistry, fakeApplicationRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId });
      assert.deepEqual(await input.inspectRollbackEvidence({ applicationId: 'app' }), { satisfied: true, result: {} });
      return { serverId, jobId, operation: 'app.static.rollback', status: 'succeeded', recoveryMethod: 'verified_static_rollback_symlink', reconciled: true };
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
    ['evidence.inspect', { applicationId: 'app' }],
  ]);
});

test('wrong host stops static rollback recovery before application or evidence construction', async () => {
  let applicationFactories = 0;
  let evidenceFactories = 0;
  await assert.rejects(
    runRunningStaticRollbackRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      applicationRegistryFactory: () => { applicationFactories += 1; return { async init() {} }; },
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => ({ read: async () => ({}) }),
      evidenceInspectorFactory: () => { evidenceFactories += 1; return { inspect: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(applicationFactories, 0);
  assert.equal(evidenceFactories, 0);
});
