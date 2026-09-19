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

export async function recoverRunningPythonDeployment({
  serverId,
  jobId,
  jobRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  readDeploymentReceipt,
  inspectPythonStatus,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readDeploymentReceipt !== 'function' || typeof inspectPythonStatus !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_dependencies_invalid', 'Python deployment recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch { throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_inspection_failed', 'Durable Python deployment recovery state could not be inspected'); }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_inspection_invalid', 'Durable Python deployment recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== OPERATIONS.APP_PYTHON_DEPLOY
    || candidate.resourceType !== 'application' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_job_mismatch', 'Running Python deployment recovery metadata is inconsistent');
  }

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_job_read_failed', 'Running Python deployment job could not be read'); }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.APP_PYTHON_DEPLOY || job.resourceType !== 'application' || job.resourceId !== candidate.resourceId) {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_job_mismatch', 'Running Python deployment no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_context_failed', 'Private Python deployment context could not be read'); }
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.APP_PYTHON_DEPLOY || context.resourceType !== 'application'
    || context.resourceId !== candidate.resourceId
    || context.payload?.applicationId !== context.resourceId || context.payload?.deploymentId !== identity.jobId) {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_context_mismatch', 'Private Python deployment context does not match durable job metadata');
  }

  let application;
  try { application = await applicationRegistry.getApplication(context.payload.applicationId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_application_read_failed', 'Python application state could not be read'); }
  if (!application || application.id !== context.payload.applicationId || application.serverId !== identity.serverId
    || application.type !== 'python' || application.state !== 'deploying' || application.activeDeploymentId !== identity.jobId) {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_application_mismatch', 'Python application state no longer matches the running deployment');
  }

  let receipt;
  try { receipt = await readDeploymentReceipt(identity.serverId, identity.jobId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_receipt_failed', 'Python deployment receipt could not be read'); }
  if (!receipt) {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_receipt_missing', 'Python deployment receipt is absent; the running job remains unresolved');
  }

  const result = {
    deploymentId: identity.jobId,
    releaseId: receipt.releaseId,
    previousReleaseId: receipt.previousReleaseId ?? null,
    commitSha: receipt.commitSha,
    serviceName: receipt.serviceName,
    socketPath: receipt.socketPath ?? null,
    port: receipt.port ?? null,
    healthy: true,
  };

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch { throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_journal_failed', 'Python deployment recovery journal could not be opened'); }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_journal_invalid', 'Python deployment recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch { throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_completion_failed', 'Python deployment evidence was verified but durable completion could not be confirmed'); }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_reconciliation_failed', 'Python deployment job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch { throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_acknowledgement_failed', 'Python deployment recovery could not be durably acknowledged'); }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId) {
    throw new JobRunningPythonRecoveryError('job_python_deployment_recovery_acknowledgement_invalid', 'Python deployment recovery acknowledgement is inconsistent');
  }

  return Object.freeze({ jobId: identity.jobId, serverId: identity.serverId, status: 'succeeded', recovered: true });
}

export async function recoverRunningPythonRollback({
  serverId,
  jobId,
  jobRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  readRollbackReceipt,
  inspectPythonStatus,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readRollbackReceipt !== 'function' || typeof inspectPythonStatus !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_dependencies_invalid', 'Python rollback recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch { throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_inspection_failed', 'Durable Python rollback recovery state could not be inspected'); }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_inspection_invalid', 'Durable Python rollback recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== OPERATIONS.APP_PYTHON_ROLLBACK
    || candidate.resourceType !== 'application' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_job_mismatch', 'Running Python rollback recovery metadata is inconsistent');
  }

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_job_read_failed', 'Running Python rollback job could not be read'); }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.APP_PYTHON_ROLLBACK || job.resourceType !== 'application' || job.resourceId !== candidate.resourceId) {
    throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_job_mismatch', 'Running Python rollback no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_context_failed', 'Private Python rollback context could not be read'); }
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.APP_PYTHON_ROLLBACK || context.resourceType !== 'application'
    || context.resourceId !== candidate.resourceId
    || context.payload?.applicationId !== context.resourceId) {
    throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_context_mismatch', 'Private Python rollback context does not match durable job metadata');
  }

  let receipt;
  try { receipt = await readRollbackReceipt(identity.serverId, identity.jobId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_receipt_failed', 'Python rollback receipt could not be read'); }
  if (!receipt) {
    throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_receipt_missing', 'Python rollback receipt is absent; the running job remains unresolved');
  }

  const result = {
    releaseId: receipt.releaseId,
    previousReleaseId: receipt.previousReleaseId ?? null,
    commitSha: receipt.commitSha,
    serviceName: receipt.serviceName,
    socketPath: receipt.socketPath ?? null,
    port: receipt.port ?? null,
    healthy: true,
  };

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch { throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_journal_failed', 'Python rollback recovery journal could not be opened'); }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch { throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_completion_failed', 'Python rollback evidence was verified but durable completion could not be confirmed'); }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_reconciliation_failed', 'Python rollback job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch { throw new JobRunningPythonRecoveryError('job_python_rollback_recovery_acknowledgement_failed', 'Python rollback recovery could not be durably acknowledged'); }

  return Object.freeze({ jobId: identity.jobId, serverId: identity.serverId, status: 'succeeded', recovered: true });
}

export async function recoverRunningPythonRestart({
  serverId,
  jobId,
  jobRegistry,
  applicationRegistry,
  serviceStatus,
  loadJobContext,
  readRestartReceipt,
  inspectPythonStatus,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function' || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readRestartReceipt !== 'function' || typeof inspectPythonStatus !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningPythonRecoveryError('job_python_restart_recovery_dependencies_invalid', 'Python restart recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch { throw new JobRunningPythonRecoveryError('job_python_restart_recovery_inspection_failed', 'Durable Python restart recovery state could not be inspected'); }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningPythonRecoveryError('job_python_restart_recovery_inspection_invalid', 'Durable Python restart recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.operation !== OPERATIONS.APP_PYTHON_RESTART
    || candidate.resourceType !== 'application' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningPythonRecoveryError('job_python_restart_recovery_job_mismatch', 'Running Python restart recovery metadata is inconsistent');
  }

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_restart_recovery_job_read_failed', 'Running Python restart job could not be read'); }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.APP_PYTHON_RESTART || job.resourceType !== 'application' || job.resourceId !== candidate.resourceId) {
    throw new JobRunningPythonRecoveryError('job_python_restart_recovery_job_mismatch', 'Running Python restart no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_restart_recovery_context_failed', 'Private Python restart context could not be read'); }
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.APP_PYTHON_RESTART || context.resourceType !== 'application'
    || context.resourceId !== candidate.resourceId
    || context.payload?.applicationId !== context.resourceId) {
    throw new JobRunningPythonRecoveryError('job_python_restart_recovery_context_mismatch', 'Private Python restart context does not match durable job metadata');
  }

  let receipt;
  try { receipt = await readRestartReceipt(identity.serverId, identity.jobId); }
  catch { throw new JobRunningPythonRecoveryError('job_python_restart_recovery_receipt_failed', 'Python restart receipt could not be read'); }
  if (!receipt) {
    throw new JobRunningPythonRecoveryError('job_python_restart_recovery_receipt_missing', 'Python restart receipt is absent; the running job remains unresolved');
  }

  const result = {
    releaseId: receipt.releaseId,
    serviceName: receipt.serviceName,
    socketPath: receipt.socketPath ?? null,
    port: receipt.port ?? null,
    healthy: true,
  };

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch { throw new JobRunningPythonRecoveryError('job_python_restart_recovery_journal_failed', 'Python restart recovery journal could not be opened'); }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch { throw new JobRunningPythonRecoveryError('job_python_restart_recovery_completion_failed', 'Python restart evidence was verified but durable completion could not be confirmed'); }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningPythonRecoveryError('job_python_restart_recovery_reconciliation_failed', 'Python restart job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch { throw new JobRunningPythonRecoveryError('job_python_restart_recovery_acknowledgement_failed', 'Python restart recovery could not be durably acknowledged'); }

  return Object.freeze({ jobId: identity.jobId, serverId: identity.serverId, status: 'succeeded', recovered: true });
}
