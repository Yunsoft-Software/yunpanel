import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningNodeRestartRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningNodeRestartRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_identity_invalid', 'Node restart recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_service_status_unavailable', 'Could not verify YunPanel service state'); }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a Node restart');
  }
}

function assertContext(context, job, candidate, identity) {
  const runtime = context?.payload?.runtime;
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.APP_NODE_RESTART || context.resourceType !== 'application'
    || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || context.payload?.applicationId !== context.resourceId
    || typeof context.payload?.releaseId !== 'string' || !context.payload.releaseId
    || !runtime || typeof runtime !== 'object' || Array.isArray(runtime)
    || !Number.isInteger(runtime.port) || typeof runtime.healthPath !== 'string') {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_context_mismatch', 'Private Node restart context does not match durable job metadata');
  }
  return { applicationId: context.payload.applicationId, releaseId: context.payload.releaseId, runtime };
}

async function requireApplicationIntent(applicationRegistry, serverId, intent) {
  let application;
  try { application = await applicationRegistry.getApplication(intent.applicationId); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_application_read_failed', 'Node application state could not be read'); }
  if (!application || application.id !== intent.applicationId || application.serverId !== serverId || application.type !== 'node'
    || application.state !== 'active' || application.activeDeploymentId !== null || application.currentReleaseId !== intent.releaseId
    || application.runtime?.port !== intent.runtime.port || application.runtime?.healthPath !== intent.runtime.healthPath) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_application_mismatch', 'Node application state no longer matches the running restart');
  }
}

function assertReceipt(receipt, identity, intent) {
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId
    || receipt.applicationId !== intent.applicationId || receipt.releaseId !== intent.releaseId
    || receipt.port !== intent.runtime.port || receipt.healthPath !== intent.runtime.healthPath
    || typeof receipt.serviceName !== 'string' || !receipt.serviceName) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_receipt_mismatch', 'Node restart receipt does not match the running job');
  }
}

function assertLiveStatus(status, receipt) {
  if (!status || status.releaseId !== receipt.releaseId || status.serviceName !== receipt.serviceName
    || status.port !== receipt.port || status.healthPath !== receipt.healthPath
    || status.loadState !== 'loaded' || status.activeState !== 'active' || status.healthy !== true
    || status.inspectionError !== false || !Number.isSafeInteger(status.mainPid) || status.mainPid <= 0) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_evidence_not_satisfied', 'Node service no longer satisfies the recorded restart state');
  }
}

export async function recoverRunningNodeRestart({
  serverId,
  jobId,
  jobRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  readRestartReceipt,
  inspectNodeStatus,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readRestartReceipt !== 'function' || typeof inspectNodeStatus !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_dependencies_invalid', 'Node restart recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_inspection_failed', 'Durable Node restart recovery state could not be inspected'); }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_inspection_invalid', 'Durable Node restart recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== OPERATIONS.APP_NODE_RESTART
    || candidate.resourceType !== 'application' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_job_mismatch', 'Running Node restart recovery metadata is inconsistent');
  }

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_job_read_failed', 'Running Node restart job could not be read'); }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.APP_NODE_RESTART || job.resourceType !== 'application' || job.resourceId !== candidate.resourceId) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_job_mismatch', 'Running Node restart no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_context_failed', 'Private Node restart context could not be read'); }
  const intent = assertContext(context, job, candidate, identity);
  await requireApplicationIntent(applicationRegistry, identity.serverId, intent);

  let receipt;
  try { receipt = await readRestartReceipt(identity.serverId, identity.jobId); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_receipt_failed', 'Node restart receipt could not be read'); }
  if (!receipt) throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_receipt_missing', 'Node restart receipt is absent; the running job remains unresolved');
  assertReceipt(receipt, identity, intent);

  let status;
  try { status = await inspectNodeStatus(intent); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_evidence_failed', 'Node restart host state could not be inspected'); }
  assertLiveStatus(status, receipt);

  const result = {
    releaseId: receipt.releaseId,
    serviceName: receipt.serviceName,
    port: receipt.port,
    healthPath: receipt.healthPath,
    healthy: true,
    restarted: true,
  };

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_journal_failed', 'Node restart recovery journal could not be opened'); }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_journal_invalid', 'Node restart recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_completion_failed', 'Node restart evidence was verified but durable completion could not be confirmed'); }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded'
    || terminal.operation !== OPERATIONS.APP_NODE_RESTART || terminal.resourceType !== 'application' || terminal.resourceId !== intent.applicationId) {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_completion_invalid', 'Node restart recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_reconciliation_failed', 'Node restart job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch { throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_acknowledgement_failed', 'Node restart recovery could not be durably acknowledged'); }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningNodeRestartRecoveryError('job_node_restart_recovery_acknowledgement_invalid', 'Node restart recovery acknowledgement is inconsistent');
  }

  return Object.freeze({ serverId: identity.serverId, jobId: identity.jobId, operation: OPERATIONS.APP_NODE_RESTART,
    applicationId: intent.applicationId, releaseId: intent.releaseId, status: 'succeeded',
    recoveryMethod: 'verified_node_restart_receipt_and_status', reconciled: true });
}

export const jobRunningNodeRestartRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertContext,
  requireApplicationIntent,
  assertReceipt,
  assertLiveStatus,
});
