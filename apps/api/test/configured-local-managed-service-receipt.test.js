import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { startConfiguredLocalRuntime } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

function activeServiceState(extra = {}) {
  return {
    id: 'nginx',
    installed: true,
    active: true,
    packages: [{ packageName: 'nginx', installed: true, version: '1.24.0-1' }],
    units: [{
      unit: 'nginx.service',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      unitFileState: 'enabled',
      inspectionError: false,
    }],
    ...extra,
  };
}

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
    createDomainActivationReceipts: () => ({ write: async () => {} }),
    createManagedServiceReceipts: () => ({
      async write(value) { writes.push(value); },
    }),
    inspectInventory: async () => ({ hostname: 'host-1.example.local' }),
    startRuntime: async (options) => { startOptions = options; return { stop: async () => {} }; },
  });
  return { writes, recorder: startOptions.recordExecutionEvidence };
}

test('configured runtime records install and restart receipts with exact safe state input only', async () => {
  const { writes, recorder } = await captureRecorder();
  const installResult = activeServiceState({ changed: true });
  const restartResult = activeServiceState({ action: 'restart' });

  await recorder({
    serverId,
    jobId: '12345678-1234-4234-8234-123456789012',
    operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
    payload: { serviceId: 'nginx' },
    result: installResult,
  });
  await recorder({
    serverId,
    jobId: '22345678-1234-4234-8234-123456789012',
    operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    payload: { serviceId: 'nginx', action: 'restart' },
    result: restartResult,
  });
  await recorder({
    serverId,
    jobId: '32345678-1234-4234-8234-123456789012',
    operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    payload: { serviceId: 'nginx', action: 'start' },
    result: activeServiceState({ action: 'start' }),
  });

  assert.deepEqual(writes, [
    {
      serverId,
      jobId: '12345678-1234-4234-8234-123456789012',
      operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
      serviceId: 'nginx',
      changed: true,
      state: installResult,
    },
    {
      serverId,
      jobId: '22345678-1234-4234-8234-123456789012',
      operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
      serviceId: 'nginx',
      action: 'restart',
      state: restartResult,
    },
  ]);
});

test('configured runtime records package-only Roundcube install evidence without requiring a systemd unit', async () => {
  const { writes, recorder } = await captureRecorder();
  const result = {
    id: 'roundcube',
    installed: true,
    active: false,
    packages: [{ packageName: 'roundcube-core', installed: true, version: '1.6.6+dfsg-2ubuntu0.1' }],
    units: [],
    health: { status: 'installed', configuration: 'valid' },
    changed: true,
  };
  await recorder({
    serverId,
    jobId: '42345678-1234-4234-8234-123456789012',
    operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
    payload: { serviceId: 'roundcube' },
    result,
  });
  assert.deepEqual(writes, [{
    serverId,
    jobId: '42345678-1234-4234-8234-123456789012',
    operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
    serviceId: 'roundcube',
    changed: true,
    state: result,
  }]);
});

test('configured runtime refuses to record mismatched service evidence', async () => {
  const { writes, recorder } = await captureRecorder();
  await assert.rejects(
    recorder({
      serverId,
      jobId: '12345678-1234-4234-8234-123456789012',
      operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
      payload: { serviceId: 'nginx', action: 'restart' },
      result: { ...activeServiceState({ action: 'restart' }), id: 'docker' },
    }),
    /not safe recovery evidence/,
  );
  assert.deepEqual(writes, []);
});

test('configured runtime rejects an invalid managed service receipt store', async () => {
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
      createDatabaseDeletionReceipts: () => ({ write: async () => {} }),
      createDomainActivationReceipts: () => ({ write: async () => {} }),
      createManagedServiceReceipts: () => ({}),
    }),
    { code: 'local_managed_service_receipts_invalid' },
  );
});
