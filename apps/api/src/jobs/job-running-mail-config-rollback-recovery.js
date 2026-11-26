import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const STATUS_SET = new Set(['disabled', 'enabled']);
const JOURNAL_STATUS_SET = new Set(['restoring_source', 'restored', 'compensated', 'failed']);
const PAYLOAD_KEYS = Object.freeze([
  'mailDomainId', 'sourceApplyJobId', 'previousRevision', 'expectedCurrentRevision',
  'currentStatus', 'targetStatus', 'currentConfigurationSha256', 'sourcePlanSha256',
  'backupSha256', 'previewDigest',
]);

export class JobRunningMailConfigRollbackRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningMailConfigRollbackRecoveryError';
    this.code = code;
  }
}

function recoveryError(code, message) {
  return new JobRunningMailConfigRollbackRecoveryError(code, message);
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw recoveryError('job_mail_config_rollback_recovery_identity_invalid', 'Managed mail rollback recovery identity is invalid');
  }
  return Object.freeze({ serverId, jobId });
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw recoveryError('job_mail_config_rollback_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw recoveryError('job_mail_config_rollback_recovery_consumers_must_be_stopped', 'Stop YunPanel API and legacy agent before recovering managed mail rollback');
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || candidate.operation !== OPERATIONS.MAIL_CONFIG_ROLLBACK
    || candidate.resourceType !== 'mail_domain' || typeof candidate.resourceId !== 'string'
    || !UUID_PATTERN.test(candidate.resourceId)) {
    throw recoveryError('job_mail_config_rollback_recovery_job_mismatch', 'Running managed mail rollback recovery metadata is inconsistent');
  }
}

function recoveryIntent(context, job, candidate, identity) {
  const payload = context?.payload;
  const statusesValid = STATUS_SET.has(payload?.currentStatus) && STATUS_SET.has(payload?.targetStatus);
  const statusChanged = statusesValid && payload.currentStatus !== payload.targetStatus;
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId
    || context.status !== 'running' || context.operation !== OPERATIONS.MAIL_CONFIG_ROLLBACK
    || context.resourceType !== 'mail_domain' || context.resourceId !== candidate.resourceId
    || context.resourceId !== job.resourceId || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== PAYLOAD_KEYS.length
    || Object.keys(payload).some((key) => !PAYLOAD_KEYS.includes(key))
    || payload.mailDomainId !== candidate.resourceId || !UUID_PATTERN.test(payload.mailDomainId)
    || typeof payload.sourceApplyJobId !== 'string' || !JOB_ID_PATTERN.test(payload.sourceApplyJobId)
    || payload.sourceApplyJobId === identity.jobId
    || !Number.isSafeInteger(payload.previousRevision) || payload.previousRevision < 1
    || !Number.isSafeInteger(payload.expectedCurrentRevision) || payload.expectedCurrentRevision < 1
    || payload.expectedCurrentRevision !== payload.previousRevision + (statusChanged ? 1 : 0)
    || !statusesValid
    || ['currentConfigurationSha256', 'sourcePlanSha256', 'backupSha256', 'previewDigest']
      .some((field) => typeof payload[field] !== 'string' || !CHECKSUM_PATTERN.test(payload[field]))) {
    throw recoveryError('job_mail_config_rollback_recovery_context_mismatch', 'Private managed mail rollback context does not match durable job metadata');
  }
  return Object.freeze({ ...payload });
}

function assertJournal(journal, identity, intent) {
  if (!journal || journal.serverId !== identity.serverId || journal.jobId !== identity.jobId
    || journal.mailDomainId !== intent.mailDomainId || journal.sourceApplyJobId !== intent.sourceApplyJobId
    || journal.previousRevision !== intent.previousRevision
    || journal.expectedCurrentRevision !== intent.expectedCurrentRevision
    || journal.currentStatus !== intent.currentStatus || journal.targetStatus !== intent.targetStatus
    || journal.previewDigest !== intent.previewDigest
    || journal.currentConfigurationSha256 !== intent.currentConfigurationSha256
    || journal.sourcePlanSha256 !== intent.sourcePlanSha256
    || journal.backupSha256 !== intent.backupSha256
    || typeof journal.compensationBackupSha256 !== 'string'
    || !CHECKSUM_PATTERN.test(journal.compensationBackupSha256)
    || !JOURNAL_STATUS_SET.has(journal.status)) {
    throw recoveryError('job_mail_config_rollback_recovery_journal_mismatch', 'Managed mail rollback journal does not match the running job');
  }
}

function assertReceipt(receipt, identity, intent, journal) {
  if (!receipt || receipt.version !== 1 || receipt.serverId !== identity.serverId
    || receipt.jobId !== identity.jobId || receipt.mailDomainId !== intent.mailDomainId
    || receipt.sourceApplyJobId !== intent.sourceApplyJobId
    || receipt.previousRevision !== intent.previousRevision
    || receipt.expectedCurrentRevision !== intent.expectedCurrentRevision
    || receipt.currentStatus !== intent.currentStatus || receipt.targetStatus !== intent.targetStatus
    || receipt.previewDigest !== intent.previewDigest
    || receipt.currentConfigurationSha256 !== intent.currentConfigurationSha256
    || receipt.sourcePlanSha256 !== intent.sourcePlanSha256
    || receipt.backupSha256 !== intent.backupSha256
    || receipt.compensationBackupSha256 !== journal.compensationBackupSha256
    || receipt.restored !== true) {
    throw recoveryError('job_mail_config_rollback_recovery_receipt_mismatch', 'Managed mail rollback receipt does not match the running job');
  }
}

function assertBundle(bundle, intent) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
    || !bundle.preview || !Array.isArray(bundle.sensitiveArtifacts)
    || !bundle.state || bundle.state.mailDomainId !== intent.mailDomainId
    || bundle.state.revision !== intent.expectedCurrentRevision
    || bundle.state.status !== intent.currentStatus
    || bundle.preview.sha256 !== intent.currentConfigurationSha256) {
    throw recoveryError('job_mail_config_rollback_recovery_materialization_invalid', 'Managed mail rollback current-state materialization is inconsistent');
  }
}

function hostOptions(identity, intent, journal) {
  return Object.freeze({
    transactionId: identity.jobId,
    sourceTransactionId: intent.sourceApplyJobId,
    sourcePlanSha256: intent.sourcePlanSha256,
    sourceBackupSha256: intent.backupSha256,
    compensationBackupSha256: journal.compensationBackupSha256,
  });
}

function assertInspection(inspection, intent, journal) {
  if (!inspection || inspection.version !== 1
    || inspection.currentConfigurationSha256 !== intent.currentConfigurationSha256
    || inspection.sourcePlanSha256 !== intent.sourcePlanSha256
    || inspection.sourceBackupSha256 !== intent.backupSha256
    || inspection.compensationBackupSha256 !== journal.compensationBackupSha256
    || !['source', 'current', 'mixed', 'drifted'].includes(inspection.state)
    || typeof inspection.sourceMatches !== 'boolean' || typeof inspection.currentMatches !== 'boolean'
    || typeof inspection.operationOwned !== 'boolean' || inspection.sideEffects !== false
    || (inspection.state === 'source' && !inspection.sourceMatches)
    || (inspection.state === 'current' && !inspection.currentMatches)
    || (inspection.state === 'mixed' && (!inspection.operationOwned
      || inspection.sourceMatches || inspection.currentMatches))
    || (inspection.state === 'drifted' && inspection.operationOwned)) {
    throw recoveryError('job_mail_config_rollback_recovery_inspection_invalid', 'Managed mail rollback host inspection is inconsistent');
  }
}

function rollbackResult(intent, journal) {
  return Object.freeze({
    version: 1,
    ...intent,
    compensationBackupSha256: journal.compensationBackupSha256,
    restored: true,
    sideEffects: true,
  });
}

async function completeAndReconcile({
  identity,
  intent,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  mailDomainRegistry,
  reconcile,
  status,
  result = null,
  error = null,
}) {
  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_completion_journal_failed', 'Managed mail rollback recovery completion journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId
    || begun.status !== 'running' || begun.pending !== true) {
    throw recoveryError('job_mail_config_rollback_recovery_completion_journal_invalid', 'Managed mail rollback recovery completion journal is inconsistent');
  }

  let terminal;
  try {
    terminal = await jobRegistry.complete({
      serverId: identity.serverId,
      jobId: identity.jobId,
      status,
      ...(status === 'succeeded' ? { result } : { error }),
    });
  } catch {
    throw recoveryError('job_mail_config_rollback_recovery_completion_failed', 'Managed mail rollback durable completion could not be confirmed');
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== status || terminal.operation !== OPERATIONS.MAIL_CONFIG_ROLLBACK
    || terminal.resourceType !== 'mail_domain' || terminal.resourceId !== intent.mailDomainId) {
    throw recoveryError('job_mail_config_rollback_recovery_completion_invalid', 'Managed mail rollback completion acknowledgement is inconsistent');
  }

  try {
    const reconciliation = await reconcile({
      domainRegistry,
      certificateRegistry,
      applicationRegistry,
      mailDomainRegistry,
      job: terminal,
    });
    if (!reconciliation || reconciliation.reconciled !== true) throw new Error('reconciliation not confirmed');
  } catch {
    throw recoveryError('job_mail_config_rollback_recovery_reconciliation_failed', 'Managed mail rollback job is terminal but reconciliation remains pending');
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_acknowledgement_failed', 'Managed mail rollback recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true
    || acknowledgement.jobId !== identity.jobId || acknowledgement.serverId !== identity.serverId
    || acknowledgement.status !== status) {
    throw recoveryError('job_mail_config_rollback_recovery_acknowledgement_invalid', 'Managed mail rollback recovery acknowledgement is inconsistent');
  }
  return terminal;
}

export async function recoverRunningMailConfigRollback({
  serverId,
  jobId,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  mailDomainRegistry,
  serviceStatus,
  loadJobContext,
  materializeCurrent,
  readRollbackJournal,
  transitionRollbackJournal,
  readRollbackReceipt,
  writeRollbackReceipt,
  inspectRollbackConfiguration,
  recoverRollbackConfiguration,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function' || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !domainRegistry || !certificateRegistry || !applicationRegistry
    || !mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof mailDomainRegistry.transitionLocalStatus !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof materializeCurrent !== 'function' || typeof readRollbackJournal !== 'function'
    || typeof transitionRollbackJournal !== 'function' || typeof readRollbackReceipt !== 'function'
    || typeof writeRollbackReceipt !== 'function' || typeof inspectRollbackConfiguration !== 'function'
    || typeof recoverRollbackConfiguration !== 'function' || typeof inspect !== 'function'
    || typeof reconcile !== 'function') {
    throw recoveryError('job_mail_config_rollback_recovery_dependencies_invalid', 'Managed mail rollback recovery dependencies are invalid');
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_durable_inspection_failed', 'Durable managed mail rollback recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw recoveryError('job_mail_config_rollback_recovery_durable_inspection_invalid', 'Durable managed mail rollback recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId
    && entry.serverId === identity.serverId) ?? null;
  assertCandidate(candidate, identity);

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_job_read_failed', 'Running managed mail rollback job could not be read');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId
    || job.status !== 'running' || job.operation !== OPERATIONS.MAIL_CONFIG_ROLLBACK
    || job.resourceType !== 'mail_domain' || job.resourceId !== candidate.resourceId) {
    throw recoveryError('job_mail_config_rollback_recovery_job_mismatch', 'Running managed mail rollback no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_context_failed', 'Private managed mail rollback context could not be read');
  }
  const intent = recoveryIntent(context, job, candidate, identity);

  let journal;
  try { journal = await readRollbackJournal(identity.serverId, identity.jobId); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_journal_failed', 'Managed mail rollback journal could not be read');
  }
  if (!journal) {
    throw recoveryError('job_mail_config_rollback_recovery_journal_missing', 'Managed mail rollback journal is absent; the running job remains unresolved');
  }
  assertJournal(journal, identity, intent);

  let receipt;
  try { receipt = await readRollbackReceipt(identity.serverId, identity.jobId); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_receipt_failed', 'Managed mail rollback receipt could not be read');
  }
  if (receipt) assertReceipt(receipt, identity, intent, journal);

  let bundle;
  try {
    bundle = await materializeCurrent({
      mailDomainId: intent.mailDomainId,
      expectedRevision: intent.expectedCurrentRevision,
      status: intent.currentStatus,
    }, { expectedConfigurationSha256: intent.currentConfigurationSha256 });
  } catch {
    throw recoveryError('job_mail_config_rollback_recovery_materialization_failed', 'Current protected managed mail state does not match the rollback intent');
  }
  assertBundle(bundle, intent);

  const options = hostOptions(identity, intent, journal);
  let hostInspection;
  try { hostInspection = await inspectRollbackConfiguration(bundle.preview, options); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_host_inspection_failed', 'Managed mail rollback host state could not be inspected');
  }
  assertInspection(hostInspection, intent, journal);

  if (journal.status === 'failed') {
    throw recoveryError('job_mail_config_rollback_recovery_terminal_failure', 'Managed mail rollback journal records an unresolved compensation failure');
  }
  if (hostInspection.state === 'drifted') {
    throw recoveryError('job_mail_config_rollback_recovery_host_drifted', 'Managed mail rollback host state contains unowned drift');
  }
  if (journal.status === 'compensated' && hostInspection.state !== 'current') {
    throw recoveryError('job_mail_config_rollback_recovery_state_mismatch', 'Managed mail rollback journal and host state disagree');
  }
  if (journal.status === 'restored' && hostInspection.state !== 'source') {
    throw recoveryError('job_mail_config_rollback_recovery_state_mismatch', 'Managed mail rollback journal and host state disagree');
  }
  if (receipt && hostInspection.state !== 'source') {
    throw recoveryError('job_mail_config_rollback_recovery_state_mismatch', 'Managed mail rollback receipt and host state disagree');
  }

  if (hostInspection.state === 'current') {
    if (journal.status === 'restoring_source') {
      try {
        journal = await transitionRollbackJournal(identity.serverId, identity.jobId, {
          status: 'compensated',
          lastErrorCode: 'mail_rollback_recovery_current',
        });
      } catch {
        throw recoveryError('job_mail_config_rollback_recovery_journal_transition_failed', 'Managed mail rollback safe compensation could not be recorded');
      }
      assertJournal(journal, identity, intent);
    }
    await completeAndReconcile({
      identity,
      intent,
      jobRegistry,
      domainRegistry,
      certificateRegistry,
      applicationRegistry,
      mailDomainRegistry,
      reconcile,
      status: 'failed',
      error: { code: 'mail_rollback_recovery_current' },
    });
    return Object.freeze({
      serverId: identity.serverId,
      jobId: identity.jobId,
      operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
      status: 'failed',
      recoveryMethod: 'verified_mail_config_rollback_current_compensation',
      reconciled: true,
    });
  }

  let restored;
  try { restored = await recoverRollbackConfiguration(bundle.preview, options); }
  catch {
    throw recoveryError('job_mail_config_rollback_recovery_host_failed', 'Managed mail rollback host recovery could not be completed');
  }
  if (!restored || restored.restored !== true || restored.sideEffects !== true
    || restored.currentConfigurationSha256 !== intent.currentConfigurationSha256
    || restored.sourcePlanSha256 !== intent.sourcePlanSha256
    || restored.sourceBackupSha256 !== intent.backupSha256
    || restored.compensationBackupSha256 !== journal.compensationBackupSha256) {
    throw recoveryError('job_mail_config_rollback_recovery_host_invalid', 'Managed mail rollback host recovery evidence is inconsistent');
  }

  if (journal.status === 'restoring_source') {
    try { journal = await transitionRollbackJournal(identity.serverId, identity.jobId, { status: 'restored' }); }
    catch {
      throw recoveryError('job_mail_config_rollback_recovery_journal_transition_failed', 'Managed mail rollback completion could not be recorded');
    }
    assertJournal(journal, identity, intent);
  }

  if (!receipt) {
    try {
      receipt = await writeRollbackReceipt({
        serverId: identity.serverId,
        jobId: identity.jobId,
        ...intent,
        compensationBackupSha256: journal.compensationBackupSha256,
        restored: true,
      });
    } catch {
      throw recoveryError('job_mail_config_rollback_recovery_receipt_write_failed', 'Managed mail rollback completion receipt could not be written');
    }
    assertReceipt(receipt, identity, intent, journal);
  }

  await completeAndReconcile({
    identity,
    intent,
    jobRegistry,
    domainRegistry,
    certificateRegistry,
    applicationRegistry,
    mailDomainRegistry,
    reconcile,
    status: 'succeeded',
    result: rollbackResult(intent, journal),
  });
  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
    status: 'succeeded',
    recoveryMethod: 'verified_mail_config_rollback_journal_backups_and_host_state',
    reconciled: true,
  });
}

export const jobRunningMailConfigRollbackRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  recoveryIntent,
  assertJournal,
  assertReceipt,
  assertBundle,
  assertInspection,
  rollbackResult,
});
