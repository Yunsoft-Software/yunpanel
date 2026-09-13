import {
  createDockerVolumeInspector,
  createLocalBackupArtifactManager,
} from '@yunpanel/host-runtime';
import { createBackupApplicationLocalExecutor } from './backup-application-local-executor.js';
import { createBackupChildJobDispatcher } from './backup-child-job-dispatcher.js';
import { createBackupDockerLocalExecutor } from './backup-docker-local-executor.js';
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
  applicationRegistry,
  applicationEnvironmentRegistry,
  dockerComposeProjectRegistry,
  dockerComposeObserver,
  loadDatabaseInventory,
  mailDataOperationsService,
  projectBackupLocked,
  localBackupArtifactManager = createLocalBackupArtifactManager(),
  inspectDockerVolume = createDockerVolumeInspector(),
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
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !applicationEnvironmentRegistry
    || typeof applicationEnvironmentRegistry.environmentStatus !== 'function'
    || typeof applicationEnvironmentRegistry.materialize !== 'function'
    || !dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function'
    || !dockerComposeObserver || typeof dockerComposeObserver.inspect !== 'function'
    || typeof loadDatabaseInventory !== 'function'
    || !mailDataOperationsService || typeof mailDataOperationsService.previewBackup !== 'function'
    || typeof projectBackupLocked !== 'function'
    || !localBackupArtifactManager || typeof localBackupArtifactManager.archive !== 'function'
    || typeof inspectDockerVolume !== 'function') invalid();

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
  const applicationExecutor = createBackupApplicationLocalExecutor({
    applicationRegistry,
    applicationEnvironmentRegistry,
    localBackupArtifactManager,
  });
  const dockerExecutor = createBackupDockerLocalExecutor({
    dockerComposeProjectRegistry,
    dockerComposeObserver,
    jobRegistry,
    projectBackupLocked,
    inspectDockerVolume,
    localBackupArtifactManager,
  });
  const localExecutors = Object.freeze({
    application_snapshot: applicationExecutor,
    docker_storage_backup: dockerExecutor,
  });

  function createOrchestrator(backupResourceProvider) {
    if (!backupResourceProvider || typeof backupResourceProvider.preview !== 'function') invalid();
    return createBackupExecutionOrchestrator({
      backupResourceProvider,
      backupOperationRegistry,
      childJobDispatcher,
      localExecutors,
    });
  }

  return Object.freeze({
    backupOperationRegistry,
    jobIdempotencyLookup,
    childJobDispatcher,
    localExecutors,
    createOrchestrator,
  });
}
