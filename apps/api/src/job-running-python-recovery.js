import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningPythonRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningPythonRecoveryError';
    this.code = code;
  }
}

// Each kind names the queued operation, the application state the API left
// behind when it stopped, and how the verified receipt becomes a job result.
const KINDS = Object.freeze({
  deployment: Object.freeze({
    operation: OPERATIONS.APP_PYTHON_DEPLOY,
    receiptReader: 'readDeploymentReceipt',
    recoveryMethod: 'verified_python_deployment_receipt_and_status',
    assertContext: (context, jobId) => context.payload?.deploymentId === jobId,
    assertApplication: (application, context, jobId) => application.state === 'deploying' && application.activeDeploymentId === jobId,
    assertReceipt: (receipt, context, jobId, application) => receipt.releaseId === jobId
      && receipt.previousReleaseId === (application.currentReleaseId ?? null),
    result: (receipt, jobId) => ({
      deploymentId: jobId,
      releaseId: receipt.releaseId,
      previousReleaseId: receipt.previousReleaseId,
      commitSha: receipt.commitSha,
      serviceName: receipt.serviceName,
      socketPath: receipt.socketPath,
      port: receipt.port,
      healthPath: receipt.healthPath,
      healthy: true,
    }),
  }),
  rollback: Object.freeze({
    operation: OPERATIONS.APP_PYTHON_ROLLBACK,
    receiptReader: 'readRollbackReceipt',
    recoveryMethod: 'verified_python_rollback_receipt_and_status',
    assertContext: (context) => typeof context.payload?.releaseId === 'string' && typeof context.payload?.currentReleaseId === 'string',
    assertApplication: (application, context, jobId) => application.state === 'rolling_back' && application.activeDeploymentId === jobId
      && application.pendingRollbackReleaseId === context.payload.releaseId && application.currentReleaseId === context.payload.currentReleaseId,
    assertReceipt: (receipt, context) => receipt.releaseId === context.payload.releaseId
      && receipt.previousReleaseId === context.payload.currentReleaseId,
    result: (receipt) => ({
      releaseId: receipt.releaseId,
      previousReleaseId: receipt.previousReleaseId,
      serviceName: receipt.serviceName,
      socketPath: receipt.socketPath,
      port: receipt.port,
      healthPath: receipt.healthPath,
      healthy: true,
      active: true,
    }),
  }),
  restart: Object.freeze({
    operation: OPERATIONS.APP_PYTHON_RESTART,
    receiptReader: 'readRestartReceipt',
    recoveryMethod: 'verified_python_restart_receipt_and_status',
    assertContext: (context) => typeof context.payload?.releaseId === 'string',
    assertApplication: (application, context) => application.state === 'active' && application.activeDeploymentId === null
      && application.currentReleaseId === context.payload.releaseId,
    assertReceipt: (receipt, context) => receipt.releaseId === context.payload.releaseId,
    result: (receipt) => ({
      releaseId: receipt.releaseId,
      serviceName: receipt.serviceName,
      socketPath: receipt.socketPath,
      port: receipt.port,
      healthPath: receipt.healthPath,
      healthy: true,
      restarted: true,
    }),
  }),
});

function fail(kind, reason, message) {
  return new JobRunningPythonRecoveryError(`job_python_${kind}_recovery_${reason}`, message);
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningPythonRecoveryError('job_python_recovery_identity_invalid', 'Python recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch { throw new JobRunningPythonRecoveryError('job_python_recovery_service_status_unavailable', 'Could not verify YunPanel service state'); }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningPythonRecoveryError('job_python_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningPythonRecoveryError('job_python_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a Python operation');
  }
}

function assertLiveStatus(kind, status, receipt) {
  if (!status || status.serviceName !== receipt.serviceName || status.loadState !== 'loaded' || status.activeState !== 'active'
    || status.healthy !== true || status.inspectionError !== false || !Number.isSafeInteger(status.mainPid) || status.mainPid <= 0) {
    throw fail(kind, 'evidence_not_satisfied', `Python service no longer satisfies the recorded ${kind} state`);
  }
}

async function recoverRunningPythonOperation(kind, {
  serverId,
  jobId,
  jobRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  inspectPythonStatus,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
  ...rest
} = {}) {
  const spec = KINDS[kind];
  const readReceipt = rest[spec.receiptReader];
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readReceipt !== 'function' || typeof inspectPythonStatus !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw fail(kind, 'dependencies_invalid', `Python ${kind} recovery dependencies are invalid`);
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch { throw fail(kind, 'inspection_failed', `Durable Python ${kind} recovery state could not be inspected`); }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw fail(kind, 'inspection_invalid', `Durable Python ${kind} recovery state is invalid`);
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== spec.operation
    || candidate.resourceType !== 'application' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw fail(kind, 'job_mismatch', `Running Python ${kind} recovery metadata is inconsistent`);
  }

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch { throw fail(kind, 'job_read_failed', `Running Python ${kind} job could not be read`); }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== spec.operation || job.resourceType !== 'application' || job.resourceId !== candidate.resourceId) {
    throw fail(kind, 'job_mismatch', `Running Python ${kind} no longer matches durable recovery state`);
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch { throw fail(kind, 'context_failed', `Private Python ${kind} context could not be read`); }
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== spec.operation || context.resourceType !== 'application'
    || context.resourceId !== candidate.resourceId || context.payload?.applicationId !== context.resourceId
    || !spec.assertContext(context, identity.jobId)) {
    throw fail(kind, 'context_mismatch', `Private Python ${kind} context does not match durable job metadata`);
  }
  const applicationId = context.payload.applicationId;

  let application;
  try { application = await applicationRegistry.getApplication(applicationId); }
  catch { throw fail(kind, 'application_read_failed', 'Python application state could not be read'); }
  if (!application || application.id !== applicationId || application.serverId !== identity.serverId
    || application.type !== 'python' || !spec.assertApplication(application, context, identity.jobId)) {
    throw fail(kind, 'application_mismatch', `Python application state no longer matches the running ${kind}`);
  }

  let receipt;
  try { receipt = await readReceipt(identity.serverId, identity.jobId); }
  catch { throw fail(kind, 'receipt_failed', `Python ${kind} receipt could not be read`); }
  if (!receipt) {
    throw fail(kind, 'receipt_missing', `Python ${kind} receipt is absent; the running job remains unresolved`);
  }
  if (receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId || receipt.operation !== spec.operation
    || receipt.applicationId !== applicationId || !spec.assertReceipt(receipt, context, identity.jobId, application)) {
    throw fail(kind, 'receipt_mismatch', `Python ${kind} receipt does not match the running job`);
  }

  let status;
  try { status = await inspectPythonStatus({ applicationId, releaseId: receipt.releaseId }); }
  catch { throw fail(kind, 'evidence_failed', `Python ${kind} host state could not be inspected`); }
  assertLiveStatus(kind, status, receipt);

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch { throw fail(kind, 'journal_failed', `Python ${kind} recovery journal could not be opened`); }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw fail(kind, 'journal_invalid', `Python ${kind} recovery journal acknowledgement is inconsistent`);
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result: spec.result(receipt, identity.jobId) }); }
  catch { throw fail(kind, 'completion_failed', `Python ${kind} evidence was verified but durable completion could not be confirmed`); }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded'
    || terminal.operation !== spec.operation || terminal.resourceType !== 'application' || terminal.resourceId !== applicationId) {
    throw fail(kind, 'completion_invalid', `Python ${kind} recovery completion acknowledgement is inconsistent`);
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw fail(kind, 'reconciliation_failed', `Python ${kind} job is terminal but reconciliation remains pending`);
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch { throw fail(kind, 'acknowledgement_failed', `Python ${kind} recovery could not be durably acknowledged`); }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw fail(kind, 'acknowledgement_invalid', `Python ${kind} recovery acknowledgement is inconsistent`);
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: spec.operation,
    applicationId,
    releaseId: receipt.releaseId,
    status: 'succeeded',
    recoveryMethod: spec.recoveryMethod,
    reconciled: true,
  });
}

export function recoverRunningPythonDeployment(input) {
  return recoverRunningPythonOperation('deployment', input);
}

export function recoverRunningPythonRollback(input) {
  return recoverRunningPythonOperation('rollback', input);
}

export function recoverRunningPythonRestart(input) {
  return recoverRunningPythonOperation('restart', input);
}
