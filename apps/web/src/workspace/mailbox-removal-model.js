// Public mailbox/data API projections only; no credentials, intents or raw errors.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const JOB_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => count(value) && value > 0;
export const mailboxRemovalInvalid = () => Object.assign(new Error('Posta kutusu işlemi doğrulanamadı.'), { code: 'mailbox_removal_unverified' });
function requireValue(condition) { if (!condition) throw mailboxRemovalInvalid(); }
export const mailboxRemovalJobId = (value) => typeof value === 'string' && JOB_ID.test(value);
export const mailboxRemovalBusy = (state) => ['loading', 'preparing', 'checking', 'sending'].includes(state.status);

export function mailboxRemovalTarget(value) {
  requireValue(record(value) && UUID.test(value.id) && UUID.test(value.mailDomainId)
    && typeof value.address === 'string' && value.address.length <= 254 && /^[^\s@/\\]+@[^\s@/\\]+$/.test(value.address));
  return Object.freeze({ id: value.id, mailDomainId: value.mailDomainId, address: value.address });
}
export function mailboxRemovalSnapshot(mailbox, domain, impact, target) {
  requireValue(record(mailbox) && mailbox.id === target.id && mailbox.mailDomainId === target.mailDomainId
    && mailbox.address === target.address && positive(mailbox.revision) && typeof mailbox.enabled === 'boolean');
  requireValue(record(domain) && domain.id === target.mailDomainId && domain.managementMode === 'local'
    && positive(domain.revision) && ['enabled', 'disabled'].includes(domain.status)
    && domain.domainName === target.address.split('@')[1]);
  requireValue(record(impact) && impact.version === 1 && impact.resourceType === 'mailbox'
    && impact.resourceId === target.id && impact.address === target.address && impact.revision === mailbox.revision
    && impact.enabled === mailbox.enabled && impact.sideEffects === false
    && impact.confirmation === `delete-mailbox:${target.address}`
    && typeof impact.safeToDelete === 'boolean' && Array.isArray(impact.blockers));
  const dependencies = impact.dependencies;
  requireValue(record(dependencies) && typeof dependencies.quotaConfigured === 'boolean'
    && typeof dependencies.forwardingConfigured === 'boolean'
    && count(dependencies.aliasReferences?.count) && count(dependencies.activeJobs?.count));
  requireValue(record(impact.mailData) && typeof impact.mailData.present === 'boolean'
    && count(impact.mailData.bytes) && SHA.test(impact.mailData.snapshotSha256)
    && impact.requiresDataBackup === impact.mailData.present);
  const blockers = impact.blockers.map((entry) => {
    requireValue(record(entry) && typeof entry.code === 'string' && /^[a-z0-9_]{1,100}$/.test(entry.code) && positive(entry.count));
    return Object.freeze({ code: entry.code, count: entry.count });
  });
  requireValue(impact.safeToDelete === (blockers.length === 0));
  return Object.freeze({
    revision: mailbox.revision, enabled: mailbox.enabled, domainRevision: domain.revision, domainStatus: domain.status,
    quota: dependencies.quotaConfigured, forwarding: dependencies.forwardingConfigured,
    aliases: dependencies.aliasReferences.count, activeJobs: dependencies.activeJobs.count,
    present: impact.mailData.present, bytes: impact.mailData.bytes, snapshotSha256: impact.mailData.snapshotSha256,
    blockers: Object.freeze(blockers),
  });
}
export function mailboxRemovalEligible(snapshot, { allowData = true } = {}) {
  return Boolean(snapshot && snapshot.enabled === false && ['enabled', 'disabled'].includes(snapshot.domainStatus) && !snapshot.quota && !snapshot.forwarding
    && snapshot.aliases === 0 && snapshot.activeJobs === 0
    && snapshot.blockers.every((entry) => allowData && entry.code === 'mail_data_backup_required')
    && (allowData || snapshot.present === false));
}
export function mailboxRemovalPreview(value, target, snapshot, action, backupId = null) {
  requireValue(['backup', 'delete'].includes(action) && record(value) && value.version === 1
    && value.operation === `mail_data_${action}` && value.scope === 'mailbox'
    && value.mailDomainId === target.mailDomainId && value.resourceId === target.id && value.identity === target.address
    && value.expectedRevision === snapshot.revision && SHA.test(value.previewDigest) && value.sideEffects === false
    && value.confirmation === `${action}-mail-data:${target.mailDomainId}:${value.previewDigest}`);
  const common = { action, expectedRevision: value.expectedRevision, expectedPreviewDigest: value.previewDigest, confirmation: value.confirmation };
  if (action === 'backup') {
    requireValue(value.snapshotSha256 === snapshot.snapshotSha256 && value.sourcePresent === snapshot.present && value.bytes === snapshot.bytes);
    return Object.freeze({ ...common, snapshotSha256: value.snapshotSha256, sourcePresent: value.sourcePresent });
  }
  requireValue(mailboxRemovalJobId(backupId) && value.backupId === backupId && SHA.test(value.backupContentSha256)
    && count(value.backupBytes) && value.targetSnapshotSha256 === snapshot.snapshotSha256
    && value.targetPresent === snapshot.present && value.targetBytes === snapshot.bytes);
  return Object.freeze({ ...common, backupId, snapshotSha256: value.targetSnapshotSha256 });
}
export function mailboxRemovalJob(value, target, expected = null) {
  requireValue(record(value) && mailboxRemovalJobId(value.id)
    && value.resourceType === 'mail_domain' && value.resourceId === target.mailDomainId
    && ['mail.data.backup', 'mail.data.delete'].includes(value.operation)
    && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value.status));
  const action = value.operation === 'mail.data.backup' ? 'backup' : 'delete';
  requireValue(!expected || (value.id === expected.id && action === expected.action));
  const job = { id: value.id, action, status: value.status };
  if (value.status !== 'succeeded') return Object.freeze(job);
  const result = value.result;
  requireValue(record(result) && result.version === 1 && result.mailDomainId === target.mailDomainId
    && result.scope === 'mailbox' && result.identity === target.address && result.sideEffects === true
    && SHA.test(result.contentSha256) && count(result.bytes) && count(result.files) && count(result.directories));
  if (action === 'backup') {
    requireValue(result.backedUp === true && result.backupId === value.id && SHA.test(result.sourceSnapshotSha256)
      && typeof result.sourcePresent === 'boolean');
    if (expected?.preview) requireValue(result.sourceSnapshotSha256 === expected.preview.snapshotSha256
      && result.sourcePresent === expected.preview.sourcePresent);
    return Object.freeze({ ...job, backupId: result.backupId });
  }
  requireValue(result.deleted === true && result.transactionId === value.id && result.resourceId === target.id
    && positive(result.expectedResourceRevision) && mailboxRemovalJobId(result.backupId));
  if (expected?.preview) requireValue(result.expectedResourceRevision === expected.preview.expectedRevision && result.backupId === expected.preview.backupId);
  return Object.freeze({ ...job, backupId: result.backupId, revision: result.expectedResourceRevision });
}
export function mailboxRemovalFinalResult(value, target, receipt) {
  requireValue(record(value) && value.resourceType === 'mailbox' && value.id === target.id && value.deleted === true
    && value.deleteJobId === receipt.id && value.backupId === receipt.backupId);
  return Object.freeze({ id: target.id, deleteJobId: receipt.id, backupId: receipt.backupId });
}
