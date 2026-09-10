import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { startConfiguredLocalRuntime } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
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
    createNodeDeploymentReceipts: () => ({ async write(value) { writes.push(value); } }),
    createNodeRestartReceipts: () => ({ write: async () => {} }),
    createNodeRollbackReceipts: () => ({ write: async () => {} }),
    inspectInventory: async () => ({ hostname: 'host-1.example.local' }),
    startRuntime: async (options) => { startOptions = options; return { stop: async () => {} }; },
  });
  return { writes, recorder: startOptions.recordExecutionEvidence };
}

test('configured runtime records only exact successful Node deployment result', async () => {
  const fx = await recorderFixture();
  const result = {
    deploymentId: jobId,
    releaseId: jobId,
    previousReleaseId: null,
    commitSha: 'a'.repeat(40),
    serviceName: 'yunpanel-node-0123456789abcdef.service',
    port: 3100,
    healthPath: '/health',
    healthy: true,
  };
  await fx.recorder({
    serverId,
    jobId,
    operation: OPERATIONS.APP_NODE_DEPLOY,
    payload: { applicationId, runtime: { port: 3100, healthPath: '/health' } },
    result,
  });
  assert.deepEqual(fx.writes, [{ serverId, jobId, applicationId, result }]);
});

test('mismatched Node deployment identity never reaches the receipt store', async () => {
  const fx = await recorderFixture();
  await assert.rejects(
    fx.recorder({
      serverId,
      jobId,
      operation: OPERATIONS.APP_NODE_DEPLOY,
      payload: { applicationId, runtime: { port: 3100, healthPath: '/health' } },
      result: {
        deploymentId: jobId,
        releaseId: '216e4db8-468b-4e2f-a021-3ab31e0f4123',
        previousReleaseId: null,
        commitSha: 'a'.repeat(40),
        serviceName: 'yunpanel-node-0123456789abcdef.service',
        port: 3100,
        healthPath: '/health',
        healthy: true,
      },
    }),
    /not safe recovery evidence/,
  );
  assert.deepEqual(fx.writes, []);
});
