import { OPERATIONS } from '@yunpanel/protocol';
import { inspectDurableJobRecovery } from './job-recovery-inspection.js';
import { reconcileCompletedJob } from './job-reconciliation.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const OPERATIONS_SET = new Set([
  OPERATIONS.MAIL_DATA_BACKUP,
  OPERATIONS.MAIL_DATA_RESTORE,
  OPERATIONS.MAIL_DATA_DELETE,
]);

export class JobRunningMailDataRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRunningMailDataRecoveryError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_identity_invalid', 'Mail data recovery identity is invalid');
  }
  return { serverId, jobId };
}

async function requireStoppedConsumers(serviceStatus) {
  let status;
  try { status = await serviceStatus(); }
  catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_service_status_unavailable', 'Could not verify YunPanel service state');
  }
  if (!status || typeof status.apiActive !== 'boolean' || typeof status.agentActive !== 'boolean') {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_service_status_invalid', 'YunPanel service state is invalid');
  }
  if (status.apiActive || status.agentActive) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_consumers_must_be_stopped',
      'Stop YunPanel API and legacy agent before recovering mail data operations',
    );
  }
}

function assertCandidate(candidate, identity) {
  if (!candidate || candidate.jobId !== identity.jobId || candidate.serverId !== identity.serverId
    || candidate.status !== 'running' || !OPERATIONS_SET.has(candidate.operation)
    || candidate.resourceType !== 'mail_domain' || typeof candidate.resourceId !== 'string'
    || !UUID_PATTERN.test(candidate.resourceId)) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_job_mismatch',
      'Running mail data recovery metadata is inconsistent',
    );
  }
}

function validateCommonPayload(payload, operation, candidate) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.mailDomainId !== candidate.resourceId || !UUID_PATTERN.test(payload.mailDomainId)
    || typeof payload.resourceId !== 'string' || !UUID_PATTERN.test(payload.resourceId)
    || !['mailbox', 'domain'].includes(payload.scope)
    || typeof payload.identity !== 'string' || !payload.identity
    || !Number.isSafeInteger(payload.expectedResourceRevision) || payload.expectedResourceRevision < 1) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_context_mismatch',
      'Private mail data recovery context does not match durable job metadata',
    );
  }
  if (payload.scope === 'domain' && payload.resourceId !== payload.mailDomainId) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_context_mismatch',
      'Mail-domain data recovery resource identity is inconsistent',
    );
  }
  if (operation === OPERATIONS.MAIL_DATA_BACKUP) {
    if (Object.keys(payload).length !== 6
      || typeof payload.expectedSnapshotSha256 !== 'string'
      || !CHECKSUM_PATTERN.test(payload.expectedSnapshotSha256)) {
      throw new JobRunningMailDataRecoveryError(
        'job_mail_data_recovery_context_mismatch',
        'Private mail data backup recovery context is invalid',
      );
    }
    return;
  }
  if (Object.keys(payload).length !== 7
    || typeof payload.backupId !== 'string' || !BACKUP_ID_PATTERN.test(payload.backupId)
    || typeof payload.expectedTargetSnapshotSha256 !== 'string'
    || !CHECKSUM_PATTERN.test(payload.expectedTargetSnapshotSha256)) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_context_mismatch',
      `Private mail data ${operation === OPERATIONS.MAIL_DATA_DELETE ? 'delete' : 'restore'} recovery context is invalid`,
    );
  }
}

function recoveryIntent(context, job, candidate, identity) {
  const payload = context?.payload;
  if (!context || context.id !== identity.jobId || context.serverId !== identity.serverId
    || context.status !== 'running' || !OPERATIONS_SET.has(context.operation)
    || context.operation !== candidate.operation || context.operation !== job.operation
    || context.resourceType !== 'mail_domain' || context.resourceId !== candidate.resourceId
    || context.resourceId !== job.resourceId) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_context_mismatch',
      'Private mail data recovery context does not match durable job metadata',
    );
  }
  validateCommonPayload(payload, context.operation, candidate);
  return Object.freeze({ operation: context.operation, ...payload });
}

function assertReceipt(receipt, identity, intent) {
  if (!receipt || receipt.serverId !== identity.serverId || receipt.jobId !== identity.jobId
    || receipt.operation !== intent.operation || receipt.mailDomainId !== intent.mailDomainId
    || receipt.scope !== intent.scope || receipt.identity !== intent.identity
    || typeof receipt.contentSha256 !== 'string' || !CHECKSUM_PATTERN.test(receipt.contentSha256)
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0
    || !Number.isSafeInteger(receipt.files) || receipt.files < 0
    || !Number.isSafeInteger(receipt.directories) || receipt.directories < 0) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_receipt_mismatch',
      'Mail data operation receipt does not match the running job',
    );
  }
  if (intent.operation === OPERATIONS.MAIL_DATA_BACKUP) {
    if (receipt.backupId !== identity.jobId
      || receipt.sourceSnapshotSha256 !== intent.expectedSnapshotSha256
      || typeof receipt.sourcePresent !== 'boolean'
      || receipt.backedUp !== true || receipt.sideEffects !== true) {
      throw new JobRunningMailDataRecoveryError(
        'job_mail_data_recovery_receipt_mismatch',
        'Mail data backup receipt does not match the running job',
      );
    }
    return;
  }
  if (intent.operation === OPERATIONS.MAIL_DATA_DELETE) {
    if (receipt.transactionId !== identity.jobId || receipt.backupId !== intent.backupId
      || receipt.resourceId !== intent.resourceId || typeof receipt.sourcePresent !== 'boolean'
      || receipt.deleted !== true || receipt.sideEffects !== true) {
      throw new JobRunningMailDataRecoveryError(
        'job_mail_data_recovery_receipt_mismatch',
        'Mail data delete receipt does not match the running job',
      );
    }
    return;
  }
  if (receipt.transactionId !== identity.jobId || receipt.backupId !== intent.backupId
    || receipt.preRestoreBackupId !== `pre-restore:${identity.jobId}`
    || receipt.restoredPresent !== true || receipt.applied !== true || receipt.sideEffects !== true) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_receipt_mismatch',
      'Mail data restore receipt does not match the running job',
    );
  }
}

async function assertCurrentResource(intent, { mailDomainRegistry, mailboxRegistry }) {
  let mailDomain;
  try { mailDomain = await mailDomainRegistry.getMailDomain(intent.mailDomainId); }
  catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_resource_failed', 'Mail-domain state could not be read');
  }
  if (!mailDomain || mailDomain.id !== intent.mailDomainId || mailDomain.managementMode !== 'local') {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_resource_mismatch', 'Mail-domain state no longer matches the running job');
  }
  if (intent.scope === 'domain') {
    if (intent.resourceId !== mailDomain.id || intent.identity !== mailDomain.domainName
      || intent.expectedResourceRevision !== mailDomain.revision) {
      throw new JobRunningMailDataRecoveryError(
        'job_mail_data_recovery_resource_mismatch',
        'Mail-domain resource changed after the operation was queued',
      );
    }
  } else {
    let mailbox;
    try { mailbox = await mailboxRegistry.getMailbox(intent.resourceId); }
    catch {
      throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_resource_failed', 'Mailbox state could not be read');
    }
    if (!mailbox || mailbox.id !== intent.resourceId || mailbox.mailDomainId !== intent.mailDomainId
      || mailbox.address !== intent.identity || mailbox.revision !== intent.expectedResourceRevision) {
      throw new JobRunningMailDataRecoveryError(
        'job_mail_data_recovery_resource_mismatch',
        'Mailbox resource changed after the operation was queued',
      );
    }
  }
  if ([OPERATIONS.MAIL_DATA_RESTORE, OPERATIONS.MAIL_DATA_DELETE].includes(intent.operation)
    && mailDomain.status !== 'disabled') {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_domain_not_disabled',
      'Mail-domain must remain disabled while recovering mail data restore or deletion',
    );
  }
  return mailDomain;
}

function backupResultFromReceipt(intent, receipt) {
  return Object.freeze({
    version: 1,
    backupId: receipt.backupId,
    mailDomainId: intent.mailDomainId,
    scope: intent.scope,
    identity: intent.identity,
    sourcePresent: receipt.sourcePresent,
    sourceSnapshotSha256: intent.expectedSnapshotSha256,
    contentSha256: receipt.contentSha256,
    bytes: receipt.bytes,
    files: receipt.files,
    directories: receipt.directories,
    backedUp: true,
    sideEffects: true,
  });
}

function restoreResultFromReceipt(intent, receipt) {
  return Object.freeze({
    version: 1,
    transactionId: receipt.transactionId,
    backupId: receipt.backupId,
    preRestoreBackupId: receipt.preRestoreBackupId,
    mailDomainId: intent.mailDomainId,
    scope: intent.scope,
    identity: intent.identity,
    contentSha256: receipt.contentSha256,
    bytes: receipt.bytes,
    files: receipt.files,
    directories: receipt.directories,
    restoredPresent: true,
    applied: true,
    sideEffects: true,
  });
}

function deleteResultFromReceipt(intent, receipt) {
  return Object.freeze({
    version: 1,
    transactionId: receipt.transactionId,
    backupId: receipt.backupId,
    mailDomainId: intent.mailDomainId,
    resourceId: intent.resourceId,
    scope: intent.scope,
    identity: intent.identity,
    sourcePresent: receipt.sourcePresent,
    contentSha256: receipt.contentSha256,
    bytes: receipt.bytes,
    files: receipt.files,
    directories: receipt.directories,
    deleted: true,
    sideEffects: true,
  });
}

async function verifyBackupEvidence(intent, receipt, identity, inspectBackup) {
  let backup;
  try { backup = await inspectBackup(identity.jobId); }
  catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_evidence_failed', 'Mail data backup evidence could not be verified');
  }
  if (!backup || backup.backupId !== identity.jobId || backup.scope !== intent.scope
    || backup.identity !== intent.identity || backup.sourceSnapshotSha256 !== intent.expectedSnapshotSha256
    || backup.sourcePresent !== receipt.sourcePresent || backup.contentSha256 !== receipt.contentSha256
    || backup.bytes !== receipt.bytes || backup.files !== receipt.files || backup.directories !== receipt.directories) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_evidence_not_satisfied',
      'Verified mail data backup does not match the completed operation',
    );
  }
  return backupResultFromReceipt(intent, receipt);
}

async function verifyRestoreEvidence(intent, receipt, identity, inspectBackup, inspectRestored) {
  let selected;
  let preRestore;
  let live;
  try {
    [selected, preRestore, live] = await Promise.all([
      inspectBackup(intent.backupId),
      inspectBackup(`pre-restore:${identity.jobId}`),
      inspectRestored({ backupId: intent.backupId, scope: intent.scope, identity: intent.identity }),
    ]);
  } catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_evidence_failed', 'Mail data restore evidence could not be verified');
  }
  if (!selected || selected.backupId !== intent.backupId || selected.scope !== intent.scope
    || selected.identity !== intent.identity || selected.sourcePresent !== true
    || selected.contentSha256 !== receipt.contentSha256 || selected.bytes !== receipt.bytes
    || selected.files !== receipt.files || selected.directories !== receipt.directories
    || !preRestore || preRestore.backupId !== `pre-restore:${identity.jobId}`
    || preRestore.scope !== intent.scope || preRestore.identity !== intent.identity
    || preRestore.sourceSnapshotSha256 !== intent.expectedTargetSnapshotSha256
    || !live || live.satisfied !== true || !live.result
    || live.result.backupId !== intent.backupId || live.result.scope !== intent.scope
    || live.result.identity !== intent.identity || live.result.contentSha256 !== receipt.contentSha256
    || live.result.bytes !== receipt.bytes || live.result.files !== receipt.files
    || live.result.directories !== receipt.directories || live.result.restoredPresent !== true
    || live.result.applied !== true || live.result.sideEffects !== true) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_evidence_not_satisfied',
      'Live mail data restore state does not match the completed operation',
    );
  }
  return restoreResultFromReceipt(intent, receipt);
}

async function verifyDeleteEvidence(intent, receipt, identity, inspectBackup, inspectDeleted) {
  let selected;
  let absence;
  try {
    [selected, absence] = await Promise.all([
      inspectBackup(intent.backupId),
      inspectDeleted({
        transactionId: identity.jobId,
        backupId: intent.backupId,
        scope: intent.scope,
        identity: intent.identity,
      }),
    ]);
  } catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_evidence_failed', 'Mail data delete evidence could not be verified');
  }
  if (!selected || selected.backupId !== intent.backupId || selected.scope !== intent.scope
    || selected.identity !== intent.identity || selected.sourcePresent !== receipt.sourcePresent
    || selected.contentSha256 !== receipt.contentSha256 || selected.bytes !== receipt.bytes
    || selected.files !== receipt.files || selected.directories !== receipt.directories
    || !absence || absence.satisfied !== true || !absence.result
    || absence.result.transactionId !== identity.jobId || absence.result.backupId !== intent.backupId
    || absence.result.scope !== intent.scope || absence.result.identity !== intent.identity
    || absence.result.sourcePresent !== receipt.sourcePresent
    || absence.result.contentSha256 !== receipt.contentSha256
    || absence.result.bytes !== receipt.bytes || absence.result.files !== receipt.files
    || absence.result.directories !== receipt.directories
    || absence.result.deleted !== true || absence.result.sideEffects !== true) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_evidence_not_satisfied',
      'Mail data target or delete tombstone still exists or the verified backup does not match',
    );
  }
  return deleteResultFromReceipt(intent, receipt);
}

export async function recoverRunningMailData({
  serverId,
  jobId,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  mailDomainRegistry,
  mailboxRegistry,
  serviceStatus,
  loadJobContext,
  readOperationReceipt,
  inspectBackup,
  inspectRestored,
  inspectDeleted,
  inspect = inspectDurableJobRecovery,
  reconcile = reconcileCompletedJob,
} = {}) {
  const identity = normalizeIdentity(serverId, jobId);
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function' || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !domainRegistry || !certificateRegistry || !applicationRegistry
    || !mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !mailboxRegistry || typeof mailboxRegistry.getMailbox !== 'function'
    || typeof serviceStatus !== 'function' || typeof loadJobContext !== 'function'
    || typeof readOperationReceipt !== 'function' || typeof inspectBackup !== 'function'
    || typeof inspectRestored !== 'function' || typeof inspectDeleted !== 'function'
    || typeof inspect !== 'function' || typeof reconcile !== 'function') {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_dependencies_invalid',
      'Mail data recovery dependencies are invalid',
    );
  }

  await requireStoppedConsumers(serviceStatus);
  let inspection;
  try { inspection = await inspect({ registry: jobRegistry }); }
  catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_inspection_failed', 'Durable mail data recovery state could not be inspected');
  }
  if (!inspection || !Array.isArray(inspection.jobs)) {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_inspection_invalid', 'Durable mail data recovery state is invalid');
  }
  const candidate = inspection.jobs.find((entry) => entry.jobId === identity.jobId && entry.serverId === identity.serverId) ?? null;
  assertCandidate(candidate, identity);

  let job;
  try { job = await jobRegistry.getJob(identity.jobId); }
  catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_job_read_failed', 'Running mail data job could not be read');
  }
  if (!job || job.id !== identity.jobId || job.serverId !== identity.serverId || job.status !== 'running'
    || job.operation !== candidate.operation || job.resourceType !== 'mail_domain'
    || job.resourceId !== candidate.resourceId) {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_job_mismatch', 'Running mail data job no longer matches durable recovery state');
  }

  let context;
  try { context = await loadJobContext(identity.jobId); }
  catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_context_failed', 'Private mail data recovery context could not be read');
  }
  const intent = recoveryIntent(context, job, candidate, identity);
  await assertCurrentResource(intent, { mailDomainRegistry, mailboxRegistry });

  let receipt;
  try { receipt = await readOperationReceipt(identity.serverId, identity.jobId); }
  catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_receipt_failed', 'Mail data operation receipt could not be read');
  }
  if (!receipt) {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_receipt_missing',
      'Mail data operation receipt is absent; the running job remains unresolved',
    );
  }
  assertReceipt(receipt, identity, intent);

  let result;
  if (intent.operation === OPERATIONS.MAIL_DATA_BACKUP) {
    result = await verifyBackupEvidence(intent, receipt, identity, inspectBackup);
  } else if (intent.operation === OPERATIONS.MAIL_DATA_DELETE) {
    result = await verifyDeleteEvidence(intent, receipt, identity, inspectBackup, inspectDeleted);
  } else {
    result = await verifyRestoreEvidence(intent, receipt, identity, inspectBackup, inspectRestored);
  }

  let begun;
  try { begun = await jobRegistry.beginReconciliation(identity); }
  catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_journal_failed', 'Mail data recovery journal could not be opened');
  }
  if (!begun || begun.jobId !== identity.jobId || begun.serverId !== identity.serverId
    || begun.status !== 'running' || begun.pending !== true) {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_journal_invalid', 'Mail data recovery journal acknowledgement is inconsistent');
  }

  let terminal;
  try { terminal = await jobRegistry.complete({ serverId: identity.serverId, jobId: identity.jobId, status: 'succeeded', result }); }
  catch {
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_completion_failed',
      'Mail data evidence was verified but durable completion could not be confirmed',
    );
  }
  if (!terminal || terminal.id !== identity.jobId || terminal.serverId !== identity.serverId
    || terminal.status !== 'succeeded' || terminal.operation !== intent.operation
    || terminal.resourceType !== 'mail_domain' || terminal.resourceId !== intent.mailDomainId) {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_completion_invalid', 'Mail data recovery completion acknowledgement is inconsistent');
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
    throw new JobRunningMailDataRecoveryError(
      'job_mail_data_recovery_reconciliation_failed',
      'Mail data job is terminal but reconciliation remains pending',
    );
  }

  let acknowledgement;
  try { acknowledgement = await jobRegistry.acknowledgeReconciliation(identity); }
  catch {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_acknowledgement_failed', 'Mail data recovery reconciliation could not be durably acknowledged');
  }
  if (!acknowledgement || acknowledgement.acknowledged !== true || acknowledgement.jobId !== identity.jobId
    || acknowledgement.serverId !== identity.serverId || acknowledgement.status !== 'succeeded') {
    throw new JobRunningMailDataRecoveryError('job_mail_data_recovery_acknowledgement_invalid', 'Mail data recovery acknowledgement is inconsistent');
  }

  const recoveryMethod = intent.operation === OPERATIONS.MAIL_DATA_BACKUP
    ? 'verified_mail_data_backup_receipt_and_manifest'
    : intent.operation === OPERATIONS.MAIL_DATA_DELETE
      ? 'verified_mail_data_delete_receipt_backup_and_absence'
      : 'verified_mail_data_restore_receipt_backup_and_live_state';
  return Object.freeze({
    serverId: identity.serverId,
    jobId: identity.jobId,
    operation: intent.operation,
    status: 'succeeded',
    recoveryMethod,
    reconciled: true,
  });
}

export const jobRunningMailDataRecoveryInternals = Object.freeze({
  normalizeIdentity,
  requireStoppedConsumers,
  assertCandidate,
  recoveryIntent,
  assertReceipt,
  assertCurrentResource,
  verifyBackupEvidence,
  verifyRestoreEvidence,
  verifyDeleteEvidence,
});