import { createHash } from 'node:crypto';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAIL_SCOPES = new Set(['domain', 'mailbox']);
const RESOURCE_KEYS = new Set([
  'identity', 'type', 'serverId', 'mailDomainId', 'scope', 'resourceId', 'sourceIdentity', 'snapshot', 'policy',
]);
const SNAPSHOT_KEYS = new Set(['revision', 'snapshotSha256', 'sourcePresent', 'bytes']);
const POLICY_KEYS = new Set(['disposition', 'reason']);

export class MailDataBackupResourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDataBackupResourceError';
    this.code = code;
  }
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new MailDataBackupResourceError('mail_data_backup_resource_identity_invalid', `${field} is invalid`);
  }
  return value.toLowerCase();
}

function identityText(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 320
    || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MailDataBackupResourceError('mail_data_backup_resource_identity_invalid', 'Mail data identity is invalid');
  }
  return value;
}

export function mailDataBackupIdentity({ mailDomainId, scope, resourceId } = {}) {
  const domainId = uuid(mailDomainId, 'mailDomainId');
  if (typeof scope !== 'string' || !MAIL_SCOPES.has(scope)) {
    throw new MailDataBackupResourceError('mail_data_backup_resource_scope_invalid', 'Mail data scope is invalid');
  }
  const scopedResourceId = uuid(resourceId, 'resourceId');
  const digest = createHash('sha256')
    .update(JSON.stringify(['mail_data', domainId, scope, scopedResourceId]))
    .digest('hex');
  return `mail-data:${digest}`;
}

export function normalizeMailDataBackupResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== RESOURCE_KEYS.size
    || Object.keys(value).some((key) => !RESOURCE_KEYS.has(key))
    || value.type !== 'mail_data'
    || typeof value.scope !== 'string' || !MAIL_SCOPES.has(value.scope)) {
    throw new MailDataBackupResourceError('mail_data_backup_resource_invalid', 'Mail data backup resource is invalid');
  }
  const scopedServerId = uuid(value.serverId, 'serverId');
  if (expectedServerId !== null && scopedServerId !== uuid(expectedServerId, 'serverId')) {
    throw new MailDataBackupResourceError('mail_data_backup_resource_server_mismatch', 'Mail data backup resource belongs to another server');
  }
  const mailDomainId = uuid(value.mailDomainId, 'mailDomainId');
  const resourceId = uuid(value.resourceId, 'resourceId');
  const sourceIdentity = identityText(value.sourceIdentity);
  const expectedIdentity = mailDataBackupIdentity({ mailDomainId, scope: value.scope, resourceId });
  if (value.identity !== expectedIdentity) {
    throw new MailDataBackupResourceError('mail_data_backup_resource_identity_invalid', 'Mail data backup resource identity does not match its scope');
  }
  if (!value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)
    || Object.keys(value.snapshot).length !== SNAPSHOT_KEYS.size
    || Object.keys(value.snapshot).some((key) => !SNAPSHOT_KEYS.has(key))
    || !Number.isSafeInteger(value.snapshot.revision) || value.snapshot.revision < 1
    || typeof value.snapshot.snapshotSha256 !== 'string' || !SHA256_PATTERN.test(value.snapshot.snapshotSha256)
    || typeof value.snapshot.sourcePresent !== 'boolean'
    || !Number.isSafeInteger(value.snapshot.bytes) || value.snapshot.bytes < 0) {
    throw new MailDataBackupResourceError('mail_data_backup_resource_snapshot_invalid', 'Mail data backup resource snapshot is invalid');
  }
  const expectedPolicy = value.snapshot.sourcePresent
    ? { disposition: 'include', reason: 'managed_mail_data' }
    : { disposition: 'exclude', reason: 'mail_data_absent' };
  if (!value.policy || typeof value.policy !== 'object' || Array.isArray(value.policy)
    || Object.keys(value.policy).length !== POLICY_KEYS.size
    || Object.keys(value.policy).some((key) => !POLICY_KEYS.has(key))
    || value.policy.disposition !== expectedPolicy.disposition || value.policy.reason !== expectedPolicy.reason) {
    throw new MailDataBackupResourceError('mail_data_backup_resource_policy_invalid', 'Mail data backup resource policy is invalid');
  }
  return Object.freeze({
    identity: expectedIdentity,
    type: 'mail_data',
    serverId: scopedServerId,
    mailDomainId,
    scope: value.scope,
    resourceId,
    sourceIdentity,
    snapshot: Object.freeze({ ...value.snapshot }),
    policy: Object.freeze(expectedPolicy),
  });
}

export function mailDataBackupResource({ serverId, preview } = {}) {
  const scopedServerId = uuid(serverId, 'serverId');
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || preview.version !== 1 || preview.operation !== 'mail_data_backup'
    || typeof preview.scope !== 'string' || !MAIL_SCOPES.has(preview.scope)
    || !Number.isSafeInteger(preview.expectedRevision) || preview.expectedRevision < 1
    || typeof preview.snapshotSha256 !== 'string' || !SHA256_PATTERN.test(preview.snapshotSha256)
    || typeof preview.sourcePresent !== 'boolean'
    || !Number.isSafeInteger(preview.bytes) || preview.bytes < 0) {
    throw new MailDataBackupResourceError('mail_data_backup_resource_preview_invalid', 'Mail data backup preview is invalid');
  }
  const mailDomainId = uuid(preview.mailDomainId, 'mailDomainId');
  const resourceId = uuid(preview.resourceId, 'resourceId');
  const sourceIdentity = identityText(preview.identity);
  const identity = mailDataBackupIdentity({ mailDomainId, scope: preview.scope, resourceId });
  return normalizeMailDataBackupResource({
    identity,
    type: 'mail_data',
    serverId: scopedServerId,
    mailDomainId,
    scope: preview.scope,
    resourceId,
    sourceIdentity,
    snapshot: {
      revision: preview.expectedRevision,
      snapshotSha256: preview.snapshotSha256,
      sourcePresent: preview.sourcePresent,
      bytes: preview.bytes,
    },
    policy: preview.sourcePresent
      ? { disposition: 'include', reason: 'managed_mail_data' }
      : { disposition: 'exclude', reason: 'mail_data_absent' },
  }, scopedServerId);
}

export const mailDataBackupResourceInternals = Object.freeze({
  uuid,
  identityText,
  scopes: Object.freeze([...MAIL_SCOPES]),
});
