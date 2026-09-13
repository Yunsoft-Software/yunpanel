import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);

export class MailDataOperationsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDataOperationsError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function positiveRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MailDataOperationsError('mail_data_revision_invalid', 'Mail data resource revision is invalid');
  }
  return value;
}

function previewDigest(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new MailDataOperationsError('mail_data_preview_digest_invalid', 'Mail data preview digest is invalid');
  }
  return value;
}

function backupId(value) {
  if (typeof value !== 'string' || !BACKUP_ID_PATTERN.test(value)) {
    throw new MailDataOperationsError('mail_data_backup_id_invalid', 'Mail data backup id is invalid');
  }
  return value;
}

export function createMailDataOperationsService({
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
    || !mailboxRegistry || typeof mailboxRegistry.getMailbox !== 'function'
    || !mailDataInspector || typeof mailDataInspector.inspectMailbox !== 'function'
    || typeof mailDataInspector.inspectDomain !== 'function'
    || !mailDataBackupManager || typeof mailDataBackupManager.inspectBackup !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function') {
    throw new MailDataOperationsError('mail_data_dependencies_invalid', 'Mail data operation dependencies are unavailable', 503);
  }

  async function scopedMailDomain(mailDomainId) {
    const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
    if (!mailDomain || mailDomain.managementMode !== 'local' || !mailDomain.webDomainId) {
      throw new MailDataOperationsError('mail_domain_not_found', 'Local mail domain was not found', 404);
    }
    const domain = await domainRegistry.getDomain(mailDomain.webDomainId);
    if (!domain || domain.primaryDomain !== mailDomain.domainName
      || (localServerId !== null && domain.serverId !== localServerId)) {
      throw new MailDataOperationsError('mail_domain_not_found', 'Local mail domain was not found', 404);
    }
    return Object.freeze({ mailDomain, domain });
  }

  async function resource(scope, resourceId) {
    if (scope === 'domain') {
      const { mailDomain, domain } = await scopedMailDomain(resourceId);
      return Object.freeze({
        scope,
        resourceId: mailDomain.id,
        mailDomain,
        domain,
        identity: mailDomain.domainName,
        revision: mailDomain.revision,
      });
    }
    if (scope !== 'mailbox') {
      throw new MailDataOperationsError('mail_data_scope_invalid', 'Mail data scope must be mailbox or domain');
    }
    const mailbox = await mailboxRegistry.getMailbox(resourceId);
    if (!mailbox) throw new MailDataOperationsError('mailbox_not_found', 'Mailbox was not found', 404);
    const { mailDomain, domain } = await scopedMailDomain(mailbox.mailDomainId);
    return Object.freeze({
      scope,
      resourceId: mailbox.id,
      mailDomain,
      domain,
      mailbox,
      identity: mailbox.address,
      revision: mailbox.revision,
    });
  }

  async function assertMailDomainIdle(mailDomainId) {
    let jobs;
    try { jobs = await jobRegistry.listJobs({ resourceType: 'mail_domain', resourceId: mailDomainId }); }
    catch {
      throw new MailDataOperationsError('mail_data_job_state_unavailable', 'Mail data job state could not be inspected', 503);
    }
    if (!Array.isArray(jobs)) {
      throw new MailDataOperationsError('mail_data_job_state_unavailable', 'Mail data job state is invalid', 503);
    }
    if (jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))) {
      throw new MailDataOperationsError('mail_domain_job_conflict', 'Wait for the active mail-domain operation', 409);
    }
  }

  async function inspectData(target) {
    try {
      return target.scope === 'mailbox'
        ? await mailDataInspector.inspectMailbox(target.identity)
        : await mailDataInspector.inspectDomain(target.identity);
    } catch {
      throw new MailDataOperationsError('mail_data_inspection_failed', 'Managed mail data could not be inspected', 503);
    }
  }

  function backupPreviewIdentity(target, data) {
    return Object.freeze({
      version: 1,
      operation: 'mail_data_backup',
      mailDomainId: target.mailDomain.id,
      scope: target.scope,
      resourceId: target.resourceId,
      identity: target.identity,
      expectedRevision: target.revision,
      snapshotSha256: data.snapshotSha256,
      sourcePresent: data.present,
      bytes: data.bytes,
    });
  }

  async function previewBackup({ scope, resourceId } = {}) {
    const target = await resource(scope, resourceId);
    await assertMailDomainIdle(target.mailDomain.id);
    const data = await inspectData(target);
    const identity = backupPreviewIdentity(target, data);
    const sha256 = digest(identity);
    return Object.freeze({
      ...identity,
      previewDigest: sha256,
      confirmation: `backup-mail-data:${target.mailDomain.id}:${sha256}`,
      sideEffects: false,
    });
  }

  function sameTarget(target, current) {
    return target.mailDomain.id === current.mailDomainId
      && target.scope === current.scope
      && target.resourceId === current.resourceId
      && target.identity === current.identity
      && target.revision === current.expectedRevision;
  }

  async function queueBackup({ scope, resourceId, expectedRevision, expectedPreviewDigest, confirmation } = {}) {
    const expected = positiveRevision(expectedRevision);
    const requestedDigest = previewDigest(expectedPreviewDigest);
    const current = await previewBackup({ scope, resourceId });
    if (current.expectedRevision !== expected || current.previewDigest !== requestedDigest) {
      throw new MailDataOperationsError('mail_data_backup_preview_stale', 'Mail data backup preview is stale', 409);
    }
    if (confirmation !== current.confirmation) {
      throw new MailDataOperationsError('mail_data_backup_confirmation_invalid', 'Mail data backup confirmation is invalid', 409);
    }
    const target = await resource(scope, resourceId);
    if (!sameTarget(target, current)) {
      throw new MailDataOperationsError('mail_data_backup_preview_stale', 'Mail data backup resource changed before enqueue', 409);
    }
    const job = await jobRegistry.enqueue({
      serverId: target.domain.serverId,
      type: 'mail_data_backup',
      operation: OPERATIONS.MAIL_DATA_BACKUP,
      payload: {
        mailDomainId: current.mailDomainId,
        resourceId: current.resourceId,
        scope: current.scope,
        identity: current.identity,
        expectedResourceRevision: current.expectedRevision,
        expectedSnapshotSha256: current.snapshotSha256,
      },
      resourceType: 'mail_domain',
      resourceId: current.mailDomainId,
      idempotencyKey: `mail-data-backup:${current.mailDomainId}:${current.previewDigest}`,
    });
    return Object.freeze({ previewDigest: current.previewDigest, job });
  }

  async function selectedBackup(id) {
    const normalized = backupId(id);
    let selected;
    try { selected = await mailDataBackupManager.inspectBackup(normalized); }
    catch {
      throw new MailDataOperationsError('mail_data_backup_unavailable', 'Selected mail data backup could not be verified', 503);
    }
    if (!selected) throw new MailDataOperationsError('mail_data_backup_not_found', 'Selected mail data backup was not found', 404);
    return selected;
  }

  async function previewRestore({ scope, resourceId, backupId: requestedBackupId } = {}) {
    const target = await resource(scope, resourceId);
    if (target.mailDomain.status !== 'disabled') {
      throw new MailDataOperationsError(
        'mail_data_restore_domain_disable_required',
        'Disable and apply the mail domain configuration before restoring mail data',
        409,
      );
    }
    await assertMailDomainIdle(target.mailDomain.id);
    const selected = await selectedBackup(requestedBackupId);
    if (selected.scope !== target.scope || selected.identity !== target.identity || selected.sourcePresent !== true) {
      throw new MailDataOperationsError('mail_data_restore_backup_mismatch', 'Selected backup does not match this mail data resource', 409);
    }
    const current = await inspectData(target);
    const identity = Object.freeze({
      version: 1,
      operation: 'mail_data_restore',
      mailDomainId: target.mailDomain.id,
      scope: target.scope,
      resourceId: target.resourceId,
      identity: target.identity,
      expectedRevision: target.revision,
      backupId: selected.backupId,
      backupContentSha256: selected.contentSha256,
      backupBytes: selected.bytes,
      targetSnapshotSha256: current.snapshotSha256,
      targetPresent: current.present,
      targetBytes: current.bytes,
    });
    const sha256 = digest(identity);
    return Object.freeze({
      ...identity,
      previewDigest: sha256,
      confirmation: `restore-mail-data:${target.mailDomain.id}:${sha256}`,
      sideEffects: false,
    });
  }

  async function queueRestore({
    scope,
    resourceId,
    backupId: requestedBackupId,
    expectedRevision,
    expectedPreviewDigest,
    confirmation,
  } = {}) {
    const expected = positiveRevision(expectedRevision);
    const requestedDigest = previewDigest(expectedPreviewDigest);
    const current = await previewRestore({ scope, resourceId, backupId: requestedBackupId });
    if (current.expectedRevision !== expected || current.previewDigest !== requestedDigest) {
      throw new MailDataOperationsError('mail_data_restore_preview_stale', 'Mail data restore preview is stale', 409);
    }
    if (confirmation !== current.confirmation) {
      throw new MailDataOperationsError('mail_data_restore_confirmation_invalid', 'Mail data restore confirmation is invalid', 409);
    }
    const target = await resource(scope, resourceId);
    if (!sameTarget(target, current) || target.mailDomain.status !== 'disabled') {
      throw new MailDataOperationsError('mail_data_restore_preview_stale', 'Mail data restore resource changed before enqueue', 409);
    }
    const job = await jobRegistry.enqueue({
      serverId: target.domain.serverId,
      type: 'mail_data_restore',
      operation: OPERATIONS.MAIL_DATA_RESTORE,
      payload: {
        mailDomainId: current.mailDomainId,
        resourceId: current.resourceId,
        backupId: current.backupId,
        scope: current.scope,
        identity: current.identity,
        expectedResourceRevision: current.expectedRevision,
        expectedTargetSnapshotSha256: current.targetSnapshotSha256,
      },
      resourceType: 'mail_domain',
      resourceId: current.mailDomainId,
      idempotencyKey: `mail-data-restore:${current.mailDomainId}:${current.previewDigest}`,
    });
    return Object.freeze({ previewDigest: current.previewDigest, job });
  }

  return Object.freeze({ previewBackup, queueBackup, previewRestore, queueRestore });
}

export const mailDataOperationsInternals = Object.freeze({
  digest,
  positiveRevision,
  previewDigest,
  backupId,
});
