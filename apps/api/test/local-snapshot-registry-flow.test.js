import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startLocalRuntime } from '../src/local-runtime.js';
import { createServerRegistry } from '../src/server-registry.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-local-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'servers.json');
}

test('agentless runtime persists inventory, services, Docker and Nginx snapshots into the server registry', async (t) => {
  const filePath = await fixture(t);
  const registry = createServerRegistry({ filePath, now: () => Date.parse('2026-09-10T10:00:00.000Z') });
  await registry.init();
  const local = await registry.createLocalServer({ hostname: 'host-1.example.local' });

  const inventory = {
    hostname: 'host-1.example.local',
    operatingSystem: { prettyName: 'Ubuntu 24.04' },
    docker: { available: true, containers: [] },
    nginx: { available: true, version: 'nginx/1.24.0' },
  };
  const services = {
    systemdAvailable: true,
    services: [{ unit: 'nginx.service', activeState: 'active' }],
  };

  const runtime = await startLocalRuntime({
    serverId: local.id,
    hostname: 'host-1.example.local',
    runtimeVersion: '0.3.0',
    lockPath: '/var/lib/yunpanel/control-plane/local-executor.lock',
    registry,
    jobRegistry: {
      async listJobs() { return []; },
      async claimNext() { return null; },
      async complete() { return null; },
    },
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: {},
    hostOperations: { operations: [], supports: () => false, executeOperation: async () => null },
    snapshotProvider: async () => ({ inventory, services }),
    executorFactory: () => ({ start() {}, async stop() {} }),
    acquireLock: async () => ({ async release() {} }),
    snapshotIntervalMs: 60_000,
  });

  const server = await registry.getServer(local.id);
  assert.equal(server.executionMode, 'local');
  assert.equal(server.connectivity, 'online');
  assert.equal(server.localRuntimeVersion, '0.3.0');
  assert.deepEqual(server.inventory, inventory);
  assert.deepEqual(server.services, services);

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  const stored = persisted.servers.find((entry) => entry.id === local.id);
  assert.deepEqual(stored.inventory, inventory);
  assert.deepEqual(stored.services, services);
  assert.equal(stored.agentTokenHash, null);

  await runtime.stop();
});
