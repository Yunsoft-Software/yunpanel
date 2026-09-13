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
    applicationRegistry: { async getApplication() { return null; } },
    applicationEnvironmentRegistry: {
      async environmentStatus() {},
      async materialize() {},
    },
    dockerComposeProjectRegistry: { async getProject() { return null; } },
    dockerComposeObserver: { async inspect() { return { status: 'stopped' }; } },
    async loadDatabaseInventory() { return null; },
    mailDataOperationsService: { async previewBackup() { return null; } },
    async projectBackupLocked() { return true; },
    localBackupArtifactManager: { async archive() {} },
    async inspectDockerVolume() {},
    ...overrides,
  };
}

test('production backup runtime assembles child dispatch and local executors behind one orchestrator factory', () => {
  const runtime = createBackupProductionRuntime(fixture());

  assert.equal(typeof runtime.jobIdempotencyLookup.find, 'function');
  assert.equal(typeof runtime.childJobDispatcher.dispatchPrepared, 'function');
  assert.deepEqual(Object.keys(runtime.localExecutors).sort(), [
    'application_snapshot',
    'docker_storage_backup',
  ]);

  const orchestrator = runtime.createOrchestrator({ async preview() {} });
  assert.equal(typeof orchestrator.create, 'function');
  assert.equal(typeof orchestrator.advance, 'function');
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
