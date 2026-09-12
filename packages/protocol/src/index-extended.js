export * from './index.js';

import { assertUuid } from '@yunpanel/shared';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS as BASE_OPERATIONS,
  READ_ONLY_OPERATIONS,
  createOperationEnvelope as createBaseOperationEnvelope,
  isKnownOperation as isBaseKnownOperation,
  isReadOnlyOperation as isBaseReadOnlyOperation,
  validateOperationEnvelope as validateBaseOperationEnvelope,
} from './index.js';

const MAIL_DKIM_APPLY = 'mail.dkim.apply';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const OPERATIONS = Object.freeze({
  ...BASE_OPERATIONS,
  MAIL_DKIM_APPLY,
});

export function isKnownOperation(operation) {
  return isBaseKnownOperation(operation) || operation === MAIL_DKIM_APPLY;
}

export function isReadOnlyOperation(operation) {
  return isBaseReadOnlyOperation(operation);
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

export function validateOperationEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.operation !== MAIL_DKIM_APPLY) {
    return validateBaseOperationEnvelope(value);
  }
  const errors = [];
  if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) {
    errors.push('id must be a string between 8 and 128 characters');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload must be an object');
  } else {
    validateMailDkimApply(value.payload, errors);
  }
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
  }
  return { ok: errors.length === 0, errors };
}

export function createOperationEnvelope({ id, operation, payload = {} }) {
  if (operation !== MAIL_DKIM_APPLY) return createBaseOperationEnvelope({ id, operation, payload });
  const envelope = { id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION };
  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return envelope;
}

export const protocolExtensionInternals = Object.freeze({
  mailDkimApply: MAIL_DKIM_APPLY,
  readOnlyOperations: READ_ONLY_OPERATIONS,
  validateMailDkimApply,
});
