import assert from 'node:assert/strict';
import test from 'node:test';
import { startConfiguredLocalRuntime } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

test('configured local runtime enriches inventory with the legacy-compatible Docker snapshot', async () => {
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
    inspectInventory: async () => ({ hostname: 'host-1.example.local', mode: 'local' }),
    inspectDocker: async () => ({ available: true, containers: [{ id: 'abc', name: 'demo' }] }),
    startRuntime: async (options) => {
      startOptions = options;
      return { stop: async () => {} };
    },
  });

  assert.deepEqual(await startOptions.snapshotProvider(), {
    inventory: {
      hostname: 'host-1.example.local',
      mode: 'local',
      docker: { available: true, containers: [{ id: 'abc', name: 'demo' }] },
    },
  });
});
