import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningStaticRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningStaticRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningStaticRecoveryError('job_static_recovery_identity_invalid', 'Static recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRunningStaticRecoveryError('job_static_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningStaticRecoveryError('job_static_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningStaticRecoveryError('job_static_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a static deployment');
  }
}

function assertCandidate(job, identity) {
  if (!job || job.jobId !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.APP_STATIC_DEPLOY || job.resourceType !== 'application') {
    throw new JobRunningStaticRecoveryError('job_static_recovery_job_mismatch', 'Running static recovery job metadata is inconsistent');
  }
}

function assertRecoveryContext(context, job, candidate, identity) {
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.APP_STATIC_DEPLOY || context.resourceType !== 'application'
    || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || context.payload?.applicationId !== context.resourceId || context.payload?.deploymentId !== identity.jobId) {
    throw new JobRunningStaticRecoveryError('job_static_recovery_context_mismatch', 'Private static recovery context does not match durable job metadata');
  }
}

export async function recoverRunningStaticDeployment({
  serverId,
  jobId,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  inspectDeploymentEvidence,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !domainRegistry || !certificateRegistry || !applicationRegistry
    || typeof serviceStatus !== 'function'
    || typeof loadJobContext !== 'function'
    || typeof inspectDeploymentEvidence !== 'function'
    || typeof inspect !== 'function'
    || typeof reconcile !== 'function') {
    throw new JobRunningStaticRecoveryError('job_static_recovery_dependencies_invalid', 'Static recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRunningStaticRecoveryError('job_static_recovery_inspection_failed', 'Durable static recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningStaticRecoveryError('job_static_recovery_inspection_invalid', 'Durable static recovery state is invalid');
  }
  const candidate = inspection.jobs.find((job) => job.jobId === identity.jobId && job.serverId === identity.serverId) ?? null;
  if (!candidate) throw new JobRunningStaticRecoveryError('job_static_recovery_job_not_found', 'Requested static deployment is not present in durable recovery state');
  assertCandidate(candidate, identity);

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRunningStaticRecoveryError('job_static_recovery_job_read_failed', 'Running static recovery job could not be read from durable state');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.APP_STATIC_DEPLOY || job.resourceType !== 'application'
    || job.resourceId !== candidate.resourceId) {
    throw new JobRunningStaticRecoveryError('job_static_recovery_job_mismatch', 'Running static deployment no longer matches durable recovery state');
  }

  let context;
  try {
    context = await loadJobContext(identity.jobId);
  } catch {
    throw new JobRunningStaticRecoveryError('job_static_recovery_context_failed', 'Private static recovery context could not be read');
  }
  assertRecoveryContext(context, job, candidate, identity);

  let evidence;
  try {
    evidence = await inspectDeploymentEvidence({
      applicationId: context.payload.applicationId,
      deploymentId: context.payload.deploymentId,
    });
  } catch {
    throw new JobRunningStaticRecoveryError('job_static_recovery_evidence_failed', 'Static deployment host evidence could not be inspected');
  }
  if (!evidence || evidence.satisfied !== true || !evidence.result || typeof evidence.result !== 'object' || Array.isArray(evidence.result)) {
    throw new JobRunningStaticRecoveryError(
      'job_static_recovery_evidence_not_satisfied',
      'Exact static deployment host evidence is absent; the running job remains unresolved',
    );
  }

  let begun;
  try {
    begun = await jobRegistry.beginReconciliation(identity);
  } catch {
    throw new JobRunningStaticRecoveryError('job_static_recovery_journal_failed', 'Static recovery reconciliation journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningStaticRecoveryError('job_static_recovery_journal_invalid', 'Static recovery reconciliation journal acknowledgement is inconsistent');
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
    throw new JobRunningStaticRecoveryError(
      'job_static_recovery_completion_failed',
      'Static deployment evidence was confirmed but durable completion could not be confirmed',
    );
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.APP_STATIC_DEPLOY
    || terminal.resourceType !== 'application' || terminal.resourceId !== job.resourceId) {
    throw new JobRunningStaticRecoveryError('job_static_recovery_completion_invalid', 'Static recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry, certificateRegistry, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningStaticRecoveryError(
      'job_static_recovery_reconciliation_failed',
      'Static deployment job is terminal but application reconciliation remains pending',
    );
  }

  let acknowledgement;
  try {
    acknowledgement = await jobRegistry.acknowledgeReconciliation(identity);
  } catch {
    throw new JobRunningStaticRecoveryError('job_static_recovery_acknowledgement_failed', 'Static recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== identity.jobId || acknowledgement.serverId !== identity.serverId
    || acknowledgement.status !== 'succeeded') {
    throw new JobRunningStaticRecoveryError('job_static_recovery_acknowledgement_invalid', 'Static recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.APP_STATIC_DEPLOY,
    status: 'succeeded',
    recoveryMethod: 'verified_static_deployment_receipt',
    reconciled: true,
  });
}

export const jobRunningStaticRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  assertRecoveryContext,
});
