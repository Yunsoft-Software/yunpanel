import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RECOVERABLE_ACTIONS = new Set(['start', 'stop']);

export class JobRunningServiceRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningServiceRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningServiceRecoveryError('job_service_recovery_identity_invalid', 'Managed service recovery job identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRunningServiceRecoveryError('job_service_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningServiceRecoveryError('job_service_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningServiceRecoveryError('job_service_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a managed service control');
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || candidate.operation !== OPERATIONS.SYSTEM_SERVICE_CONTROL
    || candidate.resourceType !== 'system' || candidate.resourceId !== identity.serverId) {
    throw new JobRunningServiceRecoveryError('job_service_recovery_job_mismatch', 'Running managed service recovery job metadata is inconsistent');
  }
}

function assertContext(context, job, candidate, identity) {
  const action = context?.payload?.action;
  const serviceId = context?.payload?.serviceId;
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== OPERATIONS.SYSTEM_SERVICE_CONTROL || context.resourceType !== 'system'
    || context.resourceId !== identity.serverId || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || typeof serviceId !== 'string' || !serviceId || !RECOVERABLE_ACTIONS.has(action)) {
    throw new JobRunningServiceRecoveryError('job_service_recovery_context_mismatch', 'Private managed service recovery context does not match durable job metadata');
  }
  return { serviceId, action };
}

function serviceControlEvidence(snapshot, { serviceId, action }) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.id !== serviceId || snapshot.installed !== true
    || !Array.isArray(snapshot.packages) || snapshot.packages.length < 1
    || !Array.isArray(snapshot.units) || snapshot.units.length < 1
    || snapshot.packages.some((entry) => !entry || entry.installed !== true)
    || snapshot.units.some((entry) => !entry || entry.inspectionError !== false || typeof entry.activeState !== 'string')) {
    throw new JobRunningServiceRecoveryError('job_service_recovery_evidence_invalid', 'Managed service host evidence is invalid');
  }

  const expectedActive = action === 'start';
  const unitsSatisfied = action === 'start'
    ? snapshot.units.every((entry) => entry.activeState === 'active')
    : snapshot.units.every((entry) => entry.activeState !== 'active');
  if (snapshot.active !== expectedActive || !unitsSatisfied) return null;
  return { ...snapshot, action };
}

export async function recoverRunningServiceControl({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
  inspectServiceState,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || typeof serviceStatus !== 'function'
    || typeof loadJobContext !== 'function'
    || typeof inspectServiceState !== 'function'
    || typeof inspect !== 'function'
    || typeof reconcile !== 'function') {
    throw new JobRunningServiceRecoveryError('job_service_recovery_dependencies_invalid', 'Managed service recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRunningServiceRecoveryError('job_service_recovery_inspection_failed', 'Durable managed service recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningServiceRecoveryError('job_service_recovery_inspection_invalid', 'Durable managed service recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate) throw new JobRunningServiceRecoveryError('job_service_recovery_job_not_found', 'Requested managed service control is not present in durable recovery state');
  assertCandidate(candidate, identity);

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRunningServiceRecoveryError('job_service_recovery_job_read_failed', 'Running managed service recovery job could not be read from durable state');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== OPERATIONS.SYSTEM_SERVICE_CONTROL || job.resourceType !== 'system'
    || job.resourceId !== identity.serverId || job.resourceId !== candidate.resourceId) {
    throw new JobRunningServiceRecoveryError('job_service_recovery_job_mismatch', 'Running managed service control no longer matches durable recovery state');
  }

  let context;
  try {
    context = await loadJobContext(identity.jobId);
  } catch {
    throw new JobRunningServiceRecoveryError('job_service_recovery_context_failed', 'Private managed service recovery context could not be read');
  }
  const desired = assertContext(context, job, candidate, identity);

  let snapshot;
  try {
    snapshot = await inspectServiceState(desired.serviceId);
  } catch {
    throw new JobRunningServiceRecoveryError('job_service_recovery_evidence_failed', 'Managed service host state could not be inspected');
  }
  const result = serviceControlEvidence(snapshot, desired);
  if (!result) {
    throw new JobRunningServiceRecoveryError(
      'job_service_recovery_evidence_not_satisfied',
      'Managed service host state does not satisfy the queued action; the running job remains unresolved',
    );
  }

  let begun;
  try {
    begun = await jobRegistry.beginReconciliation(identity);
  } catch {
    throw new JobRunningServiceRecoveryError('job_service_recovery_journal_failed', 'Managed service recovery reconciliation journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningServiceRecoveryError('job_service_recovery_journal_invalid', 'Managed service recovery reconciliation journal acknowledgement is inconsistent');
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
    throw new JobRunningServiceRecoveryError('job_service_recovery_completion_failed', 'Managed service state was confirmed but durable completion could not be confirmed');
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== OPERATIONS.SYSTEM_SERVICE_CONTROL
    || terminal.resourceType !== 'system' || terminal.resourceId !== identity.serverId) {
    throw new JobRunningServiceRecoveryError('job_service_recovery_completion_invalid', 'Managed service recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {}, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningServiceRecoveryError('job_service_recovery_reconciliation_failed', 'Managed service job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try {
    acknowledgement = await jobRegistry.acknowledgeReconciliation(identity);
  } catch {
    throw new JobRunningServiceRecoveryError('job_service_recovery_acknowledgement_failed', 'Managed service recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== identity.jobId || acknowledgement.serverId !== identity.serverId
    || acknowledgement.status !== 'succeeded') {
    throw new JobRunningServiceRecoveryError('job_service_recovery_acknowledgement_invalid', 'Managed service recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    serviceId: desired.serviceId,
    action: desired.action,
    status: 'succeeded',
    recoveryMethod: 'verified_managed_service_state',
    reconciled: true,
  });
}

export const jobRunningServiceRecoveryInternals = Object.freeze({
  recoverableActions: Object.freeze([...RECOVERABLE_ACTIONS]),
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  assertContext,
  serviceControlEvidence,
});
