import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningDomainRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningDomainRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_identity_invalid', 'Domain recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a staged domain job');
  }
}

function assertCandidate(job, identity) {
  if (!job || job.jobId !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.DOMAIN_STAGE || job.resourceType !== 'domain') {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_job_mismatch', 'Running domain recovery job metadata is inconsistent');
  }
}

export async function recoverRunningDomainStage({
  serverId,
  jobId,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  serviceStatus,
  inspectStageEvidence,
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
    || typeof inspectStageEvidence !== 'function'
    || typeof inspect !== 'function'
    || typeof reconcile !== 'function') {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_dependencies_invalid', 'Domain recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_inspection_failed', 'Durable domain recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_inspection_invalid', 'Durable domain recovery state is invalid');
  }
  const candidate = inspection.jobs.find((job) => job.jobId === identity.jobId && job.serverId === identity.serverId) ?? null;
  if (!candidate) throw new JobRunningDomainRecoveryError('job_domain_recovery_job_not_found', 'Requested domain job is not present in durable recovery state');
  assertCandidate(candidate, identity);

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_job_read_failed', 'Running domain recovery job could not be read from durable state');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.DOMAIN_STAGE || job.resourceType !== 'domain'
    || job.resourceId !== candidate.resourceId || !job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload)) {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_job_mismatch', 'Running domain recovery job no longer matches durable recovery state');
  }

  let evidence;
  try {
    evidence = await inspectStageEvidence(job.payload);
  } catch {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_evidence_failed', 'Staged domain host evidence could not be inspected');
  }
  if (!evidence || evidence.satisfied !== true || !evidence.result || typeof evidence.result !== 'object' || Array.isArray(evidence.result)) {
    throw new JobRunningDomainRecoveryError(
      'job_domain_recovery_evidence_not_satisfied',
      'Exact staged domain host evidence is absent; the running job remains unresolved',
    );
  }

  let begun;
  try {
    begun = await jobRegistry.beginReconciliation(identity);
  } catch {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_journal_failed', 'Domain recovery reconciliation journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_journal_invalid', 'Domain recovery reconciliation journal acknowledgement is inconsistent');
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
    throw new JobRunningDomainRecoveryError(
      'job_domain_recovery_completion_failed',
      'Staged domain evidence was confirmed but durable job completion could not be confirmed',
    );
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.DOMAIN_STAGE
    || terminal.resourceType !== 'domain' || terminal.resourceId !== job.resourceId) {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_completion_invalid', 'Domain recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry, certificateRegistry, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningDomainRecoveryError(
      'job_domain_recovery_reconciliation_failed',
      'Domain recovery job is terminal but resource reconciliation remains pending',
    );
  }

  let acknowledgement;
  try {
    acknowledgement = await jobRegistry.acknowledgeReconciliation(identity);
  } catch {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_acknowledgement_failed', 'Domain recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== identity.jobId || acknowledgement.serverId !== identity.serverId
    || acknowledgement.status !== 'succeeded') {
    throw new JobRunningDomainRecoveryError('job_domain_recovery_acknowledgement_invalid', 'Domain recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.DOMAIN_STAGE,
    status: 'succeeded',
    recoveryMethod: 'verified_staged_nginx_config',
    reconciled: true,
  });
}

export const jobRunningDomainRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
});
