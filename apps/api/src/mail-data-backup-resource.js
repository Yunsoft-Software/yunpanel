import { createHash } from 'node:crypto';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAIL_SCOPES = new Set(['domain', 'mailbox']);

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
  const policy = preview.sourcePresent
    ? Object.freeze({ disposition: 'include', reason: 'managed_mail_data' })
    : Object.freeze({ disposition: 'exclude', reason: 'mail_data_absent' });

  return Object.freeze({
    identity,
    type: 'mail_data',
    serverId: scopedServerId,
    mailDomainId,
    scope: preview.scope,
    resourceId,
    sourceIdentity,
    snapshot: Object.freeze({
      revision: preview.expectedRevision,
      snapshotSha256: preview.snapshotSha256,
      sourcePresent: preview.sourcePresent,
      bytes: preview.bytes,
    }),
    policy,
  });
}

export const mailDataBackupResourceInternals = Object.freeze({
  uuid,
  identityText,
  scopes: Object.freeze([...MAIL_SCOPES]),
});
