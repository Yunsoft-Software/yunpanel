import { createBackupChildJobDispatcher } from './backup-child-job-dispatcher.js';
import { createBackupExecutionOrchestrator } from './backup-execution-orchestrator.js';
import { createJobIdempotencyLookup } from './job-idempotency-lookup.js';

export class BackupProductionRuntimeError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'BackupProductionRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function invalid() {
  throw new BackupProductionRuntimeError(
    'backup_production_runtime_dependencies_invalid',
    'Backup production runtime dependencies are unavailable',
  );
}

export function createBackupProductionRuntime({
  jobRegistry,
  jobStorePath,
  backupOperationRegistry,
  applicationRegistry: _applicationRegistry,
  applicationEnvironmentRegistry: _applicationEnvironmentRegistry,
  dockerComposeProjectRegistry: _dockerComposeProjectRegistry,
  dockerComposeObserver: _dockerComposeObserver,
  loadDatabaseInventory,
  mailDataOperationsService,
  projectBackupLocked,
  localExecutors = {},
} = {}) {
  if (!jobRegistry
    || typeof jobRegistry.enqueue !== 'function'
    || typeof jobRegistry.listJobs !== 'function'
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobStorePath !== 'string' || jobStorePath.length < 1
    || !backupOperationRegistry
    || typeof backupOperationRegistry.create !== 'function'
    || typeof backupOperationRegistry.start !== 'function'
    || typeof backupOperationRegistry.linkStep !== 'function'
    || typeof backupOperationRegistry.succeedStep !== 'function'
    || typeof backupOperationRegistry.failStep !== 'function'
    || typeof backupOperationRegistry.getOperation !== 'function'
    || typeof loadDatabaseInventory !== 'function'
    || !mailDataOperationsService || typeof mailDataOperationsService.previewBackup !== 'function'
    || typeof projectBackupLocked !== 'function'
    || !localExecutors || typeof localExecutors !== 'object' || Array.isArray(localExecutors)) invalid();

  const jobIdempotencyLookup = createJobIdempotencyLookup({
    filePath: jobStorePath,
    jobRegistry,
  });
  const childJobDispatcher = createBackupChildJobDispatcher({
    jobRegistry,
    jobIdempotencyLookup,
    loadDatabaseInventory,
    mailDataOperationsService,
  });
  const executors = Object.freeze({ ...localExecutors });

  function createOrchestrator(backupResourceProvider) {
    if (!backupResourceProvider || typeof backupResourceProvider.preview !== 'function') invalid();
    return createBackupExecutionOrchestrator({
      backupResourceProvider,
      backupOperationRegistry,
      childJobDispatcher,
      localExecutors: executors,
    });
  }

  return Object.freeze({
    backupOperationRegistry,
    jobIdempotencyLookup,
    childJobDispatcher,
    localExecutors: executors,
    createOrchestrator,
  });
}
