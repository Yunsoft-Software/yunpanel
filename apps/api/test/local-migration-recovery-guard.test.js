import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindLocalServerForRuntime,
  createLocalServerForRuntime,
  inspectLocalServerMigration,
  LocalServerMigrationError,
  releaseLocalServerFromRuntime,
} from '../src/local-server-migration.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const hostname = 'host-1.example.local';
const stopped = async () => ({ apiActive: false, agentActive: false });
const recovery = {
  code: 'durable_job_reconciliation_required',
  jobs: [{ jobId: '12345678-1234-4234-8234-123456789012', serverId }],
};

function jobRegistry(value = recovery) {
  return {
    async listJobs() { return []; },
    recovery() { return value; },
  };
}

function existingRegistry(mode = 'agent') {
  let mutations = 0;
  return {
    mutations: () => mutations,
    async getServer() {
      return { id: serverId, hostname, executionMode: mode, localBoundAt: mode === 'local' ? '2026-09-10T09:00:00.000Z' : null };
    },
    async bindLocalServer() { mutations += 1; return {}; },
    async releaseLocalServer() { mutations += 1; return {}; },
  };
}

test('status reports durable recovery without mutating ownership', async () => {
  const registry = existingRegistry();
  const status = await inspectLocalServerMigration({ serverId, hostname, registry, jobRegistry: jobRegistry(), serviceStatus: stopped });
  assert.equal(status.activeJobCount, 0);
  assert.equal(status.recoveryJobCount, 1);
  assert.equal(registry.mutations(), 0);
});

test('bind and release reject matching durable recovery before registry mutation', async () => {
  for (const [operation, mode] of [
    [bindLocalServerForRuntime, 'agent'],
    [releaseLocalServerFromRuntime, 'local'],
  ]) {
    const registry = existingRegistry(mode);
    await assert.rejects(
      operation({ serverId, hostname, registry, jobRegistry: jobRegistry(), serviceStatus: stopped }),
      (error) => error instanceof LocalServerMigrationError && error.code === 'local_migration_recovery_pending',
    );
    assert.equal(registry.mutations(), 0);
  }
});

test('fresh local create rejects any durable recovery identity before creating a server', async () => {
  let creates = 0;
  const registry = {
    async createLocalServer() { creates += 1; return {}; },
  };
  await assert.rejects(
    createLocalServerForRuntime({ hostname, registry, jobRegistry: jobRegistry(), serviceStatus: stopped }),
    (error) => error instanceof LocalServerMigrationError && error.code === 'local_migration_recovery_pending',
  );
  assert.equal(creates, 0);
});

test('recovery for a different server does not block existing-host status or bind', async () => {
  const registry = existingRegistry();
  const otherRecovery = {
    code: 'durable_job_reconciliation_required',
    jobs: [{ jobId: '87654321-1234-4234-8234-123456789012', serverId: 'other-server' }],
  };
  const status = await inspectLocalServerMigration({ serverId, hostname, registry, jobRegistry: jobRegistry(otherRecovery), serviceStatus: stopped });
  assert.equal(status.recoveryJobCount, 0);
});

test('malformed recovery inspection fails closed', async () => {
  const registry = existingRegistry();
  await assert.rejects(
    inspectLocalServerMigration({ serverId, hostname, registry, jobRegistry: jobRegistry({ jobs: 'invalid' }), serviceStatus: stopped }),
    (error) => error instanceof LocalServerMigrationError && error.code === 'local_migration_recovery_invalid',
  );
});
