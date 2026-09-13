export * from './index-extended.js';

import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS as EXTENDED_OPERATIONS,
  createOperationEnvelope as createExtendedOperationEnvelope,
  isKnownOperation as isExtendedKnownOperation,
  validateOperationEnvelope as validateExtendedOperationEnvelope,
} from './index-extended.js';

const DATABASE_BACKUP = 'database.backup';
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASE_NAMES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export const OPERATIONS = Object.freeze({
  ...EXTENDED_OPERATIONS,
  DATABASE_BACKUP,
});

export function isKnownOperation(operation) {
  return isExtendedKnownOperation(operation) || operation === DATABASE_BACKUP;
}

function validateDatabaseBackup(payload, errors) {
  const allowed = new Set(['databaseName']);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${DATABASE_BACKUP} contains unsupported arguments`);
  }
  if (typeof payload.databaseName !== 'string' || !DATABASE_NAME_PATTERN.test(payload.databaseName)
    || RESERVED_DATABASE_NAMES.has(payload.databaseName.toLowerCase())) {
    errors.push(`${DATABASE_BACKUP} databaseName is invalid`);
  }
}

export function validateOperationEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.operation !== DATABASE_BACKUP) {
    return validateExtendedOperationEnvelope(value);
  }
  const errors = [];
  if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) {
    errors.push('id must be a string between 8 and 128 characters');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload must be an object');
  } else {
    validateDatabaseBackup(value.payload, errors);
  }
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
  }
  return { ok: errors.length === 0, errors };
}

export function createOperationEnvelope({ id, operation, payload = {} }) {
  if (operation !== DATABASE_BACKUP) {
    return createExtendedOperationEnvelope({ id, operation, payload });
  }
  const envelope = { id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION };
  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return envelope;
}

export const databaseBackupProtocolInternals = Object.freeze({
  operation: DATABASE_BACKUP,
  validateDatabaseBackup,
});
