import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class JobRunningRoundcubeConfigRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningRoundcubeConfigRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_identity_invalid', 'Roundcube recovery identity is invalid');
  }
  return Object.freeze({ serverId, jobId });
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningRoundcubeConfigRecoveryError(
      'job_roundcube_recovery_consumers_must_be_stopped',
      'Stop YunPanel API and legacy agent before recovering Roundcube activation',
    );
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || candidate.operation !== OPERATIONS.ROUNDCUBE_CONFIG_APPLY
    || candidate.resourceType !== 'server' || candidate.resourceId !== identity.serverId) {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_job_mismatch', 'Running Roundcube recovery metadata is inconsistent');
  }
}

function recoveryIntent(context, job, candidate, identity) {
  const payload = context?.payload;
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.ROUNDCUBE_CONFIG_APPLY || context.resourceType !== 'server'
    || context.resourceId !== identity.serverId || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 3
    || typeof payload.previewSha256 !== 'string' || !SHA256_PATTERN.test(payload.previewSha256)
    || typeof payload.configSha256 !== 'string' || !SHA256_PATTERN.test(payload.configSha256)
    || typeof payload.fpmSha256 !== 'string' || !SHA256_PATTERN.test(payload.fpmSha256)) {
    throw new JobRunningRoundcubeConfigRecoveryError(
      'job_roundcube_recovery_context_mismatch',
      'Private Roundcube recovery context does not match durable job metadata',
    );
  }
  return Object.freeze({ ...payload });
}

function assertReceipt(receipt, identity, intent) {
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId
    || receipt.previewSha256 !== intent.previewSha256
    || receipt.configSha256 !== intent.configSha256
    || receipt.fpmSha256 !== intent.fpmSha256
    || typeof receipt.databaseCreated !== 'boolean' || receipt.applied !== true) {
    throw new JobRunningRoundcubeConfigRecoveryError(
      'job_roundcube_recovery_receipt_mismatch',
      'Roundcube operation receipt does not match the running job',
    );
  }
}

export async function recoverRunningRoundcubeConfig({
  serverId,
  jobId,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  materializeConfiguration,
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
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof materializeConfiguration !== 'function' || typeof readOperationReceipt !== 'function'
    || typeof inspectActiveEvidence !== 'function' || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_dependencies_invalid', 'Roundcube recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_inspection_failed', 'Durable Roundcube recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_inspection_invalid', 'Durable Roundcube recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  assertCandidate(candidate, identity);

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_job_read_failed', 'Running Roundcube job could not be read');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.ROUNDCUBE_CONFIG_APPLY || job.resourceType !== 'server'
    || job.resourceId !== identity.serverId) {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_job_mismatch', 'Running Roundcube job no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_context_failed', 'Private Roundcube recovery context could not be read');
  }
  const intent = recoveryIntent(context, job, candidate, identity);

  let receipt;
  try { receipt = await readOperationReceipt(identity.serverId, identity.jobId); }
  catch {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_receipt_failed', 'Roundcube operation receipt could not be read');
  }
  if (!receipt) {
    throw new JobRunningRoundcubeConfigRecoveryError(
      'job_roundcube_recovery_receipt_missing',
      'Roundcube operation receipt is absent; the running job remains unresolved',
    );
  }
  assertReceipt(receipt, identity, intent);

  let bundle;
  try {
    bundle = await materializeConfiguration(identity.serverId, { expectedPreviewSha256: intent.previewSha256 });
  } catch {
    throw new JobRunningRoundcubeConfigRecoveryError(
      'job_roundcube_recovery_materialization_failed',
      'Current protected Roundcube desired state does not match the recovery intent',
    );
  }
  if (!bundle?.preview || bundle.preview.sha256 !== intent.previewSha256
    || bundle.preview.configSha256 !== intent.configSha256 || bundle.preview.fpmSha256 !== intent.fpmSha256
    || typeof bundle.preview.nginxSha256 !== 'string' || !SHA256_PATTERN.test(bundle.preview.nginxSha256)) {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_materialization_invalid', 'Roundcube recovery materialization is inconsistent');
  }

  let evidence;
  try { evidence = await inspectActiveEvidence(bundle.preview); }
  catch {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_evidence_failed', 'Active Roundcube host state could not be inspected');
  }
  if (!evidence || evidence.satisfied !== true || !evidence.result
    || evidence.result.previewSha256 !== intent.previewSha256
    || evidence.result.configSha256 !== intent.configSha256
    || evidence.result.fpmSha256 !== intent.fpmSha256
    || evidence.result.nginxSha256 !== bundle.preview.nginxSha256
    || evidence.result.databaseHealthy !== true || evidence.result.httpHealthy !== true
    || evidence.result.applied !== true || evidence.result.sideEffects !== true) {
    throw new JobRunningRoundcubeConfigRecoveryError(
      'job_roundcube_recovery_evidence_not_satisfied',
      'Active Roundcube host state does not match the completed operation',
    );
  }

  const result = Object.freeze({
    version: 1,
    previewSha256: intent.previewSha256,
    configSha256: intent.configSha256,
    fpmSha256: intent.fpmSha256,
    nginxSha256: bundle.preview.nginxSha256,
    databaseCreated: receipt.databaseCreated,
    httpHealthy: true,
    applied: true,
    sideEffects: true,
  });

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_journal_failed', 'Roundcube recovery journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId
    || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_journal_invalid', 'Roundcube recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch {
    throw new JobRunningRoundcubeConfigRecoveryError(
      'job_roundcube_recovery_completion_failed',
      'Roundcube evidence was verified but durable completion could not be confirmed',
    );
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.ROUNDCUBE_CONFIG_APPLY
    || terminal.resourceType !== 'server' || terminal.resourceId !== identity.serverId) {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_completion_invalid', 'Roundcube recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry, certificateRegistry, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningRoundcubeConfigRecoveryError(
      'job_roundcube_recovery_reconciliation_failed',
      'Roundcube job is terminal but reconciliation remains pending',
    );
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch {
    throw new JobRunningRoundcubeConfigRecoveryError(
      'job_roundcube_recovery_acknowledgement_failed',
      'Roundcube recovery reconciliation could not be durably acknowledged',
    );
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningRoundcubeConfigRecoveryError('job_roundcube_recovery_acknowledgement_invalid', 'Roundcube recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
    status: 'succeeded',
    recoveryMethod: 'verified_roundcube_receipt_and_active_host_state',
    reconciled: true,
  });
}

export const jobRunningRoundcubeConfigRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  recoveryIntent,
  assertReceipt,
});