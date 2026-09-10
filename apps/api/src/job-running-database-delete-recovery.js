import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningDatabaseDeleteRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningDatabaseDeleteRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_identity_invalid', 'Database deletion recovery identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a database deletion');
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || candidate.operation !== OPERATIONS.DATABASE_DELETE
    || candidate.resourceType !== 'database' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_job_mismatch', 'Running database deletion recovery metadata is inconsistent');
  }
}

function assertContext(context, job, candidate, identity) {
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.DATABASE_DELETE || context.resourceType !== 'database'
    || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || !context.payload || typeof context.payload !== 'object' || Array.isArray(context.payload)
    || context.payload.name !== context.resourceId) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_context_mismatch', 'Private database deletion recovery context does not match durable job metadata');
  }
}

function assertReceipt(receipt, context, identity) {
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId
    || receipt.databaseName !== context.payload.name
    || !receipt.result || typeof receipt.result !== 'object' || Array.isArray(receipt.result)
    || receipt.result.deleted !== true || receipt.result.database?.name !== context.payload.name) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_receipt_mismatch', 'Database deletion receipt does not match the durable job');
  }
}

function confirmDatabaseAbsent(snapshot, receipt) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || !['mariadb', 'mysql'].includes(snapshot.engine)
    || typeof snapshot.version !== 'string' || !snapshot.version
    || !Array.isArray(snapshot.databases)) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_evidence_invalid', 'Database deletion host evidence is invalid');
  }
  if (snapshot.engine !== receipt.result.engine) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_engine_drift', 'Database engine changed after the deletion receipt was recorded');
  }
  return !snapshot.databases.some((database) => database?.name === receipt.databaseName);
}

export async function recoverRunningDatabaseDelete({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
  readDeletionReceipt,
  inspectDatabaseState,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || typeof serviceStatus !== 'function'
    || typeof loadJobContext !== 'function'
    || typeof readDeletionReceipt !== 'function'
    || typeof inspectDatabaseState !== 'function'
    || typeof inspect !== 'function'
    || typeof reconcile !== 'function') {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_dependencies_invalid', 'Database deletion recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_inspection_failed', 'Durable database deletion recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_inspection_invalid', 'Durable database deletion recovery state is invalid');
  }
  const candidate = inspection.jobs.find((job) => job.jobId === identity.jobId && job.serverId === identity.serverId) ?? null;
  if (!candidate) throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_job_not_found', 'Requested database deletion is not present in durable recovery state');
  assertCandidate(candidate, identity);

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_job_read_failed', 'Running database deletion job could not be read from durable state');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.DATABASE_DELETE || job.resourceType !== 'database'
    || job.resourceId !== candidate.resourceId) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_job_mismatch', 'Running database deletion no longer matches durable recovery state');
  }

  let context;
  try {
    context = await loadJobContext(identity.jobId);
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_context_failed', 'Private database deletion recovery context could not be read');
  }
  assertContext(context, job, candidate, identity);

  let receipt;
  try {
    receipt = await readDeletionReceipt(identity.serverId, identity.jobId);
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_receipt_failed', 'Database deletion receipt could not be read');
  }
  if (!receipt) {
    throw new JobRunningDatabaseDeleteRecoveryError(
      'job_database_delete_recovery_receipt_missing',
      'Database deletion receipt is absent; the running job remains unresolved',
    );
  }
  assertReceipt(receipt, context, identity);

  let snapshot;
  try {
    snapshot = await inspectDatabaseState();
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_evidence_failed', 'Database host state could not be inspected');
  }
  if (!confirmDatabaseAbsent(snapshot, receipt)) {
    throw new JobRunningDatabaseDeleteRecoveryError(
      'job_database_delete_recovery_evidence_not_satisfied',
      'The deleted database is present on the host; the running job remains unresolved',
    );
  }

  let begun;
  try {
    begun = await jobRegistry.beginReconciliation(identity);
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_journal_failed', 'Database deletion recovery journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_journal_invalid', 'Database deletion recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({
      serverId: identity.serverId,
      jobId: identity.jobId,
      status: 'succeeded',
      result: receipt.result,
    });
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError(
      'job_database_delete_recovery_completion_failed',
      'Database deletion evidence was confirmed but durable completion could not be confirmed',
    );
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.DATABASE_DELETE
    || terminal.resourceType !== 'database' || terminal.resourceId !== job.resourceId) {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_completion_invalid', 'Database deletion recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {}, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError(
      'job_database_delete_recovery_reconciliation_failed',
      'Database deletion job is terminal but reconciliation remains pending',
    );
  }

  let acknowledgement;
  try {
    acknowledgement = await jobRegistry.acknowledgeReconciliation(identity);
  } catch {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_acknowledgement_failed', 'Database deletion recovery could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== identity.jobId || acknowledgement.serverId !== identity.serverId
    || acknowledgement.status !== 'succeeded') {
    throw new JobRunningDatabaseDeleteRecoveryError('job_database_delete_recovery_acknowledgement_invalid', 'Database deletion recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.DATABASE_DELETE,
    status: 'succeeded',
    recoveryMethod: 'verified_database_deletion_receipt_and_absence',
    reconciled: true,
  });
}

export const jobRunningDatabaseDeleteRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  assertContext,
  assertReceipt,
  confirmDatabaseAbsent,
});
