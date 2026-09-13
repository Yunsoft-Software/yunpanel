import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningDatabaseBackupRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningDatabaseBackupRecoveryError';
    this.code = code;
  }
}

function identity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_identity_invalid', 'Database backup recovery identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a database backup');
  }
}

function assertRunningJob(value, expected, databaseName) {
  if (!value || value.id !== expected.jobId || value.serverId !== expected.serverId
    || value.status !== 'running' || value.operation !== OPERATIONS.DATABASE_BACKUP
    || value.resourceType !== 'database' || value.resourceId !== databaseName) {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_job_mismatch', 'Running database backup metadata is inconsistent');
  }
}

function assertContext(context, expected, databaseName) {
  if (!context || context.id !== expected.jobId || context.serverId !== expected.serverId
    || context.status !== 'running' || context.operation !== OPERATIONS.DATABASE_BACKUP
    || context.resourceType !== 'database' || context.resourceId !== databaseName
    || !context.payload || typeof context.payload !== 'object' || Array.isArray(context.payload)
    || Object.keys(context.payload).length !== 1 || context.payload.databaseName !== databaseName) {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_context_mismatch', 'Private database backup recovery context does not match durable job metadata');
  }
}

function assertBackupEvidence(evidence, expected, databaseName) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.version !== 1 || evidence.backupId !== expected.jobId
    || evidence.databaseName !== databaseName || !['mariadb', 'mysql'].includes(evidence.engine)
    || typeof evidence.databaseVersion !== 'string' || !evidence.databaseVersion
    || typeof evidence.dumpSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.dumpSha256)
    || !Number.isSafeInteger(evidence.dumpBytes) || evidence.dumpBytes < 1
    || typeof evidence.createdAt !== 'string' || !Number.isFinite(Date.parse(evidence.createdAt))
    || evidence.backedUp !== true || evidence.sideEffects !== true
    || Object.hasOwn(evidence, 'dumpPath')) {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_evidence_invalid', 'Database backup evidence is invalid');
  }
  return evidence;
}

export async function recoverRunningDatabaseBackup({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
  inspectBackup,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const expected = identity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof inspectBackup !== 'function' || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_dependencies_invalid', 'Database backup recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let recovery;
  try { recovery = await inspect({ registry: jobRegistry }); }
  catch {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_inspection_failed', 'Durable database backup recovery state could not be inspected');
  }
  const candidate = recovery?.jobs?.find((item) => item.jobId === expected.jobId && item.serverId === expected.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== OPERATIONS.DATABASE_BACKUP
    || candidate.resourceType !== 'database' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_job_not_found', 'Requested database backup is not present in durable recovery state');
  }

  let job;
  try { job = await jobRegistry.getJob(expected.jobId); }
  catch {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_job_read_failed', 'Running database backup job could not be read');
  }
  assertRunningJob(job, expected, candidate.resourceId);

  let context;
  try { context = await loadJobContext(expected.jobId); }
  catch {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_context_failed', 'Private database backup recovery context could not be read');
  }
  assertContext(context, expected, job.resourceId);

  let evidence;
  try { evidence = await inspectBackup(expected.jobId); }
  catch {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_evidence_failed', 'Private database backup evidence could not be verified');
  }
  if (!evidence) {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_evidence_missing', 'Database backup evidence is absent; the running job remains unresolved');
  }
  const result = assertBackupEvidence(evidence, expected, job.resourceId);

  let begun;
  try { begun = await jobRegistry.beginReconciliation(expected); }
  catch {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_journal_failed', 'Database backup recovery journal could not be opened');
  }
  if (!begun || begun.jobId !== expected.jobId || begun.serverId !== expected.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_journal_invalid', 'Database backup recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({
      serverId: expected.serverId,
      jobId: expected.jobId,
      status: 'succeeded',
      result,
    });
  } catch {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_completion_failed', 'Verified database backup could not be committed to durable job state');
  }
  if (!terminal || terminal.id !== expected.jobId || terminal.serverId !== expected.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.DATABASE_BACKUP
    || terminal.resourceType !== 'database' || terminal.resourceId !== job.resourceId) {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_completion_invalid', 'Database backup recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {}, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_reconciliation_failed', 'Database backup job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(expected); }
  catch {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_acknowledgement_failed', 'Database backup recovery could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== expected.jobId || acknowledgement.serverId !== expected.serverId
    || acknowledgement.status !== 'succeeded') {
    throw new JobRunningDatabaseBackupRecoveryError('job_database_backup_recovery_acknowledgement_invalid', 'Database backup recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: expected.serverId,
    jobId: expected.jobId,
    operation: OPERATIONS.DATABASE_BACKUP,
    status: 'succeeded',
    recoveryMethod: 'verified_private_database_backup_artifact',
    reconciled: true,
  });
}

export const jobRunningDatabaseBackupRecoveryInternals = Object.freeze({
  identity,
  requireStoppedConsumers,
  assertRunningJob,
  assertContext,
  assertBackupEvidence,
});
