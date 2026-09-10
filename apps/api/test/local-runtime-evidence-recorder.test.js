import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalRuntimeError, startLocalRuntime } from '../src/local-runtime.js';

const serverId = 'server-1';
const hostname = 'host-1.example.local';
const boundServer = {
  id: serverId,
  hostname,
  executionMode: 'local',
  localBoundAt: '2026-09-10T00:00:00.000Z',
};

function baseOptions(overrides = {}) {
  let executorOptions = null;
  return {
    options: {
      serverId,
      hostname,
      runtimeVersion: '0.3.0',
      lockPath: '/var/lib/yunpanel/control-plane/local-executor.lock',
      registry: {
        async getServer() { return { ...boundServer }; },
        async updateLocalSnapshot() { return { ...boundServer }; },
      },
      jobRegistry: { listJobs: async () => [], claimNext: async () => null, complete: async () => null },
      domainRegistry: {},
      certificateRegistry: {},
      applicationRegistry: {},
      hostOperations: {
        operations: [],
        supports: () => false,
        executeOperation: async () => ({}),
      },
      executorFactory: (input) => {
        executorOptions = input;
        return { start() {}, async stop() {} };
      },
      acquireLock: async () => ({ async release() {} }),
      reconcile: async () => ({ reconciled: true }),
      ...overrides,
    },
    getExecutorOptions: () => executorOptions,
  };
}

test('local runtime passes the exact evidence recorder to its executor', async () => {
  const recorder = async () => {};
  const fx = baseOptions({ recordExecutionEvidence: recorder });
  const runtime = await startLocalRuntime(fx.options);
  assert.equal(fx.getExecutorOptions().recordExecutionEvidence, recorder);
  await runtime.stop();
});

test('invalid local runtime evidence recorder fails before lock acquisition', async () => {
  let lockCalls = 0;
  const fx = baseOptions({
    recordExecutionEvidence: {},
    acquireLock: async () => { lockCalls += 1; return { async release() {} }; },
  });
  await assert.rejects(
    startLocalRuntime(fx.options),
    (error) => error instanceof LocalRuntimeError && error.code === 'local_runtime_evidence_recorder_invalid',
  );
  assert.equal(lockCalls, 0);
});
