import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

export class JobRecoveryCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRecoveryCommandError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRecoveryCommandError('job_recovery_identity_invalid', 'Recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRecoveryCommandError('job_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRecoveryCommandError('job_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRecoveryCommandError('job_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before reconciling durable recovery state');
  }
  return status;
}

export async function reconcileTerminalRecovery({
  serverId,
  jobId,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  serviceStatus,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || typeof inspect !== 'function'
    || typeof reconcile !== 'function'
    || typeof serviceStatus !== 'function') {
    throw new JobRecoveryCommandError('job_recovery_dependencies_invalid', 'Recovery command dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRecoveryCommandError('job_recovery_inspection_failed', 'Durable recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRecoveryCommandError('job_recovery_inspection_invalid', 'Durable recovery state is invalid');
  }

  const candidate = inspection.jobs.find((job) => job.jobId === identity.jobId && job.serverId === identity.serverId) ?? null;
  if (!candidate) throw new JobRecoveryCommandError('job_recovery_job_not_found', 'Requested recovery job is not present in durable recovery state');
  if (candidate.status === 'running') {
    throw new JobRecoveryCommandError('job_recovery_execution_state_unknown', 'Running recovery jobs require host-state investigation and cannot be reconciled automatically');
  }
  if (!TERMINAL_STATUSES.has(candidate.status)) {
    throw new JobRecoveryCommandError('job_recovery_job_not_terminal', 'Only terminal recovery jobs can be reconciled');
  }

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRecoveryCommandError('job_recovery_job_read_failed', 'Recovery job could not be read from durable state');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== candidate.status) {
    throw new JobRecoveryCommandError('job_recovery_job_mismatch', 'Recovery job no longer matches durable recovery state');
  }

  try {
    const result = await reconcile({ domainRegistry, certificateRegistry, applicationRegistry, job });
    if (!result || result.reconciled !== true) {
      throw new Error('reconciliation did not confirm success');
    }
  } catch {
    throw new JobRecoveryCommandError('job_recovery_reconciliation_failed', 'Recovery job reconciliation did not complete');
  }

  let acknowledgement;
  try {
    acknowledgement = await jobRegistry.acknowledgeReconciliation(identity);
  } catch {
    throw new JobRecoveryCommandError('job_recovery_acknowledgement_failed', 'Recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== identity.jobId || acknowledgement.serverId !== identity.serverId
    || acknowledgement.status !== candidate.status) {
    throw new JobRecoveryCommandError('job_recovery_acknowledgement_invalid', 'Recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    status: candidate.status,
    reconciled: true,
  });
}

export const jobRecoveryCommandInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
});
