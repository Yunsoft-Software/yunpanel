export * from './index-extended.js';

import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS as EXTENDED_OPERATIONS,
  createOperationEnvelope as createExtendedOperationEnvelope,
  isKnownOperation as isExtendedKnownOperation,
  validateOperationEnvelope as validateExtendedOperationEnvelope,
} from './index-extended.js';

const DATABASE_BACKUP = 'database.backup';
const DATABASE_RESTORE = 'database.restore';
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RESERVED_DATABASE_NAMES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export const OPERATIONS = Object.freeze({
  ...EXTENDED_OPERATIONS,
  DATABASE_BACKUP,
  DATABASE_RESTORE,
});

export function isKnownOperation(operation) {
  return isExtendedKnownOperation(operation)
    || operation === DATABASE_BACKUP
    || operation === DATABASE_RESTORE;
}

function validDatabaseName(value) {
  return typeof value === 'string' && DATABASE_NAME_PATTERN.test(value)
    && !RESERVED_DATABASE_NAMES.has(value.toLowerCase());
}

function exactKeys(payload, fields) {
  return Object.keys(payload).length === fields.size
    && Object.keys(payload).every((key) => fields.has(key));
}

function validateWebsiteScope(payload, operation, errors) {
  const scopeFields = ['websiteId', 'databaseBindingId', 'expectedBindingRevision'];
  const present = scopeFields.filter((field) => Object.hasOwn(payload, field));
  if (present.length === 0) return false;
  if (present.length !== scopeFields.length) {
    errors.push(`${operation} Website scope is incomplete`);
    return true;
  }
  if (!UUID_PATTERN.test(payload.websiteId ?? '')) {
    errors.push(`${operation} websiteId is invalid`);
  }
  if (!UUID_PATTERN.test(payload.databaseBindingId ?? '')) {
    errors.push(`${operation} databaseBindingId is invalid`);
  }
  if (!Number.isSafeInteger(payload.expectedBindingRevision) || payload.expectedBindingRevision < 1) {
    errors.push(`${operation} expectedBindingRevision is invalid`);
  }
  return true;
}

function validateDatabaseBackup(payload, errors) {
  const base = new Set(['databaseName']);
  const scoped = new Set(['databaseName', 'websiteId', 'databaseBindingId', 'expectedBindingRevision']);
  const hasScope = validateWebsiteScope(payload, DATABASE_BACKUP, errors);
  if (!exactKeys(payload, hasScope ? scoped : base)) {
    errors.push(`${DATABASE_BACKUP} contains unsupported arguments`);
  }
  if (!validDatabaseName(payload.databaseName)) {
    errors.push(`${DATABASE_BACKUP} databaseName is invalid`);
  }
}

function validateDatabaseRestore(payload, errors) {
  const base = new Set(['databaseName', 'backupId', 'expectedBackupSha256']);
  const scoped = new Set([
    'databaseName', 'backupId', 'expectedBackupSha256',
    'websiteId', 'databaseBindingId', 'expectedBindingRevision',
  ]);
  const hasScope = validateWebsiteScope(payload, DATABASE_RESTORE, errors);
  if (!exactKeys(payload, hasScope ? scoped : base)) {
    errors.push(`${DATABASE_RESTORE} contains unsupported arguments`);
  }
  if (!validDatabaseName(payload.databaseName)) {
    errors.push(`${DATABASE_RESTORE} databaseName is invalid`);
  }
  if (typeof payload.backupId !== 'string' || !BACKUP_ID_PATTERN.test(payload.backupId)) {
    errors.push(`${DATABASE_RESTORE} backupId is invalid`);
  }
  if (typeof payload.expectedBackupSha256 !== 'string' || !SHA256_PATTERN.test(payload.expectedBackupSha256)) {
    errors.push(`${DATABASE_RESTORE} expectedBackupSha256 is invalid`);
  }
}

export function validateOperationEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![DATABASE_BACKUP, DATABASE_RESTORE].includes(value.operation)) {
    return validateExtendedOperationEnvelope(value);
  }
  const errors = [];
  if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) {
    errors.push('id must be a string between 8 and 128 characters');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload must be an object');
  } else if (value.operation === DATABASE_BACKUP) {
    validateDatabaseBackup(value.payload, errors);
  } else {
    validateDatabaseRestore(value.payload, errors);
  }
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
  }
  return { ok: errors.length === 0, errors };
}

export function createOperationEnvelope({ id, operation, payload = {} }) {
  if (![DATABASE_BACKUP, DATABASE_RESTORE].includes(operation)) {
    return createExtendedOperationEnvelope({ id, operation, payload });
  }
  const envelope = { id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION };
  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return envelope;
}

export const databaseBackupProtocolInternals = Object.freeze({
  backupOperation: DATABASE_BACKUP,
  restoreOperation: DATABASE_RESTORE,
  validateDatabaseBackup,
  validateDatabaseRestore,
  validateWebsiteScope,
});
