import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class JobRunningCronRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningCronRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningCronRecoveryError('job_cron_recovery_identity_invalid', 'Cron recovery identity is invalid');
  }
  return Object.freeze({ serverId, jobId });
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch {
    throw new JobRunningCronRecoveryError('job_cron_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningCronRecoveryError('job_cron_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningCronRecoveryError(
      'job_cron_recovery_consumers_must_be_stopped',
      'Stop YunPanel API and legacy agent before recovering cron operations',
    );
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running'
    || ![OPERATIONS.CRON_APPLY, OPERATIONS.CRON_REMOVE].includes(candidate.operation)
    || candidate.resourceType !== 'website_cron') {
    throw new JobRunningCronRecoveryError('job_cron_recovery_job_mismatch', 'Running cron recovery metadata is inconsistent');
  }
}

export async function recoverRunningCron({
  serverId,
  jobId,
  jobRegistry,
  websiteCronRegistry,
  websiteCronManager,
  readOperationReceipt,
  serviceStatus,
  loadJobContext,
  inspect = inspectDurableJobRecovery,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function' || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !websiteCronRegistry || !websiteCronManager
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readOperationReceipt !== 'function' || typeof inspect !== 'function') {
    throw new JobRunningCronRecoveryError('job_cron_recovery_dependencies_invalid', 'Cron recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch {
    throw new JobRunningCronRecoveryError('job_cron_recovery_inspection_failed', 'Durable cron recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningCronRecoveryError('job_cron_recovery_inspection_invalid', 'Durable cron recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  assertCandidate(candidate, identity);

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch {
    throw new JobRunningCronRecoveryError('job_cron_recovery_job_read_failed', 'Running cron job could not be read');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || ![OPERATIONS.CRON_APPLY, OPERATIONS.CRON_REMOVE].includes(job.operation)
    || job.resourceType !== 'website_cron') {
    throw new JobRunningCronRecoveryError('job_cron_recovery_job_mismatch', 'Running cron job no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch {
    throw new JobRunningCronRecoveryError('job_cron_recovery_context_failed', 'Running cron context could not be read');
  }
  if (context && context.id && context.id !== identity.jobId) {
    throw new JobRunningCronRecoveryError('job_cron_recovery_job_mismatch', 'Running cron context does not match identity');
  }

  let receipt;
  try { receipt = await readOperationReceipt(identity.serverId, identity.jobId); }
  catch {
    throw new JobRunningCronRecoveryError('job_cron_recovery_receipt_failed', 'Cron operation receipt could not be read');
  }
  if (!receipt) {
    throw new JobRunningCronRecoveryError(
      'job_cron_recovery_receipt_missing',
      'Cron operation receipt is absent; the running job remains unresolved',
    );
  }

  if ((receipt.operation && receipt.operation !== job.operation)
    || (receipt.serverId && receipt.serverId.toLowerCase() !== identity.serverId.toLowerCase())
    || (receipt.jobId && receipt.jobId !== identity.jobId)
    || (job.resourceId && receipt.result?.taskId && job.resourceId !== receipt.result.taskId)) {
    throw new JobRunningCronRecoveryError('job_cron_recovery_job_mismatch', 'Running cron receipt metadata is inconsistent');
  }

  if (context?.payload && receipt.result) {
    if ((context.payload.taskId && context.payload.taskId !== receipt.result.taskId)
      || (context.payload.websiteId && context.payload.websiteId !== receipt.result.websiteId)
      || (context.payload.applicationId && context.payload.applicationId !== receipt.result.applicationId)
      || (context.payload.unixUser && context.payload.unixUser !== receipt.result.unixUser)
      || (context.payload.expectedRevision && context.payload.expectedRevision !== receipt.result.revision)) {
      throw new JobRunningCronRecoveryError('job_cron_recovery_job_mismatch', 'Running cron receipt evidence does not match job context');
    }
  }

  if (typeof websiteCronManager.listManagedFiles === 'function') {
    let hostInventory;
    try { hostInventory = await websiteCronManager.listManagedFiles(); }
    catch {
      throw new JobRunningCronRecoveryError('job_cron_recovery_host_state_failed', 'Cron host files could not be inspected');
    }
    const hostFile = hostInventory?.files?.find((file) => file.taskId === receipt.result.taskId) ?? null;
    if (job.operation === OPERATIONS.CRON_APPLY) {
      if (!hostFile || (receipt.result.contentSha256 && hostFile.contentSha256 !== receipt.result.contentSha256)) {
        throw new JobRunningCronRecoveryError('job_cron_recovery_host_state_mismatch', 'Host cron configuration does not match apply receipt');
      }
    } else if (job.operation === OPERATIONS.CRON_REMOVE) {
      if (hostFile !== null) {
        throw new JobRunningCronRecoveryError('job_cron_recovery_host_state_mismatch', 'Host cron configuration still present despite remove receipt');
      }
    }
  }

  if (typeof websiteCronRegistry.getTask === 'function') {
    let task;
    try { task = await websiteCronRegistry.getTask(receipt.result.taskId); }
    catch {
      throw new JobRunningCronRecoveryError('job_cron_recovery_registry_read_failed', 'Cron task registry could not be read');
    }
    if (job.operation === OPERATIONS.CRON_APPLY) {
      if (!task || task.id !== receipt.result.taskId || task.websiteId !== receipt.result.websiteId) {
        throw new JobRunningCronRecoveryError('job_cron_recovery_registry_mismatch', 'Cron registry state does not match apply receipt');
      }
    } else if (job.operation === OPERATIONS.CRON_REMOVE) {
      if (task !== null) {
        throw new JobRunningCronRecoveryError('job_cron_recovery_registry_mismatch', 'Cron registry state still present despite remove receipt');
      }
    }
  }

  const terminalField = job.operation === OPERATIONS.CRON_APPLY ? 'applied' : 'removed';
  const result = Object.freeze({
    version: 1,
    taskId: receipt.result.taskId,
    websiteId: receipt.result.websiteId,
    applicationId: receipt.result.applicationId,
    unixUser: receipt.result.unixUser,
    revision: receipt.result.revision,
    desiredStateSha256: receipt.result.desiredStateSha256,
    contentSha256: receipt.result.contentSha256,
    [terminalField]: true,
    sideEffects: receipt.result.sideEffects,
  });

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch {
    throw new JobRunningCronRecoveryError('job_cron_recovery_journal_failed', 'Cron recovery journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId
    || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningCronRecoveryError('job_cron_recovery_journal_invalid', 'Cron recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch {
    throw new JobRunningCronRecoveryError(
      'job_cron_recovery_completion_failed',
      'Cron evidence was verified but durable completion could not be confirmed',
    );
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch {
    throw new JobRunningCronRecoveryError(
      'job_cron_recovery_acknowledgement_failed',
      'Cron recovery reconciliation could not be durably acknowledged',
    );
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true) {
    throw new JobRunningCronRecoveryError('job_cron_recovery_acknowledgement_invalid', 'Cron recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: job.operation,
    status: 'succeeded',
    recoveryMethod: 'verified_cron_receipt_and_host_state',
    reconciled: true,
  });
}

export const jobRunningCronRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
});
