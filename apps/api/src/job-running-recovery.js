import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_REEXECUTION = Object.freeze({
  [OPERATIONS.SYSTEM_PACKAGES_INSPECT]: Object.freeze({ resourceType: 'system', resourceScope: 'server', payloadMode: 'empty' }),
  [OPERATIONS.SYSTEM_SERVICES_INSPECT]: Object.freeze({ resourceType: 'system', resourceScope: 'server', payloadMode: 'persisted' }),
  [OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT]: Object.freeze({ resourceType: 'system', resourceScope: 'server', payloadMode: 'empty' }),
  [OPERATIONS.DATABASE_INSPECT]: Object.freeze({ resourceType: 'database', resourceScope: 'server', payloadMode: 'empty' }),
  [OPERATIONS.APP_NODE_STATUS]: Object.freeze({ resourceType: 'application', resourceScope: 'resource', payloadMode: 'persisted' }),
});

export class JobRunningRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningRecoveryError('job_running_recovery_identity_invalid', 'Running recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRunningRecoveryError('job_running_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningRecoveryError('job_running_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningRecoveryError('job_running_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a running job');
  }
}

function recoveryPolicy(job) {
  const policy = SAFE_REEXECUTION[job.operation] ?? null;
  if (!policy) {
    throw new JobRunningRecoveryError(
      'job_running_recovery_operation_unsafe',
      'This running operation cannot be recovered by automatic re-execution',
    );
  }
  if (job.resourceType !== policy.resourceType
    || (policy.resourceScope === 'server' && job.resourceId !== job.serverId)
    || (policy.resourceScope === 'resource' && (typeof job.resourceId !== 'string' || !job.resourceId))) {
    throw new JobRunningRecoveryError('job_running_recovery_job_mismatch', 'Running recovery job metadata is inconsistent');
  }
  return policy;
}

async function recoveryPayload(job, policy, loadJobContext) {
  if (policy.payloadMode === 'empty') return {};
  if (typeof loadJobContext !== 'function') {
    throw new JobRunningRecoveryError('job_running_recovery_context_unavailable', 'Private running recovery context is required for this read-only operation');
  }

  let context;
  try {
    context = await loadJobContext(job.id);
  } catch {
    throw new JobRunningRecoveryError('job_running_recovery_context_failed', 'Private running recovery context could not be read');
  }
  if (!context || context.id !== job.id || context.serverId !== job.serverId || context.status !== 'running'
    || context.operation !== job.operation || context.resourceType !== job.resourceType || context.resourceId !== job.resourceId
    || !context.payload || typeof context.payload !== 'object' || Array.isArray(context.payload)) {
    throw new JobRunningRecoveryError('job_running_recovery_context_mismatch', 'Private running recovery context does not match durable job metadata');
  }
  if (job.operation === OPERATIONS.APP_NODE_STATUS && context.payload.applicationId !== job.resourceId) {
    throw new JobRunningRecoveryError('job_running_recovery_context_mismatch', 'Node status recovery context does not match the application resource');
  }

  try {
    return structuredClone(context.payload);
  } catch {
    throw new JobRunningRecoveryError('job_running_recovery_context_mismatch', 'Private running recovery payload could not be copied safely');
  }
}

export async function recoverRunningInspection({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  executeOperation,
  loadJobContext = null,
  inspect = inspectDurableJobRecovery,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.complete !== 'function'
    || typeof serviceStatus !== 'function'
    || typeof executeOperation !== 'function'
    || typeof inspect !== 'function') {
    throw new JobRunningRecoveryError('job_running_recovery_dependencies_invalid', 'Running recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRunningRecoveryError('job_running_recovery_inspection_failed', 'Durable running recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningRecoveryError('job_running_recovery_inspection_invalid', 'Durable running recovery state is invalid');
  }

  const candidate = inspection.jobs.find((job) => job.jobId === identity.jobId && job.serverId === identity.serverId) ?? null;
  if (!candidate) throw new JobRunningRecoveryError('job_running_recovery_job_not_found', 'Requested running job is not present in durable recovery state');
  if (candidate.status !== 'running') {
    throw new JobRunningRecoveryError('job_running_recovery_not_running', 'Only running recovery jobs can use safe re-execution');
  }
  recoveryPolicy(candidate);

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRunningRecoveryError('job_running_recovery_job_read_failed', 'Running recovery job could not be read from durable state');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== candidate.operation || job.resourceType !== candidate.resourceType || job.resourceId !== candidate.resourceId) {
    throw new JobRunningRecoveryError('job_running_recovery_job_mismatch', 'Running recovery job no longer matches durable recovery state');
  }
  const policy = recoveryPolicy(job);
  const payload = await recoveryPayload(job, policy, loadJobContext);

  let result;
  try {
    result = await executeOperation(job.operation, payload);
  } catch {
    throw new JobRunningRecoveryError(
      'job_running_recovery_probe_failed',
      'Safe host inspection could not be repeated; the original running job remains unresolved',
    );
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({
      serverId: identity.serverId,
      jobId: identity.jobId,
      status: 'succeeded',
      result,
    });
  } catch {
    throw new JobRunningRecoveryError(
      'job_running_recovery_completion_failed',
      'Repeated inspection succeeded but its durable completion could not be confirmed',
    );
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded') {
    throw new JobRunningRecoveryError('job_running_recovery_completion_invalid', 'Running recovery completion acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: job.operation,
    status: 'succeeded',
    recoveryMethod: 'safe_read_only_reexecution',
  });
}

export const jobRunningRecoveryInternals = Object.freeze({
  safeReexecutionOperations: Object.freeze(Object.keys(SAFE_REEXECUTION)),
  normalizeIdentity,
  requireStoppedConsumers,
  recoveryPolicy,
  recoveryPayload,
});
