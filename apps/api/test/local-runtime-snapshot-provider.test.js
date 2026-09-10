import assert from 'node:assert/strict';
import test from 'node:test';
import { startLocalRuntime, LocalRuntimeError } from '../src/local-runtime.js';

const serverId = 'server-1';
const hostname = 'host-1.example.local';
const boundServer = {
  id: serverId,
  hostname,
  executionMode: 'local',
  localBoundAt: '2026-09-10T09:00:00.000Z',
};

function fixture() {
  const snapshots = [];
  let starts = 0;
  let stops = 0;
  let releases = 0;
  return {
    snapshots,
    counts: () => ({ starts, stops, releases }),
    registry: {
      async getServer() { return { ...boundServer }; },
      async updateLocalSnapshot(input) {
        snapshots.push(structuredClone(input));
        return { ...boundServer, ...input };
      },
    },
    jobRegistry: {
      async listJobs() { return []; },
      async claimNext() { return null; },
      async complete() { return null; },
    },
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: {},
    hostOperations: { operations: [], supports: () => false, executeOperation: async () => null },
    executorFactory: () => ({
      start() { starts += 1; },
      async stop() { stops += 1; },
    }),
    acquireLock: async () => ({ async release() { releases += 1; } }),
  };
}

async function start(fx, extra = {}) {
  return startLocalRuntime({
    serverId,
    hostname,
    runtimeVersion: '0.3.0',
    lockPath: '/var/lib/yunpanel/control-plane/local-executor.lock',
    registry: fx.registry,
    jobRegistry: fx.jobRegistry,
    domainRegistry: fx.domainRegistry,
    certificateRegistry: fx.certificateRegistry,
    applicationRegistry: fx.applicationRegistry,
    hostOperations: fx.hostOperations,
    executorFactory: fx.executorFactory,
    acquireLock: fx.acquireLock,
    snapshotIntervalMs: 60_000,
    ...extra,
  });
}

test('snapshot provider data is written with the local heartbeat snapshot before executor start', async () => {
  const fx = fixture();
  const inventory = { hostname, operatingSystem: { prettyName: 'Ubuntu 24.04' } };
  const runtime = await start(fx, { snapshotProvider: async () => ({ inventory }) });
  assert.equal(fx.snapshots.length, 1);
  assert.deepEqual(fx.snapshots[0], {
    serverId,
    hostname,
    runtimeVersion: '0.3.0',
    inventory,
  });
  assert.equal(fx.counts().starts, 1);
  await runtime.stop();
});

test('snapshot provider rejects unsupported fields before host execution starts', async () => {
  const fx = fixture();
  await assert.rejects(
    start(fx, { snapshotProvider: async () => ({ inventory: { hostname }, secret: 'must-not-persist' }) }),
    (error) => error instanceof LocalRuntimeError && error.code === 'local_runtime_snapshot_invalid',
  );
  assert.equal(fx.snapshots.length, 0);
  assert.equal(fx.counts().starts, 0);
  assert.equal(fx.counts().stops, 1);
  assert.equal(fx.counts().releases, 1);
});

test('snapshot provider configuration is validated before acquiring ownership', async () => {
  const fx = fixture();
  await assert.rejects(
    start(fx, { snapshotProvider: {} }),
    (error) => error instanceof LocalRuntimeError && error.code === 'local_runtime_snapshot_provider_invalid',
  );
  assert.equal(fx.counts().releases, 0);
});
