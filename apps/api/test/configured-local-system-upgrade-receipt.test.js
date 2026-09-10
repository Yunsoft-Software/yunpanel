import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { startConfiguredLocalRuntime } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';

async function recorderFixture() {
  const writes = [];
  let startOptions;
  await startConfiguredLocalRuntime({
    env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
    hostname: 'host-1.example.local',
    jobStorePath: '/var/lib/yunpanel/control-plane/job-registry.json',
    runtimeVersion: '0.3.0',
    registry: {}, jobRegistry: {}, domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {},
    applicationEnvironmentRegistry: { materialize: async () => ({}) },
    createOperations: () => ({ operations: [], supports: () => true, executeOperation: async () => ({}) }),
    createDatabaseDeletionReceipts: () => ({ write: async () => {} }),
    createDomainActivationReceipts: () => ({ write: async () => {} }),
    createManagedServiceReceipts: () => ({ write: async () => {} }),
    createNodeDeploymentReceipts: () => ({ write: async () => {} }),
    createNodeRestartReceipts: () => ({ write: async () => {} }),
    createNodeRollbackReceipts: () => ({ write: async () => {} }),
    createSystemUpgradeReceipts: () => ({ async write(value) { writes.push(value); } }),
    inspectInventory: async () => ({ hostname: 'host-1.example.local' }),
    startRuntime: async (options) => { startOptions = options; return { stop: async () => {} }; },
  });
  return { writes, recorder: startOptions.recordExecutionEvidence };
}

function upgradedResult(extra = {}) {
  return {
    packageName: 'yunpanel',
    installed: true,
    installedVersion: '0.4.0',
    candidateVersion: '0.4.0',
    updateAvailable: false,
    previousVersion: '0.3.0',
    upgraded: true,
    restartScheduled: true,
    ...extra,
  };
}

function noOpResult() {
  return {
    packageName: 'yunpanel',
    installed: true,
    installedVersion: '0.4.0',
    candidateVersion: '0.4.0',
    updateAvailable: false,
    previousVersion: '0.4.0',
    upgraded: false,
    restartScheduled: false,
  };
}

test('configured runtime records successful changed and no-op system upgrades only', async () => {
  const fx = await recorderFixture();
  const changed = upgradedResult();
  const noOp = noOpResult();
  await fx.recorder({ serverId, jobId, operation: OPERATIONS.SYSTEM_UPGRADE, payload: {}, result: changed });
  await fx.recorder({ serverId, jobId: '8f217caa-0f0f-4569-a657-30a97bcb7ca1', operation: OPERATIONS.SYSTEM_UPGRADE, payload: {}, result: noOp });
  await fx.recorder({
    serverId,
    jobId: '9f217caa-0f0f-4569-a657-30a97bcb7ca2',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    result: { packageName: 'yunpanel', installed: true, installedVersion: '0.4.0', candidateVersion: '0.4.0', updateAvailable: false },
  });

  assert.deepEqual(fx.writes, [
    { serverId, jobId, result: changed },
    { serverId, jobId: '8f217caa-0f0f-4569-a657-30a97bcb7ca1', result: noOp },
  ]);
});

test('invalid system upgrade result never reaches receipt store', async () => {
  const fx = await recorderFixture();
  await assert.rejects(
    fx.recorder({
      serverId,
      jobId,
      operation: OPERATIONS.SYSTEM_UPGRADE,
      payload: {},
      result: upgradedResult({ installed: false }),
    }),
    /not safe recovery evidence/,
  );
  assert.deepEqual(fx.writes, []);
});
