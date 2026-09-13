export * from './index.js';

import { assertUuid, normalizeDomainSet } from '@yunpanel/shared';
import {
  AGENT_PROTOCOL_VERSION,
  MANAGED_SERVICE_ACTIONS,
  MANAGED_SERVICE_CONTROL_IDS as BASE_MANAGED_SERVICE_CONTROL_IDS,
  MANAGED_SERVICE_IDS as BASE_MANAGED_SERVICE_IDS,
  OPERATIONS as BASE_OPERATIONS,
  READ_ONLY_OPERATIONS,
  createOperationEnvelope as createBaseOperationEnvelope,
  isKnownOperation as isBaseKnownOperation,
  isReadOnlyOperation as isBaseReadOnlyOperation,
  validateOperationEnvelope as validateBaseOperationEnvelope,
} from './index.js';

const DATABASE_CREDENTIAL_APPLY = 'database.credential.apply';
const DATABASE_CREDENTIAL_DELETE = 'database.credential.delete';
const MAIL_DKIM_APPLY = 'mail.dkim.apply';
const MAIL_DATA_BACKUP = 'mail.data.backup';
const MAIL_DATA_RESTORE = 'mail.data.restore';
const MAIL_DATA_DELETE = 'mail.data.delete';
const ROUNDCUBE_CONFIG_APPLY = 'roundcube.config.apply';
const POSTSRSD_SERVICE_ID = 'postsrsd';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAILBOX_LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const TXT_MAX_BYTES = 4096;

export const MANAGED_SERVICE_IDS = Object.freeze([...BASE_MANAGED_SERVICE_IDS, POSTSRSD_SERVICE_ID]);
export const MANAGED_SERVICE_CONTROL_IDS = Object.freeze([...BASE_MANAGED_SERVICE_CONTROL_IDS, POSTSRSD_SERVICE_ID]);

export const OPERATIONS = Object.freeze({
  ...BASE_OPERATIONS,
  DATABASE_CREDENTIAL_APPLY,
  DATABASE_CREDENTIAL_DELETE,
  MAIL_DKIM_APPLY,
  MAIL_DATA_BACKUP,
  MAIL_DATA_RESTORE,
  MAIL_DATA_DELETE,
  ROUNDCUBE_CONFIG_APPLY,
});

export function isKnownOperation(operation) {
  return isBaseKnownOperation(operation)
    || operation === DATABASE_CREDENTIAL_APPLY
    || operation === DATABASE_CREDENTIAL_DELETE
    || operation === MAIL_DKIM_APPLY
    || operation === MAIL_DATA_BACKUP
    || operation === MAIL_DATA_RESTORE
    || operation === MAIL_DATA_DELETE
    || operation === ROUNDCUBE_CONFIG_APPLY;
}

export function isReadOnlyOperation(operation) {
  return isBaseReadOnlyOperation(operation);
}

function canonicalDomain(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch { return null; }
}

function canonicalMailbox(value) {
  if (typeof value !== 'string' || value.length > 254 || value.trim() !== value) return null;
  const separator = value.indexOf('@');
  if (separator < 1 || separator !== value.lastIndexOf('@')) return null;
  const local = value.slice(0, separator).toLowerCase();
  if (!MAILBOX_LOCAL_PART_PATTERN.test(local) || local.includes('..')) return null;
  const domain = canonicalDomain(value.slice(separator + 1));
  if (!domain) return null;
  const normalized = `${local}@${domain}`;
  return normalized.length <= 254 ? normalized : null;
}

function validateDatabaseCredentialMutation(payload, operation, errors) {
  const allowed = new Set([
    'databaseCredentialId', 'databaseBindingId', 'expectedCredentialRevision',
    'expectedBindingRevision', 'desiredStateSha256',
  ]);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${operation} contains unsupported arguments`);
  }
  try {
    if (assertUuid(payload.databaseCredentialId, 'databaseCredentialId') !== payload.databaseCredentialId
      || assertUuid(payload.databaseBindingId, 'databaseBindingId') !== payload.databaseBindingId) {
      throw new Error('noncanonical');
    }
  } catch {
    errors.push(`${operation} identities are invalid`);
  }
  if (!Number.isSafeInteger(payload.expectedCredentialRevision) || payload.expectedCredentialRevision < 1
    || !Number.isSafeInteger(payload.expectedBindingRevision) || payload.expectedBindingRevision < 1) {
    errors.push(`${operation} revisions are invalid`);
  }
  if (typeof payload.desiredStateSha256 !== 'string' || !SHA256_PATTERN.test(payload.desiredStateSha256)) {
    errors.push(`${operation} desired-state digest is invalid`);
  }
}

function validateMailDkimApply(payload, errors) {
  const allowed = new Set([
    'mailDomainId', 'expectedKeyRevision', 'previewDigest', 'configurationSha256',
  ]);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${MAIL_DKIM_APPLY} contains unsupported arguments`);
  }
  try {
    if (assertUuid(payload.mailDomainId, 'mailDomainId') !== payload.mailDomainId) throw new Error('noncanonical');
  } catch {
    errors.push(`${MAIL_DKIM_APPLY} mailDomainId is invalid`);
  }
  if (!Number.isSafeInteger(payload.expectedKeyRevision) || payload.expectedKeyRevision < 1) {
    errors.push(`${MAIL_DKIM_APPLY} expectedKeyRevision is invalid`);
  }
  if (typeof payload.previewDigest !== 'string' || !SHA256_PATTERN.test(payload.previewDigest)
    || typeof payload.configurationSha256 !== 'string' || !SHA256_PATTERN.test(payload.configurationSha256)) {
    errors.push(`${MAIL_DKIM_APPLY} digests are invalid`);
  }
}

function validateMailDataIdentity(payload, operation, errors) {
  try {
    if (assertUuid(payload.mailDomainId, 'mailDomainId') !== payload.mailDomainId) throw new Error('noncanonical');
    if (assertUuid(payload.resourceId, 'resourceId') !== payload.resourceId) throw new Error('noncanonical');
  } catch {
    errors.push(`${operation} resource identity is invalid`);
  }
  if (!['mailbox', 'domain'].includes(payload.scope)) {
    errors.push(`${operation} scope is invalid`);
    return;
  }
  if (payload.scope === 'domain' && payload.resourceId !== payload.mailDomainId) {
    errors.push(`${operation} domain resourceId must equal mailDomainId`);
  }
  const normalized = payload.scope === 'mailbox' ? canonicalMailbox(payload.identity) : canonicalDomain(payload.identity);
  if (!normalized || normalized !== payload.identity) errors.push(`${operation} identity is invalid`);
  if (!Number.isSafeInteger(payload.expectedResourceRevision) || payload.expectedResourceRevision < 1) {
    errors.push(`${operation} expectedResourceRevision is invalid`);
  }
}

function validateMailDataBackup(payload, errors) {
  const allowed = new Set([
    'mailDomainId', 'resourceId', 'scope', 'identity', 'expectedResourceRevision', 'expectedSnapshotSha256',
  ]);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${MAIL_DATA_BACKUP} contains unsupported arguments`);
  }
  validateMailDataIdentity(payload, MAIL_DATA_BACKUP, errors);
  if (typeof payload.expectedSnapshotSha256 !== 'string' || !SHA256_PATTERN.test(payload.expectedSnapshotSha256)) {
    errors.push(`${MAIL_DATA_BACKUP} snapshot digest is invalid`);
  }
}

function validateMailDataMutation(payload, operation, errors) {
  const allowed = new Set([
    'mailDomainId', 'resourceId', 'backupId', 'scope', 'identity', 'expectedResourceRevision', 'expectedTargetSnapshotSha256',
  ]);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${operation} contains unsupported arguments`);
  }
  validateMailDataIdentity(payload, operation, errors);
  if (typeof payload.backupId !== 'string' || !BACKUP_ID_PATTERN.test(payload.backupId)) {
    errors.push(`${operation} backupId is invalid`);
  }
  if (typeof payload.expectedTargetSnapshotSha256 !== 'string' || !SHA256_PATTERN.test(payload.expectedTargetSnapshotSha256)) {
    errors.push(`${operation} target snapshot digest is invalid`);
  }
}

function validateMailDataRestore(payload, errors) {
  validateMailDataMutation(payload, MAIL_DATA_RESTORE, errors);
}

function validateMailDataDelete(payload, errors) {
  validateMailDataMutation(payload, MAIL_DATA_DELETE, errors);
}

function validateRoundcubeConfigApply(payload, errors) {
  const allowed = new Set(['previewSha256', 'configSha256', 'fpmSha256']);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${ROUNDCUBE_CONFIG_APPLY} contains unsupported arguments`);
  }
  if (typeof payload.previewSha256 !== 'string' || !SHA256_PATTERN.test(payload.previewSha256)
    || typeof payload.configSha256 !== 'string' || !SHA256_PATTERN.test(payload.configSha256)
    || typeof payload.fpmSha256 !== 'string' || !SHA256_PATTERN.test(payload.fpmSha256)) {
    errors.push(`${ROUNDCUBE_CONFIG_APPLY} digests are invalid`);
  }
}

function validateDnsTxtApply(payload, errors) {
  const operation = BASE_OPERATIONS.DNS_RECORD_APPLY;
  const allowed = new Set([
    'provider', 'credentialId', 'dnsZoneId', 'zoneName', 'action', 'record', 'expectedSnapshotDigest',
  ]);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${operation} contains unsupported arguments`);
  }
  if (payload.provider !== 'cloudflare' || !['upsert', 'delete'].includes(payload.action)
    || typeof payload.expectedSnapshotDigest !== 'string' || !SHA256_PATTERN.test(payload.expectedSnapshotDigest)) {
    errors.push(`${operation} provider action or snapshot is invalid`);
  }
  try {
    if (assertUuid(payload.credentialId, 'credentialId') !== payload.credentialId
      || assertUuid(payload.dnsZoneId, 'dnsZoneId') !== payload.dnsZoneId) throw new Error('noncanonical');
  } catch {
    errors.push(`${operation} identities are invalid`);
  }
  const zoneName = canonicalDomain(payload.zoneName);
  if (!zoneName || zoneName !== payload.zoneName) errors.push(`${operation} zoneName is invalid`);
  const record = payload.record;
  const recordAllowed = new Set(['type', 'name', 'content', 'ttl', 'proxied']);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== recordAllowed.size
    || Object.keys(record).some((key) => !recordAllowed.has(key))) {
    errors.push(`${operation} record is invalid`);
    return;
  }
  const name = canonicalDomain(record.name);
  const contentBytes = typeof record.content === 'string' ? Buffer.byteLength(record.content) : 0;
  const contentSafe = typeof record.content === 'string' && contentBytes >= 1 && contentBytes <= TXT_MAX_BYTES
    && !/[\u0000-\u001f\u007f]/.test(record.content);
  if (record.type !== 'TXT' || !name || name !== record.name
    || !zoneName || (name !== zoneName && !name.endsWith(`.${zoneName}`))
    || !contentSafe || !Number.isInteger(record.ttl)
    || (record.ttl !== 1 && (record.ttl < 60 || record.ttl > 86_400))
    || record.proxied !== false) {
    errors.push(`${operation} TXT record fields are invalid`);
  }
}

function validatePostsrsdServiceOperation(operation, payload, errors) {
  const allowed = operation === BASE_OPERATIONS.SYSTEM_SERVICE_CONTROL
    ? new Set(['serviceId', 'action'])
    : new Set(['serviceId']);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${operation} contains unsupported arguments`);
  }
  if (payload.serviceId !== POSTSRSD_SERVICE_ID) {
    errors.push(`${operation} serviceId is invalid`);
  }
  if (operation === BASE_OPERATIONS.SYSTEM_SERVICE_CONTROL
    && (typeof payload.action !== 'string' || !MANAGED_SERVICE_ACTIONS.includes(payload.action))) {
    errors.push(`${operation} action is invalid`);
  }
}

function extendedOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.operation === DATABASE_CREDENTIAL_APPLY) return 'database_credential';
  if (value.operation === DATABASE_CREDENTIAL_DELETE) return 'database_credential';
  if (value.operation === MAIL_DKIM_APPLY) return 'mail_dkim';
  if (value.operation === MAIL_DATA_BACKUP) return 'mail_data_backup';
  if (value.operation === MAIL_DATA_RESTORE) return 'mail_data_restore';
  if (value.operation === MAIL_DATA_DELETE) return 'mail_data_delete';
  if (value.operation === ROUNDCUBE_CONFIG_APPLY) return 'roundcube';
  if (value.operation === BASE_OPERATIONS.DNS_RECORD_APPLY && value.payload?.record?.type === 'TXT') return 'dns_txt';
  if (value.payload?.serviceId === POSTSRSD_SERVICE_ID
    && [
      BASE_OPERATIONS.SYSTEM_SERVICES_INSPECT,
      BASE_OPERATIONS.SYSTEM_SERVICE_INSTALL,
      BASE_OPERATIONS.SYSTEM_SERVICE_CONTROL,
    ].includes(value.operation)) return 'postsrsd_service';
  return null;
}

export function validateOperationEnvelope(value) {
  const extension = extendedOperation(value);
  if (!extension) return validateBaseOperationEnvelope(value);
  const errors = [];
  if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) {
    errors.push('id must be a string between 8 and 128 characters');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload must be an object');
  } else if (extension === 'database_credential') {
    validateDatabaseCredentialMutation(value.payload, value.operation, errors);
  } else if (extension === 'mail_dkim') {
    validateMailDkimApply(value.payload, errors);
  } else if (extension === 'mail_data_backup') {
    validateMailDataBackup(value.payload, errors);
  } else if (extension === 'mail_data_restore') {
    validateMailDataRestore(value.payload, errors);
  } else if (extension === 'mail_data_delete') {
    validateMailDataDelete(value.payload, errors);
  } else if (extension === 'roundcube') {
    validateRoundcubeConfigApply(value.payload, errors);
  } else if (extension === 'postsrsd_service') {
    validatePostsrsdServiceOperation(value.operation, value.payload, errors);
  } else {
    validateDnsTxtApply(value.payload, errors);
  }
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
  }
  return { ok: errors.length === 0, errors };
}

export function createOperationEnvelope({ id, operation, payload = {} }) {
  const extended = operation === DATABASE_CREDENTIAL_APPLY
    || operation === DATABASE_CREDENTIAL_DELETE
    || operation === MAIL_DKIM_APPLY
    || operation === MAIL_DATA_BACKUP
    || operation === MAIL_DATA_RESTORE
    || operation === MAIL_DATA_DELETE
    || operation === ROUNDCUBE_CONFIG_APPLY
    || (operation === BASE_OPERATIONS.DNS_RECORD_APPLY && payload?.record?.type === 'TXT')
    || (payload?.serviceId === POSTSRSD_SERVICE_ID
      && [
        BASE_OPERATIONS.SYSTEM_SERVICES_INSPECT,
        BASE_OPERATIONS.SYSTEM_SERVICE_INSTALL,
        BASE_OPERATIONS.SYSTEM_SERVICE_CONTROL,
      ].includes(operation));
  if (!extended) return createBaseOperationEnvelope({ id, operation, payload });
  const envelope = { id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION };
  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return envelope;
}

export const protocolExtensionInternals = Object.freeze({
  databaseCredentialApply: DATABASE_CREDENTIAL_APPLY,
  databaseCredentialDelete: DATABASE_CREDENTIAL_DELETE,
  mailDkimApply: MAIL_DKIM_APPLY,
  mailDataBackup: MAIL_DATA_BACKUP,
  mailDataRestore: MAIL_DATA_RESTORE,
  mailDataDelete: MAIL_DATA_DELETE,
  roundcubeConfigApply: ROUNDCUBE_CONFIG_APPLY,
  postsrsdServiceId: POSTSRSD_SERVICE_ID,
  readOnlyOperations: READ_ONLY_OPERATIONS,
  txtMaxBytes: TXT_MAX_BYTES,
  validateDatabaseCredentialMutation,
  validateMailDkimApply,
  validateMailDataBackup,
  validateMailDataRestore,
  validateMailDataDelete,
  validateRoundcubeConfigApply,
  validateDnsTxtApply,
  validatePostsrsdServiceOperation,
});
