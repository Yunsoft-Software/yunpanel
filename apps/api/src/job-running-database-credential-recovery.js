import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATIONS_SET = new Set([
  OPERATIONS.DATABASE_CREDENTIAL_APPLY,
  OPERATIONS.DATABASE_CREDENTIAL_DELETE,
]);

export class JobRunningDatabaseCredentialRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningDatabaseCredentialRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !UUID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_identity_invalid', 'Database credential recovery identity is invalid');
  }
  return { serverId: serverId.toLowerCase(), jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering a database credential job');
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || !OPERATIONS_SET.has(candidate.operation)
    || candidate.resourceType !== 'database' || typeof candidate.resourceId !== 'string' || !candidate.resourceId) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_job_mismatch', 'Running database credential recovery metadata is inconsistent');
  }
}

function assertContext(context, job, candidate, identity) {
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId || context.status !== 'running'
    || context.operation !== candidate.operation || context.operation !== job.operation
    || context.resourceType !== 'database' || context.resourceId !== candidate.resourceId || context.resourceId !== job.resourceId
    || !context.payload || typeof context.payload !== 'object' || Array.isArray(context.payload)
    || JSON.stringify(context.payload) !== JSON.stringify(job.payload)) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_context_mismatch', 'Private database credential recovery context does not match durable job metadata');
  }
}

function assertReceipt(receipt, context, identity) {
  const result = receipt?.result;
  const terminalField = context.operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY ? 'applied' : 'deleted';
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId
    || receipt.operation !== context.operation || !result || typeof result !== 'object' || Array.isArray(result)
    || result.databaseCredentialId !== context.payload.databaseCredentialId
    || result.databaseBindingId !== context.payload.databaseBindingId
    || result.credentialRevision !== context.payload.expectedCredentialRevision
    || result.bindingRevision !== context.payload.expectedBindingRevision
    || result.desiredStateSha256 !== context.payload.desiredStateSha256
    || result.databaseName !== context.resourceId || result[terminalField] !== true || result.sideEffects !== true) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_receipt_mismatch', 'Database credential receipt does not match the durable job');
  }
}

function assertDesiredState(bundle, context) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
    || bundle.databaseCredentialId !== context.payload.databaseCredentialId
    || bundle.databaseBindingId !== context.payload.databaseBindingId
    || bundle.credentialRevision !== context.payload.expectedCredentialRevision
    || bundle.bindingRevision !== context.payload.expectedBindingRevision
    || bundle.desiredStateSha256 !== context.payload.desiredStateSha256
    || bundle.databaseName !== context.resourceId) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_desired_state_mismatch', 'Current database credential desired state does not match the queued job');
  }
}

function assertLiveEvidence(evidence, context, receipt) {
  const result = receipt.result;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.databaseCredentialId !== result.databaseCredentialId
    || evidence.databaseBindingId !== result.databaseBindingId
    || evidence.databaseName !== result.databaseName || evidence.username !== result.username
    || evidence.host !== result.host || evidence.desiredStateSha256 !== result.desiredStateSha256
    || evidence.sideEffects !== false) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_evidence_mismatch', 'Database credential live evidence does not match the durable receipt');
  }
  if (context.operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY) {
    if (evidence.accountPresent !== true || evidence.markerHealthy !== true
      || evidence.grantsHealthy !== true || evidence.applied !== true) {
      throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_evidence_not_satisfied', 'Exact database account, ownership marker and grants were not confirmed');
    }
    return;
  }
  if (evidence.accountPresent !== false || evidence.markerPresent !== false || evidence.deleted !== true) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_evidence_not_satisfied', 'Database account or ownership marker is still present');
  }
}

export async function recoverRunningDatabaseCredential({
  serverId,
  jobId,
  jobRegistry,
  serviceStatus,
  loadJobContext,
  readReceipt,
  materializeDesiredState,
  inspectLiveState,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function' || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function' || typeof serviceStatus !== 'function'
    || typeof loadJobContext !== 'function' || typeof readReceipt !== 'function'
    || typeof materializeDesiredState !== 'function' || typeof inspectLiveState !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_dependencies_invalid', 'Database credential recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_inspection_failed', 'Durable database credential recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_inspection_invalid', 'Durable database credential recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  if (!candidate) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_job_not_found', 'Requested database credential job is not present in durable recovery state');
  }
  assertCandidate(candidate, identity);

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_job_read_failed', 'Running database credential job could not be read');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== candidate.operation || job.resourceType !== 'database' || job.resourceId !== candidate.resourceId) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_job_mismatch', 'Running database credential job no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_context_failed', 'Private database credential recovery context could not be read');
  }
  assertContext(context, job, candidate, identity);

  let receipt;
  try { receipt = await readReceipt(identity.serverId, identity.jobId); }
  catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_receipt_failed', 'Database credential receipt could not be read');
  }
  if (!receipt) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_receipt_missing', 'Database credential receipt is absent; the running job remains unresolved');
  }
  assertReceipt(receipt, context, identity);

  let bundle;
  try { bundle = await materializeDesiredState(context.payload, context.operation); }
  catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_desired_state_failed', 'Current database credential desired state could not be materialized');
  }
  assertDesiredState(bundle, context);

  let evidence;
  try { evidence = await inspectLiveState(context.operation, bundle); }
  catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_evidence_failed', 'Database credential live state could not be inspected');
  }
  assertLiveEvidence(evidence, context, receipt);

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_journal_failed', 'Database credential recovery journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_journal_invalid', 'Database credential recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result: receipt.result });
  } catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_completion_failed', 'Database credential evidence was confirmed but durable completion could not be confirmed');
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== context.operation
    || terminal.resourceType !== 'database' || terminal.resourceId !== job.resourceId) {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_completion_invalid', 'Database credential recovery completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({ domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {}, job: terminal });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_reconciliation_failed', 'Database credential job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_acknowledgement_failed', 'Database credential recovery could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== identity.jobId || acknowledgement.serverId !== identity.serverId
    || acknowledgement.status !== 'succeeded') {
    throw new JobRunningDatabaseCredentialRecoveryError('job_database_credential_recovery_acknowledgement_invalid', 'Database credential recovery acknowledgement is inconsistent');
  }

  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: context.operation,
    status: 'succeeded',
    recoveryMethod: context.operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY
      ? 'verified_database_credential_receipt_marker_and_grants'
      : 'verified_database_credential_receipt_and_absence',
    reconciled: true,
  });
}

export const jobRunningDatabaseCredentialRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  assertContext,
  assertReceipt,
  assertDesiredState,
  assertLiveEvidence,
});
