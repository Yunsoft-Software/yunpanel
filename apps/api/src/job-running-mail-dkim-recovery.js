import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export class JobRunningMailDkimRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningMailDkimRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_identity_invalid', 'DKIM recovery identity is invalid');
  }
  return Object.freeze({ serverId, jobId });
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering DKIM activation');
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || candidate.operation !== OPERATIONS.MAIL_DKIM_APPLY
    || candidate.resourceType !== 'mail_domain' || typeof candidate.resourceId !== 'string'
    || !UUID_PATTERN.test(candidate.resourceId)) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_job_mismatch', 'Running DKIM recovery metadata is inconsistent');
  }
}

function recoveryIntent(context, job, candidate, identity) {
  const payload = context?.payload;
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.MAIL_DKIM_APPLY || context.resourceType !== 'mail_domain'
    || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 4
    || payload.mailDomainId !== candidate.resourceId || !UUID_PATTERN.test(payload.mailDomainId)
    || !Number.isSafeInteger(payload.expectedKeyRevision) || payload.expectedKeyRevision < 1
    || typeof payload.previewDigest !== 'string' || !CHECKSUM_PATTERN.test(payload.previewDigest)
    || typeof payload.configurationSha256 !== 'string' || !CHECKSUM_PATTERN.test(payload.configurationSha256)) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_context_mismatch', 'Private DKIM recovery context does not match durable job metadata');
  }
  return Object.freeze({ ...payload });
}

function assertReceipt(receipt, identity, intent) {
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId
    || receipt.mailDomainId !== intent.mailDomainId
    || receipt.expectedKeyRevision !== intent.expectedKeyRevision
    || receipt.previewDigest !== intent.previewDigest
    || receipt.configurationSha256 !== intent.configurationSha256
    || receipt.applied !== true) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_receipt_mismatch', 'DKIM operation receipt does not match the running job');
  }
}

export async function recoverRunningMailDkim({
  serverId,
  jobId,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  mailDomainRegistry,
  serviceStatus,
  loadJobContext,
  materializeApply,
  readOperationReceipt,
  inspectActiveEvidence,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function' || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !domainRegistry || !certificateRegistry || !applicationRegistry
    || !mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof materializeApply !== 'function' || typeof readOperationReceipt !== 'function'
    || typeof inspectActiveEvidence !== 'function' || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_dependencies_invalid', 'DKIM recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_inspection_failed', 'Durable DKIM recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_inspection_invalid', 'Durable DKIM recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  assertCandidate(candidate, identity);

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_job_read_failed', 'Running DKIM job could not be read');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.MAIL_DKIM_APPLY || job.resourceType !== 'mail_domain'
    || job.resourceId !== candidate.resourceId) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_job_mismatch', 'Running DKIM job no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_context_failed', 'Private DKIM recovery context could not be read');
  }
  const intent = recoveryIntent(context, job, candidate, identity);

  let receipt;
  try { receipt = await readOperationReceipt(identity.serverId, identity.jobId); }
  catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_receipt_failed', 'DKIM operation receipt could not be read');
  }
  if (!receipt) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_receipt_missing', 'DKIM operation receipt is absent; the running job remains unresolved');
  }
  assertReceipt(receipt, identity, intent);

  let bundle;
  try {
    bundle = await materializeApply({
      mailDomainId: intent.mailDomainId,
      expectedKeyRevision: intent.expectedKeyRevision,
    }, {
      expectedPreviewDigest: intent.previewDigest,
      expectedConfigurationSha256: intent.configurationSha256,
    });
  } catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_materialization_failed', 'Current protected DKIM desired state does not match the recovery intent');
  }
  if (!bundle?.preview || !Array.isArray(bundle.keys) || bundle.keys.length < 1
    || bundle.preview.sha256 !== intent.configurationSha256) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_materialization_invalid', 'DKIM recovery materialization is inconsistent');
  }

  let evidence;
  try { evidence = await inspectActiveEvidence(bundle); }
  catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_evidence_failed', 'Active DKIM host state could not be inspected');
  }
  if (!evidence || evidence.satisfied !== true || !evidence.result
    || evidence.result.previewSha256 !== intent.configurationSha256
    || evidence.result.applied !== true || evidence.result.sideEffects !== true) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_evidence_not_satisfied', 'Active DKIM host state does not match the completed operation');
  }

  const result = Object.freeze({
    version: 1,
    mailDomainId: intent.mailDomainId,
    expectedKeyRevision: intent.expectedKeyRevision,
    previewDigest: intent.previewDigest,
    configurationSha256: intent.configurationSha256,
    applied: true,
    sideEffects: true,
  });

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_journal_failed', 'DKIM recovery journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId
    || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_journal_invalid', 'DKIM recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_completion_failed', 'DKIM evidence was verified but durable completion could not be confirmed');
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.MAIL_DKIM_APPLY
    || terminal.resourceType !== 'mail_domain' || terminal.resourceId !== intent.mailDomainId) {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_completion_invalid', 'DKIM recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({
      domainRegistry,
      certificateRegistry,
      applicationRegistry,
      mailDomainRegistry,
      job: terminal,
    });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_reconciliation_failed', 'DKIM job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_acknowledgement_failed', 'DKIM recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningMailDkimRecoveryError('job_mail_dkim_recovery_acknowledgement_invalid', 'DKIM recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.MAIL_DKIM_APPLY,
    status: 'succeeded',
    recoveryMethod: 'verified_dkim_receipt_and_active_host_state',
    reconciled: true,
  });
}

export const jobRunningMailDkimRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  recoveryIntent,
  assertReceipt,
});
