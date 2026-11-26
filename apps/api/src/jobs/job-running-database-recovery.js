import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningDatabaseRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningDatabaseRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_identity_invalid', 'Database recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a database create');
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || candidate.operation !== OPERATIONS.DATABASE_CREATE
    || candidate.resourceType !== 'database' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_job_mismatch', 'Running database recovery job metadata is inconsistent');
  }
}

function assertContext(context, job, candidate, identity) {
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.DATABASE_CREATE || context.resourceType !== 'database'
    || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || !context.payload || typeof context.payload !== 'object' || Array.isArray(context.payload)
    || context.payload.name !== context.resourceId) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_context_mismatch', 'Private database recovery context does not match durable job metadata');
  }
}

function databaseCreateEvidence(snapshot, databaseName) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || !['mariadb', 'mysql'].includes(snapshot.engine)
    || typeof snapshot.version !== 'string' || !snapshot.version
    || !Array.isArray(snapshot.databases)) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_evidence_invalid', 'Database host evidence is invalid');
  }
  const matches = snapshot.databases.filter((database) => database?.name === databaseName);
  if (matches.length !== 1) return null;
  const database = matches[0];
  if (!Number.isSafeInteger(database.sizeBytes) || database.sizeBytes < 0) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_evidence_invalid', 'Database host evidence is invalid');
  }
  return {
    engine: snapshot.engine,
    version: snapshot.version,
    database: { name: database.name, sizeBytes: database.sizeBytes },
    created: true,
  };
}

export async function recoverRunningDatabaseCreate({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
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
    || typeof inspectDatabaseState !== 'function'
    || typeof inspect !== 'function'
    || typeof reconcile !== 'function') {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_dependencies_invalid', 'Database recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_inspection_failed', 'Durable database recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_inspection_invalid', 'Durable database recovery state is invalid');
  }
  const candidate = inspection.jobs.find((job) => job.jobId === identity.jobId && job.serverId === identity.serverId) ?? null;
  if (!candidate) throw new JobRunningDatabaseRecoveryError('job_database_recovery_job_not_found', 'Requested database create is not present in durable recovery state');
  assertCandidate(candidate, identity);

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_job_read_failed', 'Running database recovery job could not be read from durable state');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.DATABASE_CREATE || job.resourceType !== 'database'
    || job.resourceId !== candidate.resourceId) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_job_mismatch', 'Running database create no longer matches durable recovery state');
  }

  let context;
  try {
    context = await loadJobContext(identity.jobId);
  } catch {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_context_failed', 'Private database recovery context could not be read');
  }
  assertContext(context, job, candidate, identity);

  let snapshot;
  try {
    snapshot = await inspectDatabaseState();
  } catch {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_evidence_failed', 'Database host state could not be inspected');
  }
  const result = databaseCreateEvidence(snapshot, context.payload.name);
  if (!result) {
    throw new JobRunningDatabaseRecoveryError(
      'job_database_recovery_evidence_not_satisfied',
      'Exact created database is absent; the running job remains unresolved',
    );
  }

  let begun;
  try {
    begun = await jobRegistry.beginReconciliation(identity);
  } catch {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_journal_failed', 'Database recovery reconciliation journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_journal_invalid', 'Database recovery reconciliation journal acknowledgement is inconsistent');
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({
      serverId: identity.serverId,
      jobId: identity.jobId,
      status: 'succeeded',
      result,
    });
  } catch {
    throw new JobRunningDatabaseRecoveryError(
      'job_database_recovery_completion_failed',
      'Database presence was confirmed but durable completion could not be confirmed',
    );
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.DATABASE_CREATE
    || terminal.resourceType !== 'database' || terminal.resourceId !== job.resourceId) {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_completion_invalid', 'Database recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {}, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningDatabaseRecoveryError(
      'job_database_recovery_reconciliation_failed',
      'Database create job is terminal but reconciliation remains pending',
    );
  }

  let acknowledgement;
  try {
    acknowledgement = await jobRegistry.acknowledgeReconciliation(identity);
  } catch {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_acknowledgement_failed', 'Database recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== identity.jobId || acknowledgement.serverId !== identity.serverId
    || acknowledgement.status !== 'succeeded') {
    throw new JobRunningDatabaseRecoveryError('job_database_recovery_acknowledgement_invalid', 'Database recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.DATABASE_CREATE,
    status: 'succeeded',
    recoveryMethod: 'verified_database_presence',
    reconciled: true,
  });
}

export const jobRunningDatabaseRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  assertContext,
  databaseCreateEvidence,
});
