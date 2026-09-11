import { isDeepStrictEqual } from 'node:util';
import { OPERATIONS } from '@yunpanel/protocol';
import { normalizeNodeProcessSpec } from '@yunpanel/shared';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningNodeProcessRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningNodeProcessRecoveryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new JobRunningNodeProcessRecoveryError(code, message);
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    fail('job_node_process_recovery_identity_invalid', 'Node process recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch { fail('job_node_process_recovery_service_status_unavailable', 'Could not verify YunPanel service state'); }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    fail('job_node_process_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    fail('job_node_process_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering Node process control');
  }
}

function assertContext(context, job, candidate, identity) {
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.APP_NODE_PROCESS || context.resourceType !== 'application'
    || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId) {
    fail('job_node_process_recovery_context_mismatch', 'Private Node process context does not match durable job metadata');
  }
  try {
    const intent = normalizeNodeProcessSpec(context.payload);
    if (intent.applicationId !== context.resourceId) throw new Error('resource mismatch');
    return intent;
  } catch {
    fail('job_node_process_recovery_context_mismatch', 'Private Node process context does not match durable job metadata');
  }
}

function sameRuntime(left, right) {
  return Boolean(left && right && isDeepStrictEqual(left, right));
}

async function requireApplicationIntent(applicationRegistry, serverId, intent) {
  let application;
  try { application = await applicationRegistry.getApplication(intent.applicationId); }
  catch { fail('job_node_process_recovery_application_read_failed', 'Node application state could not be read'); }
  if (!application || application.id !== intent.applicationId || application.serverId !== serverId || application.type !== 'node'
    || application.state !== 'active' || application.activeDeploymentId !== null
    || application.currentReleaseId !== intent.releaseId || !sameRuntime(application.activeRuntime, intent.runtime)) {
    fail('job_node_process_recovery_application_mismatch', 'Node application state no longer matches the running process operation');
  }
}

function assertLiveState(state, intent) {
  if (!state || state.releaseId !== intent.releaseId || state.action !== intent.action
    || state.port !== intent.runtime.port || state.healthPath !== intent.runtime.healthPath
    || state.loadState !== 'loaded' || typeof state.serviceName !== 'string' || !state.serviceName
    || typeof state.enabled !== 'boolean' || typeof state.active !== 'boolean' || typeof state.healthy !== 'boolean'
    || !Number.isSafeInteger(state.mainPid) || state.mainPid < 0
    || state.enabled !== (state.unitFileState === 'enabled') || state.active !== (state.activeState === 'active')) {
    fail('job_node_process_recovery_evidence_not_satisfied', 'Node service state does not prove the requested process operation');
  }
  if ((intent.action === 'enable' && !state.enabled)
    || (intent.action === 'disable' && state.unitFileState !== 'disabled')
    || (intent.action === 'start' && (!state.active || !state.healthy || state.mainPid < 1))
    || (intent.action === 'stop' && (state.activeState !== 'inactive' || state.healthy || state.mainPid !== 0))) {
    fail('job_node_process_recovery_evidence_not_satisfied', 'Node service state does not prove the requested process operation');
  }
}

export async function recoverRunningNodeProcess({
  serverId,
  jobId,
  jobRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  inspectNodeProcess,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof inspectNodeProcess !== 'function' || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    fail('job_node_process_recovery_dependencies_invalid', 'Node process recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch { fail('job_node_process_recovery_inspection_failed', 'Durable Node process recovery state could not be inspected'); }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    fail('job_node_process_recovery_inspection_invalid', 'Durable Node process recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== OPERATIONS.APP_NODE_PROCESS
    || candidate.resourceType !== 'application' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    fail('job_node_process_recovery_job_mismatch', 'Running Node process recovery metadata is inconsistent');
  }

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch { fail('job_node_process_recovery_job_read_failed', 'Running Node process job could not be read'); }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.APP_NODE_PROCESS || job.resourceType !== 'application' || job.resourceId !== candidate.resourceId) {
    fail('job_node_process_recovery_job_mismatch', 'Running Node process job no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch { fail('job_node_process_recovery_context_failed', 'Private Node process context could not be read'); }
  const intent = assertContext(context, job, candidate, identity);
  await requireApplicationIntent(applicationRegistry, identity.serverId, intent);

  let state;
  try { state = await inspectNodeProcess(intent); }
  catch { fail('job_node_process_recovery_evidence_failed', 'Node process host state could not be inspected'); }
  assertLiveState(state, intent);
  const result = {
    releaseId: state.releaseId,
    serviceName: state.serviceName,
    port: state.port,
    healthPath: state.healthPath,
    action: state.action,
    loadState: state.loadState,
    activeState: state.activeState,
    subState: state.subState,
    unitFileState: state.unitFileState,
    mainPid: state.mainPid,
    enabled: state.enabled,
    active: state.active,
    healthy: state.healthy,
  };

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch { fail('job_node_process_recovery_journal_failed', 'Node process recovery journal could not be opened'); }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    fail('job_node_process_recovery_journal_invalid', 'Node process recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch { fail('job_node_process_recovery_completion_failed', 'Node process evidence was verified but durable completion could not be confirmed'); }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded'
    || terminal.operation !== OPERATIONS.APP_NODE_PROCESS || terminal.resourceType !== 'application' || terminal.resourceId !== intent.applicationId) {
    fail('job_node_process_recovery_completion_invalid', 'Node process recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    fail('job_node_process_recovery_reconciliation_failed', 'Node process job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch { fail('job_node_process_recovery_acknowledgement_failed', 'Node process recovery could not be durably acknowledged'); }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    fail('job_node_process_recovery_acknowledgement_invalid', 'Node process recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.APP_NODE_PROCESS,
    applicationId: intent.applicationId,
    releaseId: intent.releaseId,
    action: intent.action,
    status: 'succeeded',
    recoveryMethod: 'verified_node_process_state',
    reconciled: true,
  });
}

export const jobRunningNodeProcessRecoveryInternals = Object.freeze({
  normalizeIdentity, requireStoppedConsumers, assertContext, sameRuntime, requireApplicationIntent, assertLiveState,
});
