import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { startConfiguredLocalRuntime } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const jobId = '12345678-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);

async function captureRecorder() {
  const writes = [];
  let startOptions;
  await startConfiguredLocalRuntime({
    env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
    hostname: 'host-1.example.local',
    jobStorePath: '/var/lib/yunpanel/control-plane/job-registry.json',
    runtimeVersion: '0.3.0',
    registry: {},
    jobRegistry: {},
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: {},
    applicationEnvironmentRegistry: { materialize: async () => ({}) },
    createOperations: () => ({ operations: [], supports: () => true, executeOperation: async () => ({}) }),
    createDatabaseDeletionReceipts: () => ({ write: async () => {} }),
    createDomainActivationReceipts: () => ({ async write(value) { writes.push(value); } }),
    createManagedServiceReceipts: () => ({ write: async () => {} }),
    inspectInventory: async () => ({ hostname: 'host-1.example.local' }),
    startRuntime: async (options) => { startOptions = options; return { stop: async () => {} }; },
  });
  return { writes, recorder: startOptions.recordExecutionEvidence };
}

test('configured runtime records only successful domain activation identity and checksum', async () => {
  const { writes, recorder } = await captureRecorder();
  await recorder({
    serverId,
    jobId,
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example.com', checksum },
    result: { configName: 'yunpanel-example.com.conf', checksum, active: true },
  });
  await recorder({
    serverId,
    jobId: '22345678-1234-4234-8234-123456789012',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'example.com' },
    result: { configName: 'yunpanel-example.com.conf', checksum, bytes: 100 },
  });

  assert.deepEqual(writes, [{ serverId, jobId, primaryDomain: 'example.com', checksum }]);
});

test('configured runtime refuses mismatched domain activation evidence before receipt write', async () => {
  const { writes, recorder } = await captureRecorder();
  await assert.rejects(
    recorder({
      serverId,
      jobId,
      operation: OPERATIONS.DOMAIN_ACTIVATE,
      payload: { primaryDomain: 'example.com', checksum },
      result: { configName: 'yunpanel-example.com.conf', checksum: 'b'.repeat(64), active: true },
    }),
    /not safe recovery evidence/,
  );
  assert.deepEqual(writes, []);
});
