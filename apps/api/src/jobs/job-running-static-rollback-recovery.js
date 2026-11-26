import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningStaticRollbackRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningStaticRollbackRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_identity_invalid', 'Static rollback recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a static rollback');
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || candidate.operation !== OPERATIONS.APP_STATIC_ROLLBACK
    || candidate.resourceType !== 'application' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_job_mismatch', 'Running static rollback recovery metadata is inconsistent');
  }
}

function assertContext(context, job, candidate, identity) {
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.APP_STATIC_ROLLBACK || context.resourceType !== 'application'
    || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || context.payload?.applicationId !== context.resourceId
    || typeof context.payload?.releaseId !== 'string' || !context.payload.releaseId
    || typeof context.payload?.currentReleaseId !== 'string' || !context.payload.currentReleaseId
    || context.payload.releaseId === context.payload.currentReleaseId) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_context_mismatch', 'Private static rollback context does not match durable job metadata');
  }
  return {
    applicationId: context.payload.applicationId,
    releaseId: context.payload.releaseId,
    currentReleaseId: context.payload.currentReleaseId,
  };
}

async function requireApplicationIntent(applicationRegistry, jobId, serverId, intent) {
  let application;
  try {
    application = await applicationRegistry.getApplication(intent.applicationId);
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_application_read_failed', 'Static rollback application state could not be read');
  }
  if (!application || application.id !== intent.applicationId || application.serverId !== serverId || application.type !== 'static'
    || application.state !== 'rolling_back' || application.activeDeploymentId !== jobId
    || application.pendingRollbackReleaseId !== intent.releaseId || application.currentReleaseId !== intent.currentReleaseId) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_application_mismatch', 'Static rollback application state no longer matches the running job');
  }
}

export async function recoverRunningStaticRollback({
  serverId,
  jobId,
  jobRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  inspectRollbackEvidence,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof inspectRollbackEvidence !== 'function' || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_dependencies_invalid', 'Static rollback recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_inspection_failed', 'Durable static rollback recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_inspection_invalid', 'Durable static rollback recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate) throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_job_not_found', 'Requested static rollback is not present in durable recovery state');
  assertCandidate(candidate, identity);

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_job_read_failed', 'Running static rollback job could not be read from durable state');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.APP_STATIC_ROLLBACK || job.resourceType !== 'application'
    || job.resourceId !== candidate.resourceId) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_job_mismatch', 'Running static rollback no longer matches durable recovery state');
  }

  let context;
  try {
    context = await loadJobContext(identity.jobId);
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_context_failed', 'Private static rollback recovery context could not be read');
  }
  const intent = assertContext(context, job, candidate, identity);
  await requireApplicationIntent(applicationRegistry, identity.jobId, identity.serverId, intent);

  let evidence;
  try {
    evidence = await inspectRollbackEvidence(intent);
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_evidence_failed', 'Static rollback host evidence could not be inspected');
  }
  if (!evidence || evidence.satisfied !== true || !evidence.result || typeof evidence.result !== 'object' || Array.isArray(evidence.result)
    || evidence.result.releaseId !== intent.releaseId || evidence.result.previousReleaseId !== intent.currentReleaseId || evidence.result.active !== true) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_evidence_not_satisfied', 'Exact static rollback host evidence is absent; the running job remains unresolved');
  }

  let begun;
  try {
    begun = await jobRegistry.beginReconciliation(identity);
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_journal_failed', 'Static rollback recovery reconciliation journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_journal_invalid', 'Static rollback recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({
      serverId: identity.serverId,
      jobId: identity.jobId,
      status: 'succeeded',
      result: evidence.result,
    });
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_completion_failed', 'Static rollback evidence was confirmed but durable completion could not be confirmed');
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded'
    || terminal.operation !== OPERATIONS.APP_STATIC_ROLLBACK || terminal.resourceType !== 'application' || terminal.resourceId !== intent.applicationId) {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_completion_invalid', 'Static rollback recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_reconciliation_failed', 'Static rollback job is terminal but application reconciliation remains pending');
  }

  let acknowledgement;
  try {
    acknowledgement = await jobRegistry.acknowledgeReconciliation(identity);
  } catch {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_acknowledgement_failed', 'Static rollback reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningStaticRollbackRecoveryError('job_static_rollback_recovery_acknowledgement_invalid', 'Static rollback recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.APP_STATIC_ROLLBACK,
    applicationId: intent.applicationId,
    releaseId: intent.releaseId,
    previousReleaseId: intent.currentReleaseId,
    status: 'succeeded',
    recoveryMethod: 'verified_static_rollback_symlink',
    reconciled: true,
  });
}

export const jobRunningStaticRollbackRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  assertContext,
  requireApplicationIntent,
});
