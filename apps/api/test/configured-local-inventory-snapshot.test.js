import assert from 'node:assert/strict';
import test from 'node:test';
import { startConfiguredLocalRuntime } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

test('configured local runtime supplies host inventory through the guarded snapshot provider', async () => {
  const calls = [];
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
    createOperations: () => ({ operations: [], supports: () => false, executeOperation: async () => null }),
    inspectInventory: async (options) => {
      calls.push(options);
      return { hostname: 'host-1.example.local', mode: 'local', memory: { totalBytes: 1024 } };
    },
    startRuntime: async (options) => {
      startOptions = options;
      return { stop: async () => {} };
    },
  });

  assert.equal(typeof startOptions.snapshotProvider, 'function');
  assert.deepEqual(await startOptions.snapshotProvider(), {
    inventory: { hostname: 'host-1.example.local', mode: 'local', memory: { totalBytes: 1024 } },
  });
  assert.deepEqual(calls, [{ mode: 'local' }]);
});
