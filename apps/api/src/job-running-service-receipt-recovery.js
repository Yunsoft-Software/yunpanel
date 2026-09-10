import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';
import { managedServiceStateDigest } from './managed-service-mutation-receipt.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRunningServiceReceiptRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningServiceReceiptRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_identity_invalid', 'Managed service receipt recovery identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try {
    status = await serviceStatus();
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a managed service mutation');
  }
}

function recoveryIntent(context, identity) {
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.resourceType !== 'system' || context.resourceId !== identity.serverId
    || typeof context.payload?.serviceId !== 'string' || !context.payload.serviceId) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_context_mismatch', 'Private managed service recovery context does not match durable job metadata');
  }
  if (context.operation === OPERATIONS.SYSTEM_SERVICE_INSTALL) {
    return { operation: context.operation, serviceId: context.payload.serviceId, action: null };
  }
  if (context.operation === OPERATIONS.SYSTEM_SERVICE_CONTROL && context.payload.action === 'restart') {
    return { operation: context.operation, serviceId: context.payload.serviceId, action: 'restart' };
  }
  throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_operation_unsupported', 'This managed service operation requires a different recovery method');
}

function assertPublicJob(job, candidate, identity) {
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || ![OPERATIONS.SYSTEM_SERVICE_INSTALL, OPERATIONS.SYSTEM_SERVICE_CONTROL].includes(job.operation)
    || job.resourceType !== 'system' || job.resourceId !== identity.serverId || job.resourceId !== candidate.resourceId) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_job_mismatch', 'Running managed service mutation no longer matches durable recovery state');
  }
}

function assertReceipt(receipt, identity, intent) {
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId
    || receipt.operation !== intent.operation || receipt.serviceId !== intent.serviceId) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_receipt_mismatch', 'Managed service recovery receipt does not match the running job');
  }
  if (intent.operation === OPERATIONS.SYSTEM_SERVICE_INSTALL) {
    if (receipt.action !== null || typeof receipt.changed !== 'boolean') {
      throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_receipt_mismatch', 'Managed service install receipt is inconsistent');
    }
    return;
  }
  if (receipt.action !== 'restart' || receipt.changed !== null) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_receipt_mismatch', 'Managed service restart receipt is inconsistent');
  }
}

function activeServiceEvidence(snapshot, serviceId) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.id !== serviceId || snapshot.installed !== true || snapshot.active !== true
    || !Array.isArray(snapshot.packages) || snapshot.packages.length < 1
    || !Array.isArray(snapshot.units) || snapshot.units.length < 1
    || snapshot.packages.some((entry) => !entry || entry.installed !== true)
    || snapshot.units.some((entry) => !entry || entry.inspectionError !== false || entry.activeState !== 'active')) {
    return null;
  }
  return snapshot;
}

function requireReceiptStateDigest(receipt, snapshot, serviceId) {
  let currentDigest;
  try {
    currentDigest = managedServiceStateDigest(snapshot, serviceId);
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_evidence_invalid', 'Managed service host evidence is invalid');
  }
  if (receipt.stateDigest !== currentDigest) {
    throw new JobRunningServiceReceiptRecoveryError(
      'job_service_receipt_recovery_evidence_not_satisfied',
      'Managed service host state changed after the recorded mutation; the running job remains unresolved',
    );
  }
}

export async function recoverRunningServiceReceiptMutation({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
  readMutationReceipt,
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
    || typeof readMutationReceipt !== 'function'
    || typeof inspectServiceState !== 'function'
    || typeof inspect !== 'function'
    || typeof reconcile !== 'function') {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_dependencies_invalid', 'Managed service receipt recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);

  let inspection;
  try {
    inspection = await inspect({ registry: jobRegistry });
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_inspection_failed', 'Durable managed service recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_inspection_invalid', 'Durable managed service recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate || candidate.status !== 'running' || candidate.resourceType !== 'system' || candidate.resourceId !== identity.serverId
    || ![OPERATIONS.SYSTEM_SERVICE_INSTALL, OPERATIONS.SYSTEM_SERVICE_CONTROL].includes(candidate.operation)) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_job_mismatch', 'Running managed service recovery job metadata is inconsistent');
  }

  let job;
  try {
    job = await jobRegistry.getJob(identity.jobId);
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_job_read_failed', 'Running managed service recovery job could not be read from durable state');
  }
  assertPublicJob(job, candidate, identity);

  let context;
  try {
    context = await loadJobContext(identity.jobId);
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_context_failed', 'Private managed service recovery context could not be read');
  }
  if (context?.operation !== job.operation) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_context_mismatch', 'Private managed service recovery context does not match public job metadata');
  }
  const intent = recoveryIntent(context, identity);

  let receipt;
  try {
    receipt = await readMutationReceipt(identity.serverId, identity.jobId);
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_receipt_failed', 'Managed service recovery receipt could not be read');
  }
  if (!receipt) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_receipt_missing', 'Managed service receipt is absent; the running job remains unresolved');
  }
  assertReceipt(receipt, identity, intent);

  let snapshot;
  try {
    snapshot = await inspectServiceState(intent.serviceId);
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_evidence_failed', 'Managed service host state could not be inspected');
  }
  const evidence = activeServiceEvidence(snapshot, intent.serviceId);
  if (!evidence) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_evidence_not_satisfied', 'Managed service host state no longer satisfies the completed mutation');
  }
  requireReceiptStateDigest(receipt, evidence, intent.serviceId);
  const result = intent.operation === OPERATIONS.SYSTEM_SERVICE_INSTALL
    ? { ...evidence, changed: receipt.changed }
    : { ...evidence, action: 'restart' };

  let begun;
  try {
    begun = await jobRegistry.beginReconciliation(identity);
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_journal_failed', 'Managed service recovery reconciliation journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_journal_invalid', 'Managed service recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result });
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_completion_failed', 'Managed service receipt was verified but durable completion could not be confirmed');
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId || terminal.status !== 'succeeded'
    || terminal.operation !== intent.operation || terminal.resourceType !== 'system' || terminal.resourceId !== identity.serverId) {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_completion_invalid', 'Managed service recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {}, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_reconciliation_failed', 'Managed service job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try {
    acknowledgement = await jobRegistry.acknowledgeReconciliation(identity);
  } catch {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_acknowledgement_failed', 'Managed service recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningServiceReceiptRecoveryError('job_service_receipt_recovery_acknowledgement_invalid', 'Managed service recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: intent.operation,
    serviceId: intent.serviceId,
    action: intent.action,
    status: 'succeeded',
    recoveryMethod: 'verified_managed_service_receipt_and_state',
    reconciled: true,
  });
}

export const jobRunningServiceReceiptRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  recoveryIntent,
  assertPublicJob,
  assertReceipt,
  activeServiceEvidence,
  requireReceiptStateDigest,
});
