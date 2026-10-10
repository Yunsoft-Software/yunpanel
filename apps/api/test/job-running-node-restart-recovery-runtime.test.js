import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningNodeRestartRecoveryFromStores } from '../src/job-running-node-restart-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const hostname = 'host-1';

test('Node restart runtime binds exact host, application state, private receipt and read-only status', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const fakeApplicationRegistry = { async init() { calls.push(['application.init']); } };
  const result = await runRunningNodeRestartRecoveryFromStores({
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
    receiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) {
        calls.push(['receipt.read', receiptServerId, receiptJobId]);
        return { serverId: receiptServerId, jobId: receiptJobId };
      },
    }),
    statusInspectorFactory: () => ({
      async inspectNodeStatus(intent) {
        calls.push(['status.inspect', intent]);
        return { releaseId: 'release-1', healthy: true };
      },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.equal(input.applicationRegistry, fakeApplicationRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId });
      assert.equal((await input.readRestartReceipt(serverId, jobId)).jobId, jobId);
      assert.deepEqual(await input.inspectNodeStatus({ applicationId: 'app' }), { releaseId: 'release-1', healthy: true });
      return {
        serverId,
        jobId,
        operation: 'app.node.restart',
        status: 'succeeded',
        recoveryMethod: 'verified_node_restart_receipt_and_status',
        reconciled: true,
      };
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
    ['receipt.read', serverId, jobId],
    ['status.inspect', { applicationId: 'app' }],
  ]);
});

test('wrong host stops Node restart recovery before application, receipt or status construction', async () => {
  let applicationFactories = 0;
  let receiptFactories = 0;
  let statusFactories = 0;
  await assert.rejects(
    runRunningNodeRestartRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      applicationRegistryFactory: () => { applicationFactories += 1; return { async init() {} }; },
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => ({ read: async () => ({}) }),
      receiptStoreFactory: () => { receiptFactories += 1; return { read: async () => ({}) }; },
      statusInspectorFactory: () => { statusFactories += 1; return { inspectNodeStatus: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(applicationFactories, 0);
  assert.equal(receiptFactories, 0);
  assert.equal(statusFactories, 0);
});

test('Passenger store runtime constructs scoped inspection lazily and passes only the explicit legacy job allowance', async () => {
  let constructed = 0, inspected = 0, written = 0;
  const applicationRegistry = { async init() {} };
  await runRunningNodeRestartRecoveryFromStores({ serverId, jobId, hostname, env: {}, cwd: '/work',
    serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname }; } }),
    applicationRegistryFactory: () => applicationRegistry, jobRegistryFactory: () => ({}), recoveryStoreFactory: () => ({}),
    durableRegistryFactory: () => ({}), contextReaderFactory: () => ({ read: async () => ({}) }),
    receiptStoreFactory: () => ({ read: async () => null, write: async input => { written++; assert.equal(input.jobId, jobId); } }),
    statusInspectorFactory: () => ({ inspectNodeStatus: async () => { throw new Error('unexpected systemd inspection'); } }),
    passengerInspectionFactory: async input => {
      constructed++; assert.equal(input.applicationRegistry, applicationRegistry);
      assert.equal(input.paths.applicationStore, '/work/.data/application-registry.json');
      return { inspectRecovery: async (payload, execution) => { inspected++; assert.equal(payload.applicationId, 'owned');
        assert.equal(execution.jobId, jobId); return { verified: true }; } };
    },
    allowAppliedStateRecoveryJobId: jobId, serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async input => {
      assert.equal(constructed, 0); assert.equal(input.allowAppliedStateRecoveryJobId, jobId);
      for (let i = 0; i < 2; i++) assert.deepEqual(await input.inspectPassengerState({ applicationId: 'owned' }, { jobId }), { verified: true });
      await input.writeRestartReceipt({ jobId }); return { status: 'succeeded' };
    },
  });
  assert.equal(constructed, 1); assert.equal(inspected, 2); assert.equal(written, 1);
});
