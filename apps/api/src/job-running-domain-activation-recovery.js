import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export class JobRunningDomainActivationRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningDomainActivationRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_identity_invalid', 'Domain activation recovery identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering domain activation');
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || candidate.operation !== OPERATIONS.DOMAIN_ACTIVATE
    || candidate.resourceType !== 'domain' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_job_mismatch', 'Running domain activation recovery metadata is inconsistent');
  }
}

function activationIntent(context, job, candidate, identity) {
  const primaryDomain = typeof context?.payload?.primaryDomain === 'string' ? context.payload.primaryDomain.toLowerCase() : '';
  const checksum = context?.payload?.checksum;
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.DOMAIN_ACTIVATE || context.resourceType !== 'domain'
    || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || !primaryDomain || typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_context_mismatch', 'Private domain activation context does not match durable job metadata');
  }
  return { primaryDomain, checksum };
}

function assertReceipt(receipt, identity, intent) {
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId
    || receipt.primaryDomain !== intent.primaryDomain || receipt.checksum !== intent.checksum) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_receipt_mismatch', 'Domain activation receipt does not match the running job');
  }
}

export async function recoverRunningDomainActivation({
  serverId,
  jobId,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  readActivationReceipt,
  inspectActiveEvidence,
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
    || typeof readActivationReceipt !== 'function'
    || typeof inspectActiveEvidence !== 'function'
    || typeof inspect !== 'function'
    || typeof reconcile !== 'function') {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_dependencies_invalid', 'Domain activation recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_inspection_failed', 'Durable domain activation recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_inspection_invalid', 'Durable domain activation recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  assertCandidate(candidate, identity);

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_job_read_failed', 'Running domain activation job could not be read from durable state');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.DOMAIN_ACTIVATE || job.resourceType !== 'domain' || job.resourceId !== candidate.resourceId) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_job_mismatch', 'Running domain activation no longer matches durable recovery state');
  }

  let context;
  try {
    context = await loadJobContext(identity.jobId);
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_context_failed', 'Private domain activation recovery context could not be read');
  }
  const intent = activationIntent(context, job, candidate, identity);

  let receipt;
  try {
    receipt = await readActivationReceipt(identity.serverId, identity.jobId);
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_receipt_failed', 'Domain activation recovery receipt could not be read');
  }
  if (!receipt) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_receipt_missing', 'Domain activation receipt is absent; the running job remains unresolved');
  }
  assertReceipt(receipt, identity, intent);

  let evidence;
  try {
    evidence = await inspectActiveEvidence(intent);
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_evidence_failed', 'Active Nginx host state could not be inspected');
  }
  if (!evidence || evidence.satisfied !== true || !evidence.result || typeof evidence.result !== 'object' || Array.isArray(evidence.result)
    || evidence.result.checksum !== intent.checksum || evidence.result.active !== true) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_evidence_not_satisfied', 'Active Nginx state does not match the completed activation');
  }

  let begun;
  try {
    begun = await jobRegistry.beginReconciliation(identity);
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_journal_failed', 'Domain activation recovery journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_journal_invalid', 'Domain activation recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result: evidence.result });
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_completion_failed', 'Domain activation evidence was verified but durable completion could not be confirmed');
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded'
    || terminal.operation !== OPERATIONS.DOMAIN_ACTIVATE || terminal.resourceType !== 'domain' || terminal.resourceId !== job.resourceId) {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_completion_invalid', 'Domain activation recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry, certificateRegistry, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_reconciliation_failed', 'Domain activation job is terminal but domain reconciliation remains pending');
  }

  let acknowledgement;
  try {
    acknowledgement = await jobRegistry.acknowledgeReconciliation(identity);
  } catch {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_acknowledgement_failed', 'Domain activation recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningDomainActivationRecoveryError('job_domain_activation_recovery_acknowledgement_invalid', 'Domain activation recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    status: 'succeeded',
    recoveryMethod: 'verified_domain_activation_receipt_and_active_config',
    reconciled: true,
  });
}

export const jobRunningDomainActivationRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  activationIntent,
  assertReceipt,
});
