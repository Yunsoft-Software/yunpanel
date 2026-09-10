import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { startConfiguredLocalRuntime } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

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
    createDatabaseDeletionReceipts: () => ({
      async write(value) { writes.push(value); },
    }),
    inspectInventory: async () => ({ hostname: 'host-1.example.local' }),
    startRuntime: async (options) => { startOptions = options; return { stop: async () => {} }; },
  });
  return { writes, recorder: startOptions.recordExecutionEvidence };
}

test('configured runtime records only successful database delete evidence', async () => {
  const { writes, recorder } = await captureRecorder();
  const result = {
    engine: 'mariadb',
    version: '11.4.5-MariaDB',
    database: { name: 'app_db', sizeBytes: 4096 },
    deleted: true,
  };

  await recorder({
    serverId,
    jobId: '12345678-1234-4234-8234-123456789012',
    operation: OPERATIONS.DATABASE_DELETE,
    payload: { name: 'app_db' },
    result,
  });
  await recorder({
    serverId,
    jobId: '22345678-1234-4234-8234-123456789012',
    operation: OPERATIONS.DATABASE_CREATE,
    payload: { name: 'other_db' },
    result: { created: true },
  });

  assert.deepEqual(writes, [{
    serverId,
    jobId: '12345678-1234-4234-8234-123456789012',
    databaseName: 'app_db',
    result,
  }]);
});

test('configured runtime rejects an invalid database deletion receipt store', async () => {
  await assert.rejects(
    startConfiguredLocalRuntime({
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
      createDatabaseDeletionReceipts: () => ({}),
    }),
    { code: 'local_database_deletion_receipts_invalid' },
  );
});
