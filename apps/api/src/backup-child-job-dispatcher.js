import { OPERATIONS } from '@yunpanel/protocol';

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const DATABASE_OPERATIONS = new Set([
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.DATABASE_CREATE,
  OPERATIONS.DATABASE_DELETE,
  OPERATIONS.DATABASE_BACKUP,
  OPERATIONS.DATABASE_RESTORE,
  OPERATIONS.DATABASE_CREDENTIAL_APPLY,
  OPERATIONS.DATABASE_CREDENTIAL_DELETE,
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class BackupChildDispatcherError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupChildDispatcherError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new BackupChildDispatcherError(code, message, status);
}

function requireStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)
    || typeof step.stepId !== 'string'
    || typeof step.stepDigest !== 'string' || !SHA256_PATTERN.test(step.stepDigest)
    || !['database_backup', 'mail_data_backup'].includes(step.executorKind)
    || !step.input || typeof step.input !== 'object' || Array.isArray(step.input)) {
    fail('backup_child_step_invalid', 'Backup child step is invalid');
  }
  return step;
}

function idempotencyKey(step) {
  return `general-backup-step:${step.stepDigest}`;
}

function databaseRequest(serverId, step) {
  return Object.freeze({
    serverId,
    type: OPERATIONS.DATABASE_BACKUP,
    operation: OPERATIONS.DATABASE_BACKUP,
    payload: Object.freeze({ databaseName: step.input.databaseName }),
    resourceType: 'database',
    resourceId: step.input.databaseName,
    idempotencyKey: idempotencyKey(step),
  });
}

function mailRequest(serverId, step) {
  return Object.freeze({
    serverId,
    type: 'mail_data_backup',
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    payload: Object.freeze({
      mailDomainId: step.input.mailDomainId,
      resourceId: step.input.resourceId,
      scope: step.input.scope,
      identity: step.input.identity,
      expectedResourceRevision: step.input.expectedRevision,
      expectedSnapshotSha256: step.input.expectedSnapshotSha256,
    }),
    resourceType: 'mail_domain',
    resourceId: step.input.mailDomainId,
    idempotencyKey: idempotencyKey(step),
  });
}

function requestFor(serverId, stepValue) {
  const step = requireStep(stepValue);
  if (step.executorKind === 'database_backup') return databaseRequest(serverId, step);
  return mailRequest(serverId, step);
}

function intentFor(stepValue) {
  const step = requireStep(stepValue);
  return Object.freeze({ kind: 'job', id: idempotencyKey(step) });
}

function databaseMatchesInventory(step, inventory) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)
    || inventory.engine !== step.input.engine
    || inventory.version !== step.input.databaseVersion
    || !Array.isArray(inventory.databases)
    || inventory.snapshot?.jobId !== step.input.inventoryJobId
    || inventory.snapshot?.refreshedAt !== step.input.inventoryRefreshedAt) return false;
  const database = inventory.databases.find((entry) => entry?.name === step.input.databaseName);
  return Boolean(database && database.sizeBytes === step.input.sizeBytes);
}

function mailMatchesPreview(step, preview) {
  return Boolean(preview
    && preview.version === 1
    && preview.operation === 'mail_data_backup'
    && preview.mailDomainId === step.input.mailDomainId
    && preview.resourceId === step.input.resourceId
    && preview.scope === step.input.scope
    && preview.identity === step.input.identity
    && preview.expectedRevision === step.input.expectedRevision
    && preview.snapshotSha256 === step.input.expectedSnapshotSha256
    && preview.sourcePresent === true
    && preview.bytes === step.input.bytes
    && preview.sideEffects === false);
}

function evidenceFromJob(step, job) {
  if (!job || job.status !== 'succeeded' || !job.result || typeof job.result !== 'object') {
    fail('backup_child_result_invalid', 'Backup child job has no successful evidence');
  }
  if (step.executorKind === 'database_backup') {
    if (job.operation !== OPERATIONS.DATABASE_BACKUP
      || job.resourceType !== 'database' || job.resourceId !== step.input.databaseName
      || job.result.databaseName !== step.input.databaseName
      || typeof job.result.backupId !== 'string'
      || typeof job.result.dumpSha256 !== 'string' || !SHA256_PATTERN.test(job.result.dumpSha256)
      || !Number.isSafeInteger(job.result.dumpBytes) || job.result.dumpBytes < 1
      || typeof job.result.createdAt !== 'string' || !Number.isFinite(Date.parse(job.result.createdAt))) {
      fail('backup_child_result_invalid', 'Database backup child evidence is invalid');
    }
    return Object.freeze({
      artifactId: job.result.backupId,
      contentSha256: job.result.dumpSha256,
      bytes: job.result.dumpBytes,
      createdAt: new Date(job.result.createdAt).toISOString(),
    });
  }
  if (job.operation !== OPERATIONS.MAIL_DATA_BACKUP
    || job.resourceType !== 'mail_domain' || job.resourceId !== step.input.mailDomainId
    || job.result.mailDomainId !== step.input.mailDomainId
    || job.result.scope !== step.input.scope || job.result.identity !== step.input.identity
    || job.result.sourceSnapshotSha256 !== step.input.expectedSnapshotSha256
    || typeof job.result.backupId !== 'string'
    || typeof job.result.contentSha256 !== 'string' || !SHA256_PATTERN.test(job.result.contentSha256)
    || !Number.isSafeInteger(job.result.bytes) || job.result.bytes < 0) {
    fail('backup_child_result_invalid', 'Mail backup child evidence is invalid');
  }
  const createdAt = job.finishedAt ?? job.createdAt;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    fail('backup_child_result_invalid', 'Mail backup child timestamp is invalid');
  }
  return Object.freeze({
    artifactId: job.result.backupId,
    contentSha256: job.result.contentSha256,
    bytes: job.result.bytes,
    createdAt: new Date(createdAt).toISOString(),
  });
}

export function createBackupChildJobDispatcher({
  jobRegistry,
  loadDatabaseInventory,
  mailDataOperationsService,
} = {}) {
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function') {
    throw new BackupChildDispatcherError('backup_child_dependencies_invalid', 'Job registry is required', 503);
  }
  if (typeof loadDatabaseInventory !== 'function') {
    throw new BackupChildDispatcherError('backup_child_dependencies_invalid', 'Database inventory loader is required', 503);
  }
  if (!mailDataOperationsService || typeof mailDataOperationsService.previewBackup !== 'function') {
    throw new BackupChildDispatcherError('backup_child_dependencies_invalid', 'Mail data preview service is required', 503);
  }

  function intent(stepValue) {
    return intentFor(stepValue);
  }

  async function verify(serverId, stepValue) {
    const step = requireStep(stepValue);
    if (step.executorKind === 'database_backup') {
      let jobs;
      let inventory;
      try {
        [jobs, inventory] = await Promise.all([
          jobRegistry.listJobs({ serverId }),
          loadDatabaseInventory(serverId),
        ]);
      } catch {
        fail('backup_database_state_unavailable', 'Database backup source state could not be verified', 503);
      }
      if (!Array.isArray(jobs) || jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status) && DATABASE_OPERATIONS.has(job.operation))) {
        fail('backup_database_job_conflict', 'Another database operation is already active', 409);
      }
      if (!databaseMatchesInventory(step, inventory)) {
        fail('backup_database_preview_stale', 'Database backup source changed after preview', 409);
      }
    } else {
      let preview;
      try {
        preview = await mailDataOperationsService.previewBackup({
          scope: step.input.scope,
          resourceId: step.input.resourceId,
        });
      } catch (error) {
        if (error?.status === 409) throw error;
        fail('backup_mail_state_unavailable', 'Mail backup source state could not be verified', 503);
      }
      if (!mailMatchesPreview(step, preview)) {
        fail('backup_mail_preview_stale', 'Mail backup source changed after preview', 409);
      }
    }
    return true;
  }

  async function prepare(serverId, stepValue) {
    await verify(serverId, stepValue);
    const step = requireStep(stepValue);
    return Object.freeze({ workRef: intentFor(step), request: requestFor(serverId, step) });
  }

  async function enqueuePrepared(serverId, stepValue, workRef) {
    const step = requireStep(stepValue);
    const request = requestFor(serverId, step);
    const expectedIntent = intentFor(step);
    if (!workRef || workRef.kind !== expectedIntent.kind || workRef.id !== expectedIntent.id) {
      fail('backup_child_dispatch_intent_invalid', 'Backup child dispatch intent does not match the execution step');
    }
    try { return await jobRegistry.enqueue(request); }
    catch (error) {
      if (error?.status === 409) throw error;
      fail('backup_child_enqueue_failed', 'Backup child job could not be queued', 503);
    }
  }

  function evidence(stepValue, job) {
    return evidenceFromJob(requireStep(stepValue), job);
  }

  return Object.freeze({ intent, verify, prepare, enqueuePrepared, evidence });
}

export const backupChildDispatcherInternals = Object.freeze({
  databaseOperations: Object.freeze([...DATABASE_OPERATIONS]),
  idempotencyKey,
  intentFor,
  requestFor,
  databaseMatchesInventory,
  mailMatchesPreview,
  evidenceFromJob,
});
