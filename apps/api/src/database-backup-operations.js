import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const DATABASE_OPERATIONS = new Set([
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.DATABASE_CREATE,
  OPERATIONS.DATABASE_DELETE,
  OPERATIONS.DATABASE_BACKUP,
  OPERATIONS.DATABASE_RESTORE,
  OPERATIONS.DATABASE_CREDENTIAL_APPLY,
  OPERATIONS.DATABASE_CREDENTIAL_DELETE,
]);

export class DatabaseBackupOperationsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DatabaseBackupOperationsError';
    this.code = code;
    this.status = status;
  }
}

function databaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value) || RESERVED_DATABASES.has(value.toLowerCase())) {
    throw new DatabaseBackupOperationsError('database_restore_name_invalid', 'Database restore schema name is invalid');
  }
  return value;
}

function backupId(value) {
  if (typeof value !== 'string' || !BACKUP_ID_PATTERN.test(value)) {
    throw new DatabaseBackupOperationsError('database_restore_backup_id_invalid', 'Database restore backup identity is invalid');
  }
  return value;
}

function sha256(value, code = 'database_restore_digest_invalid') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DatabaseBackupOperationsError(code, 'Database restore digest is invalid');
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ownershipScope(value) {
  if (value === null || value === undefined) return null;
  const fields = ['websiteId', 'databaseBindingId', 'expectedBindingRevision'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))
    || !UUID_PATTERN.test(value.websiteId ?? '')
    || !UUID_PATTERN.test(value.databaseBindingId ?? '')
    || !Number.isSafeInteger(value.expectedBindingRevision)
    || value.expectedBindingRevision < 1) {
    throw new DatabaseBackupOperationsError(
      'database_restore_ownership_scope_invalid',
      'Database restore Website ownership scope is invalid',
    );
  }
  return Object.freeze({
    websiteId: value.websiteId.toLowerCase(),
    databaseBindingId: value.databaseBindingId.toLowerCase(),
    expectedBindingRevision: value.expectedBindingRevision,
  });
}

function matchesOwnershipScope(payload, scope) {
  if (!scope) return true;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    && payload.websiteId === scope.websiteId
    && payload.databaseBindingId === scope.databaseBindingId
    && payload.expectedBindingRevision === scope.expectedBindingRevision;
}

export function createDatabaseBackupOperationsService({ backupManager, jobRegistry } = {}) {
  if (!backupManager || typeof backupManager.inspectBackup !== 'function'
    || !jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function') {
    throw new DatabaseBackupOperationsError(
      'database_backup_operations_dependencies_invalid',
      'Database backup operation dependencies are unavailable',
      503,
    );
  }

  async function assertIdle(serverId) {
    let jobs;
    try { jobs = await jobRegistry.listJobs({ serverId }); }
    catch {
      throw new DatabaseBackupOperationsError('database_job_state_unavailable', 'Database job state could not be inspected', 503);
    }
    if (!Array.isArray(jobs)) {
      throw new DatabaseBackupOperationsError('database_job_state_unavailable', 'Database job state is invalid', 503);
    }
    if (jobs.some((job) => DATABASE_OPERATIONS.has(job.operation) && ACTIVE_STATUSES.has(job.status))) {
      throw new DatabaseBackupOperationsError('database_job_conflict', 'Another database operation is already queued or running', 409);
    }
  }

  async function selectedBackup(serverId, requestedBackupId, requestedDatabaseName, requestedOwnershipScope = null) {
    const id = backupId(requestedBackupId);
    const name = databaseName(requestedDatabaseName);
    const scope = ownershipScope(requestedOwnershipScope);
    let job;
    try { job = await jobRegistry.getJob(id); }
    catch {
      throw new DatabaseBackupOperationsError('database_restore_backup_job_unavailable', 'Database backup job could not be verified', 503);
    }
    if (!job || job.status !== 'succeeded' || job.operation !== OPERATIONS.DATABASE_BACKUP
      || job.serverId !== serverId || job.resourceType !== 'database' || job.resourceId !== name
      || job.result?.backupId !== id || job.result?.databaseName !== name
      || typeof job.result?.dumpSha256 !== 'string' || !SHA256_PATTERN.test(job.result.dumpSha256)
      || job.result?.backedUp !== true || job.result?.sideEffects !== true) {
      throw new DatabaseBackupOperationsError('database_restore_backup_job_mismatch', 'Selected backup does not belong to this server and database', 409);
    }
    if (scope && !matchesOwnershipScope(job.payload, scope)) {
      throw new DatabaseBackupOperationsError(
        'database_restore_backup_scope_mismatch',
        'Selected backup does not belong to the current Website database binding revision',
        409,
      );
    }

    let backup;
    try { backup = await backupManager.inspectBackup(id); }
    catch {
      throw new DatabaseBackupOperationsError('database_restore_backup_unavailable', 'Selected backup artifact could not be verified', 503);
    }
    if (!backup) throw new DatabaseBackupOperationsError('database_restore_backup_not_found', 'Selected backup artifact was not found', 404);
    if (backup.backupId !== id || backup.databaseName !== name
      || backup.dumpSha256 !== job.result.dumpSha256 || backup.dumpBytes !== job.result.dumpBytes
      || backup.engine !== job.result.engine || backup.databaseVersion !== job.result.databaseVersion
      || backup.backedUp !== true || backup.sideEffects !== true
      || Object.hasOwn(backup, 'dumpPath')) {
      throw new DatabaseBackupOperationsError('database_restore_backup_evidence_drift', 'Selected backup artifact no longer matches durable backup evidence', 409);
    }
    return Object.freeze({ job, backup });
  }

  async function previewRestore({ serverId, databaseName: requestedName, backupId: requestedBackupId, ownership: requestedOwnership = null } = {}) {
    if (typeof serverId !== 'string' || !serverId) {
      throw new DatabaseBackupOperationsError('database_restore_server_invalid', 'Database restore server identity is invalid');
    }
    const name = databaseName(requestedName);
    const scope = ownershipScope(requestedOwnership);
    await assertIdle(serverId);
    const { backup } = await selectedBackup(serverId, requestedBackupId, name, scope);
    const identity = Object.freeze({
      version: 1,
      operation: 'database_restore',
      serverId,
      databaseName: name,
      backupId: backup.backupId,
      backupSha256: backup.dumpSha256,
      backupBytes: backup.dumpBytes,
      engine: backup.engine,
      databaseVersion: backup.databaseVersion,
      ...(scope ? {
        websiteId: scope.websiteId,
        databaseBindingId: scope.databaseBindingId,
        expectedBindingRevision: scope.expectedBindingRevision,
      } : {}),
    });
    const previewDigest = digest(identity);
    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation: `restore-database:${name}:${previewDigest}`,
      sideEffects: false,
    });
  }

  async function queueRestore({
    serverId,
    databaseName: requestedName,
    backupId: requestedBackupId,
    expectedPreviewDigest,
    expectedBackupSha256,
    confirmation,
    ownership: requestedOwnership = null,
  } = {}) {
    const name = databaseName(requestedName);
    const scope = ownershipScope(requestedOwnership);
    const requestedPreview = sha256(expectedPreviewDigest, 'database_restore_preview_digest_invalid');
    const requestedBackupSha = sha256(expectedBackupSha256, 'database_restore_backup_digest_invalid');
    const current = await previewRestore({
      serverId,
      databaseName: name,
      backupId: requestedBackupId,
      ownership: scope,
    });
    if (current.previewDigest !== requestedPreview || current.backupSha256 !== requestedBackupSha) {
      throw new DatabaseBackupOperationsError('database_restore_preview_stale', 'Database restore preview is stale', 409);
    }
    if (confirmation !== current.confirmation) {
      throw new DatabaseBackupOperationsError('database_restore_confirmation_invalid', 'Database restore confirmation is invalid', 409);
    }
    const job = await jobRegistry.enqueue({
      serverId,
      type: OPERATIONS.DATABASE_RESTORE,
      operation: OPERATIONS.DATABASE_RESTORE,
      payload: {
        databaseName: name,
        backupId: current.backupId,
        expectedBackupSha256: current.backupSha256,
        ...(scope ? {
          websiteId: scope.websiteId,
          databaseBindingId: scope.databaseBindingId,
          expectedBindingRevision: scope.expectedBindingRevision,
        } : {}),
      },
      resourceType: 'database',
      resourceId: name,
      idempotencyKey: `database-restore:${serverId}:${name}:${current.previewDigest}`,
    });
    return Object.freeze({ previewDigest: current.previewDigest, backupSha256: current.backupSha256, job });
  }

  return Object.freeze({ previewRestore, queueRestore, selectedBackup });
}

export const databaseBackupOperationsInternals = Object.freeze({
  databaseName,
  backupId,
  sha256,
  digest,
  ownershipScope,
  matchesOwnershipScope,
  databaseOperations: Object.freeze([...DATABASE_OPERATIONS]),
});
