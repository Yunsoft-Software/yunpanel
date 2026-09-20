import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackupProductionRuntimeError,
  createBackupProductionRuntime,
} from '../src/backup-production-runtime.js';

function fixture(overrides = {}) {
  return {
    jobRegistry: {
      async enqueue() {},
      async listJobs() { return []; },
      async getJob() { return null; },
    },
    jobStorePath: '/tmp/yunpanel-job-registry.json',
    backupOperationRegistry: {
      async create() {},
      async start() {},
      async linkStep() {},
      async succeedStep() {},
      async failStep() {},
      async getOperation() {},
    },
    async loadDatabaseInventory() { return null; },
    mailDataOperationsService: { async previewBackup() { return null; } },
    async projectBackupLocked() { return true; },
    ...overrides,
  };
}

test('production backup runtime assembles child dispatch and omits retired custom tar executors', () => {
  const runtime = createBackupProductionRuntime(fixture());

  assert.equal(typeof runtime.jobIdempotencyLookup.find, 'function');
  assert.equal(typeof runtime.childJobDispatcher.dispatchPrepared, 'function');
  assert.deepEqual(Object.keys(runtime.localExecutors), []);

  const orchestrator = runtime.createOrchestrator({ async preview() {} });
  assert.equal(typeof orchestrator.create, 'function');
  assert.equal(typeof orchestrator.advance, 'function');
});

test('production backup runtime supports optional explicit local executors', () => {
  const custom = { custom_step: { async prepare() {}, async executePrepared() {} } };
  const runtime = createBackupProductionRuntime(fixture({ localExecutors: custom }));
  assert.deepEqual(Object.keys(runtime.localExecutors), ['custom_step']);
});

test('production backup runtime fails closed when durable production dependencies are missing', () => {
  assert.throws(
    () => createBackupProductionRuntime(fixture({ jobStorePath: null })),
    (error) => error instanceof BackupProductionRuntimeError
      && error.code === 'backup_production_runtime_dependencies_invalid'
      && error.status === 503,
  );

  const runtime = createBackupProductionRuntime(fixture());
  assert.throws(
    () => runtime.createOrchestrator(null),
    (error) => error instanceof BackupProductionRuntimeError
      && error.code === 'backup_production_runtime_dependencies_invalid',
  );
});
