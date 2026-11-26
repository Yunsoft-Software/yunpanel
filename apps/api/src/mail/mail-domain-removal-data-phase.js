import { OPERATIONS } from '@yunpanel/protocol';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export class MailDomainRemovalDataPhaseError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainRemovalDataPhaseError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new MailDomainRemovalDataPhaseError(code, message, status);
}

function evidence(operation, overrides = {}) {
  return Object.freeze({
    disableJobId: operation.disableJobId,
    finalRevision: operation.finalRevision,
    cleanupEvidenceDigest: operation.cleanupEvidenceDigest,
    dataDeleteJobId: operation.dataDeleteJobId,
    backupId: operation.backupId,
    ...overrides,
  });
}

function outcome(operation, disposition, details, sideEffects) {
  return Object.freeze({
    version: 1,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    fromStatus: operation.status,
    disposition,
    sideEffects,
    ...details,
  });
}

function blocked(operation, code, message, sideEffects) {
  return outcome(operation, 'blocked', {
    error: Object.freeze({ code, message }),
  }, sideEffects);
}

function failed(operation, code, message, sideEffects) {
  return outcome(operation, 'failed', {
    error: Object.freeze({ code, message }),
  }, sideEffects);
}

function validMailData(value) {
  return Boolean(value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.present === 'boolean'
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
    && typeof value.snapshotSha256 === 'string'
    && SHA256_PATTERN.test(value.snapshotSha256));
}

function operationIdentity(operation) {
  const plan = operation?.cleanupPlan;
  const expectedFinalRevision = operation?.sourceRevision
    + (operation?.sourceStatus === 'enabled' ? 1 : 0);
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)
    || typeof operation.id !== 'string' || !operation.id
    || operation.managementMode !== 'local'
    || !['enabled', 'disabled'].includes(operation.sourceStatus)
    || !Number.isSafeInteger(operation.sourceRevision) || operation.sourceRevision < 1
    || !Number.isSafeInteger(operation.finalRevision)
    || operation.finalRevision !== expectedFinalRevision
    || typeof operation.mailDomainId !== 'string' || !operation.mailDomainId
    || typeof operation.webDomainId !== 'string' || !operation.webDomainId
    || typeof operation.domainName !== 'string' || !operation.domainName
    || !['backing_up', 'deleting_data'].includes(operation.status)
    || typeof operation.cleanupEvidenceDigest !== 'string'
    || !SHA256_PATTERN.test(operation.cleanupEvidenceDigest)
    || !plan || plan.version !== 2 || plan.mailDomainId !== operation.mailDomainId
    || !Array.isArray(plan.mailboxes) || !validMailData(plan.mailData)
    || (operation.status === 'backing_up' && operation.dataDeleteJobId !== null)
    || (operation.status === 'deleting_data' && operation.backupId === null)) {
    fail(
      'mail_domain_removal_data_operation_invalid',
      'Mail Domain removal data operation is invalid',
    );
  }
  return operation;
}

function exactMailbox(current, pinned, mailDomainId) {
  return Boolean(current
    && pinned
    && current.id === pinned.id
    && current.mailDomainId === mailDomainId
    && current.address === pinned.address
    && current.enabled === pinned.enabled
    && current.revision === pinned.revision
    && current.updatedAt === pinned.updatedAt);
}

function backupIdempotencyKey(operation) {
  return 'mail-domain-remove-backup:' + operation.id;
}

function deleteIdempotencyKey(operation) {
  return 'mail-domain-remove-data:' + operation.id;
}

function backupRequest(operation, serverId) {
  return Object.freeze({
    serverId,
    type: 'mail_data_backup',
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    payload: Object.freeze({
      mailDomainId: operation.mailDomainId,
      resourceId: operation.mailDomainId,
      scope: 'domain',
      identity: operation.domainName,
      expectedResourceRevision: operation.finalRevision,
      expectedSnapshotSha256: operation.cleanupPlan.mailData.snapshotSha256,
    }),
    resourceType: 'mail_domain',
    resourceId: operation.mailDomainId,
    idempotencyKey: backupIdempotencyKey(operation),
  });
}

function deleteRequest(operation, serverId) {
  return Object.freeze({
    serverId,
    type: 'mail_data_delete',
    operation: OPERATIONS.MAIL_DATA_DELETE,
    payload: Object.freeze({
      mailDomainId: operation.mailDomainId,
      resourceId: operation.mailDomainId,
      backupId: operation.backupId,
      scope: 'domain',
      identity: operation.domainName,
      expectedResourceRevision: operation.finalRevision,
      expectedTargetSnapshotSha256: operation.cleanupPlan.mailData.snapshotSha256,
    }),
    resourceType: 'mail_domain',
    resourceId: operation.mailDomainId,
    idempotencyKey: deleteIdempotencyKey(operation),
  });
}

function jobMatches(job, operation, serverId, expectedOperation, expectedType, expectedId = null) {
  return Boolean(job
    && typeof job.id === 'string' && job.id.length >= 8
    && (expectedId === null || job.id === expectedId)
    && job.serverId === serverId
    && job.type === expectedType
    && job.operation === expectedOperation
    && job.resourceType === 'mail_domain'
    && job.resourceId === operation.mailDomainId
    && [...ACTIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES].includes(job.status));
}

function successfulBackupJob(job, operation) {
  const result = job?.result;
  const pinned = operation.cleanupPlan.mailData;
  return Boolean(job?.status === 'succeeded'
    && result?.version === 1
    && result.backupId === job.id
    && result.mailDomainId === operation.mailDomainId
    && result.scope === 'domain'
    && result.identity === operation.domainName
    && result.sourcePresent === pinned.present
    && result.sourceSnapshotSha256 === pinned.snapshotSha256
    && typeof result.contentSha256 === 'string' && SHA256_PATTERN.test(result.contentSha256)
    && Number.isSafeInteger(result.bytes) && result.bytes >= 0
    && Number.isSafeInteger(result.files) && result.files >= 0
    && Number.isSafeInteger(result.directories) && result.directories >= 0
    && result.backedUp === true
    && result.sideEffects === true);
}

function successfulDeleteJob(job, operation) {
  const result = job?.result;
  const pinned = operation.cleanupPlan.mailData;
  return Boolean(job?.status === 'succeeded'
    && result?.version === 1
    && result.transactionId === job.id
    && result.backupId === operation.backupId
    && result.mailDomainId === operation.mailDomainId
    && result.resourceId === operation.mailDomainId
    && result.expectedResourceRevision === operation.finalRevision
    && result.scope === 'domain'
    && result.identity === operation.domainName
    && result.sourcePresent === pinned.present
    && typeof result.contentSha256 === 'string' && SHA256_PATTERN.test(result.contentSha256)
    && Number.isSafeInteger(result.bytes) && result.bytes >= 0
    && Number.isSafeInteger(result.files) && result.files >= 0
    && Number.isSafeInteger(result.directories) && result.directories >= 0
    && result.deleted === true
    && result.sideEffects === true);
}

export function createMailDomainRemovalDataPhase({
  mailDomainRegistry,
  domainRegistry,
  mailboxRegistry,
  mailDataInspector,
  mailDataBackupManager,
  jobRegistry,
  localServerId = null,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailboxRegistry || typeof mailboxRegistry.listMailboxes !== 'function'
    || typeof mailboxRegistry.deleteMailbox !== 'function'
    || !mailDataInspector || typeof mailDataInspector.inspectDomain !== 'function'
    || !mailDataBackupManager || typeof mailDataBackupManager.inspectBackup !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function'
    || typeof jobRegistry.getJob !== 'function') {
    throw new MailDomainRemovalDataPhaseError(
      'mail_domain_removal_data_dependencies_invalid',
      'Mail Domain removal data phase dependencies are unavailable',
      503,
    );
  }

  async function currentState(operation) {
    let mailDomain;
    let domain;
    try {
      [mailDomain, domain] = await Promise.all([
        mailDomainRegistry.getMailDomain(operation.mailDomainId),
        domainRegistry.getDomain(operation.webDomainId),
      ]);
    } catch {
      fail(
        'mail_domain_removal_data_state_unavailable',
        'Mail Domain data state could not be inspected',
        503,
      );
    }
    if (!mailDomain || mailDomain.id !== operation.mailDomainId
      || mailDomain.webDomainId !== operation.webDomainId
      || mailDomain.domainName !== operation.domainName
      || mailDomain.managementMode !== 'local'
      || mailDomain.status !== 'disabled'
      || mailDomain.revision !== operation.finalRevision
      || !domain || domain.id !== operation.webDomainId
      || domain.primaryDomain !== operation.domainName
      || typeof domain.serverId !== 'string' || !domain.serverId
      || (localServerId !== null && domain.serverId !== localServerId)) {
      fail(
        'mail_domain_removal_data_state_drift',
        'Mail Domain data identity changed after removal approval',
      );
    }
    return Object.freeze({ mailDomain, serverId: domain.serverId });
  }

  async function currentData(operation) {
    let value;
    try { value = await mailDataInspector.inspectDomain(operation.domainName); }
    catch {
      fail(
        'mail_domain_removal_data_inspection_failed',
        'Mail Domain data could not be inspected',
        503,
      );
    }
    if (!value || value.version !== 1 || value.scope !== 'domain'
      || value.identity !== operation.domainName
      || typeof value.present !== 'boolean'
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0
      || typeof value.snapshotSha256 !== 'string' || !SHA256_PATTERN.test(value.snapshotSha256)
      || value.sideEffects !== false) {
      fail(
        'mail_domain_removal_data_inspection_invalid',
        'Mail Domain data inspection result is invalid',
        503,
      );
    }
    return value;
  }

  function pinnedDataMatches(operation, value) {
    const pinned = operation.cleanupPlan.mailData;
    return value.present === pinned.present
      && value.bytes === pinned.bytes
      && value.snapshotSha256 === pinned.snapshotSha256;
  }

  async function verifiedBackup(operation) {
    let backup;
    try { backup = await mailDataBackupManager.inspectBackup(operation.backupId); }
    catch {
      fail(
        'mail_domain_removal_backup_unavailable',
        'Mail Domain backup could not be verified',
        503,
      );
    }
    const pinned = operation.cleanupPlan.mailData;
    if (!backup || backup.backupId !== operation.backupId
      || backup.scope !== 'domain'
      || backup.identity !== operation.domainName
      || backup.sourcePresent !== pinned.present
      || backup.sourceSnapshotSha256 !== pinned.snapshotSha256
      || typeof backup.contentSha256 !== 'string' || !SHA256_PATTERN.test(backup.contentSha256)
      || !Number.isSafeInteger(backup.bytes) || backup.bytes < 0
      || !Number.isSafeInteger(backup.files) || backup.files < 0
      || !Number.isSafeInteger(backup.directories) || backup.directories < 0
      || backup.sideEffects !== true) {
      fail(
        'mail_domain_removal_backup_mismatch',
        'Mail Domain backup does not match the approved data snapshot',
      );
    }
    return backup;
  }

  async function mailboxes(operation) {
    let current;
    try { current = await mailboxRegistry.listMailboxes({ mailDomainId: operation.mailDomainId }); }
    catch {
      fail(
        'mail_domain_removal_mailbox_inventory_unavailable',
        'Mailbox credential inventory could not be inspected',
        503,
      );
    }
    if (!Array.isArray(current)) {
      fail(
        'mail_domain_removal_mailbox_inventory_invalid',
        'Mailbox credential inventory is invalid',
        503,
      );
    }
    const pinnedById = new Map(operation.cleanupPlan.mailboxes.map((mailbox) => [mailbox.id, mailbox]));
    if (current.some((mailbox) => {
      const pinned = pinnedById.get(mailbox?.id);
      return !pinned || !exactMailbox(mailbox, pinned, operation.mailDomainId);
    })) {
      return Object.freeze({ drift: true, next: null });
    }
    const currentIds = new Set(current.map((mailbox) => mailbox.id));
    const next = operation.cleanupPlan.mailboxes.find((mailbox) => currentIds.has(mailbox.id)) ?? null;
    return Object.freeze({ drift: false, next });
  }

  async function dispatchBackup(operation, serverId) {
    const data = await currentData(operation);
    if (!pinnedDataMatches(operation, data)) {
      return failed(
        operation,
        'mail_domain_removal_backup_source_drift',
        'Mail Domain data changed after removal approval',
        true,
      );
    }
    let job;
    try { job = await jobRegistry.enqueue(backupRequest(operation, serverId)); }
    catch (error) {
      if (Number(error?.status) === 409) {
        return blocked(
          operation,
          'mail_domain_removal_backup_job_conflict',
          'Another Mail Domain operation is active',
          true,
        );
      }
      fail(
        'mail_domain_removal_backup_dispatch_failed',
        'Mail Domain backup job could not be queued',
        503,
      );
    }
    if (!jobMatches(
      job,
      operation,
      serverId,
      OPERATIONS.MAIL_DATA_BACKUP,
      'mail_data_backup',
    )) {
      return failed(
        operation,
        'mail_domain_removal_backup_job_mismatch',
        'Mail Domain backup job does not match removal intent',
        true,
      );
    }
    return outcome(operation, 'advance', {
      status: 'backing_up',
      evidence: evidence(operation, { backupId: job.id }),
    }, true);
  }

  async function inspectBackupJob(operation, serverId, { sideEffects }) {
    let job;
    try { job = await jobRegistry.getJob(operation.backupId); }
    catch {
      return blocked(
        operation,
        'mail_domain_removal_backup_job_unavailable',
        'Mail Domain backup job could not be inspected',
        sideEffects,
      );
    }
    if (!jobMatches(
      job,
      operation,
      serverId,
      OPERATIONS.MAIL_DATA_BACKUP,
      'mail_data_backup',
      operation.backupId,
    )) {
      return failed(
        operation,
        'mail_domain_removal_backup_job_mismatch',
        'Mail Domain backup job does not match removal intent',
        sideEffects,
      );
    }
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      return blocked(
        operation,
        'mail_domain_removal_backup_job_pending',
        'Mail Domain backup job is still active',
        sideEffects,
      );
    }
    if (!successfulBackupJob(job, operation)) {
      return failed(
        operation,
        'mail_domain_removal_backup_job_failed',
        'Mail Domain backup job did not produce exact success evidence',
        sideEffects,
      );
    }
    try { await verifiedBackup(operation); }
    catch (error) {
      return failed(
        operation,
        error.code ?? 'mail_domain_removal_backup_mismatch',
        error.message ?? 'Mail Domain backup could not be verified',
        sideEffects,
      );
    }
    return outcome(operation, 'advance', {
      status: 'deleting_data',
      evidence: evidence(operation),
    }, sideEffects);
  }

  async function removeNextMailbox(operation, assessment) {
    try {
      await mailboxRegistry.deleteMailbox(assessment.next.id, {
        expectedRevision: assessment.next.revision,
        confirmation: 'delete-mailbox:' + assessment.next.address,
      });
    } catch {
      fail(
        'mail_domain_removal_mailbox_cleanup_failed',
        'Mailbox credential could not be removed',
        503,
      );
    }
    return outcome(operation, 'advance', {
      status: 'deleting_data',
      evidence: evidence(operation),
    }, true);
  }

  async function dispatchDelete(operation, serverId) {
    try { await verifiedBackup(operation); }
    catch (error) {
      return failed(
        operation,
        error.code ?? 'mail_domain_removal_backup_mismatch',
        error.message ?? 'Mail Domain backup could not be verified',
        true,
      );
    }
    const data = await currentData(operation);
    if (!pinnedDataMatches(operation, data)) {
      return failed(
        operation,
        'mail_domain_removal_delete_source_drift',
        'Mail Domain data changed after the verified backup',
        true,
      );
    }
    let job;
    try { job = await jobRegistry.enqueue(deleteRequest(operation, serverId)); }
    catch (error) {
      if (Number(error?.status) === 409) {
        return blocked(
          operation,
          'mail_domain_removal_data_delete_job_conflict',
          'Another Mail Domain operation is active',
          true,
        );
      }
      fail(
        'mail_domain_removal_data_delete_dispatch_failed',
        'Mail Domain data delete job could not be queued',
        503,
      );
    }
    if (!jobMatches(
      job,
      operation,
      serverId,
      OPERATIONS.MAIL_DATA_DELETE,
      'mail_data_delete',
    )) {
      return failed(
        operation,
        'mail_domain_removal_data_delete_job_mismatch',
        'Mail Domain data delete job does not match removal intent',
        true,
      );
    }
    return outcome(operation, 'advance', {
      status: 'deleting_data',
      evidence: evidence(operation, { dataDeleteJobId: job.id }),
    }, true);
  }

  async function inspectDeleteJob(operation, serverId, { sideEffects }) {
    let job;
    try { job = await jobRegistry.getJob(operation.dataDeleteJobId); }
    catch {
      return blocked(
        operation,
        'mail_domain_removal_data_delete_job_unavailable',
        'Mail Domain data delete job could not be inspected',
        sideEffects,
      );
    }
    if (!jobMatches(
      job,
      operation,
      serverId,
      OPERATIONS.MAIL_DATA_DELETE,
      'mail_data_delete',
      operation.dataDeleteJobId,
    )) {
      return failed(
        operation,
        'mail_domain_removal_data_delete_job_mismatch',
        'Mail Domain data delete job does not match removal intent',
        sideEffects,
      );
    }
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      return blocked(
        operation,
        'mail_domain_removal_data_delete_job_pending',
        'Mail Domain data delete job is still active',
        sideEffects,
      );
    }
    if (!successfulDeleteJob(job, operation)) {
      return failed(
        operation,
        'mail_domain_removal_data_delete_job_failed',
        'Mail Domain data delete job did not produce exact success evidence',
        sideEffects,
      );
    }
    const data = await currentData(operation);
    if (data.present !== false) {
      return blocked(
        operation,
        'mail_domain_removal_data_delete_reconciliation_pending',
        'Mail Domain data deletion has not reached the required absent post-condition',
        sideEffects,
      );
    }
    return outcome(operation, 'advance', {
      status: 'finalizing',
      evidence: evidence(operation),
    }, sideEffects);
  }

  async function execute(operationValue) {
    const operation = operationIdentity(operationValue);
    const { serverId } = await currentState(operation);
    if (operation.status === 'backing_up') {
      if (operation.backupId === null) return dispatchBackup(operation, serverId);
      return inspectBackupJob(operation, serverId, { sideEffects: true });
    }

    const assessment = await mailboxes(operation);
    if (assessment.drift) {
      return failed(
        operation,
        'mail_domain_removal_mailbox_drift',
        'Mailbox credential state changed after removal approval',
        true,
      );
    }
    if (assessment.next) return removeNextMailbox(operation, assessment);
    if (operation.dataDeleteJobId === null) return dispatchDelete(operation, serverId);
    return inspectDeleteJob(operation, serverId, { sideEffects: true });
  }

  async function inspect(operationValue) {
    const operation = operationIdentity(operationValue);
    const { serverId } = await currentState(operation);
    if (operation.status === 'backing_up') {
      if (operation.backupId === null) {
        return blocked(
          operation,
          'mail_domain_removal_backup_dispatch_required',
          'Mail Domain backup requires explicit continuation',
          false,
        );
      }
      return inspectBackupJob(operation, serverId, { sideEffects: false });
    }

    const assessment = await mailboxes(operation);
    if (assessment.drift) {
      return failed(
        operation,
        'mail_domain_removal_mailbox_drift',
        'Mailbox credential state changed after removal approval',
        false,
      );
    }
    if (assessment.next) {
      return blocked(
        operation,
        'mail_domain_removal_mailbox_cleanup_retry_required',
        'Mailbox credential cleanup requires explicit continuation',
        false,
      );
    }
    if (operation.dataDeleteJobId === null) {
      return blocked(
        operation,
        'mail_domain_removal_data_delete_dispatch_required',
        'Mail Domain data delete requires explicit continuation',
        false,
      );
    }
    return inspectDeleteJob(operation, serverId, { sideEffects: false });
  }

  return Object.freeze({ execute, inspect });
}

export const mailDomainRemovalDataPhaseInternals = Object.freeze({
  operationIdentity,
  exactMailbox,
  backupIdempotencyKey,
  deleteIdempotencyKey,
  backupRequest,
  deleteRequest,
  jobMatches,
  successfulBackupJob,
  successfulDeleteJob,
});
