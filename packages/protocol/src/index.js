export const AGENT_PROTOCOL_VERSION = 1;

export const OPERATIONS = Object.freeze({
  SERVER_INSPECT: 'server.inspect',
  SERVER_SERVICES: 'server.services',
  SERVER_DOCKER: 'server.docker',
  SERVER_NGINX: 'server.nginx',
  DOMAIN_STAGE: 'domain.stage',
  DOMAIN_ACTIVATE: 'domain.activate',
});

export const READ_ONLY_OPERATIONS = Object.freeze([
  OPERATIONS.SERVER_INSPECT,
  OPERATIONS.SERVER_SERVICES,
  OPERATIONS.SERVER_DOCKER,
  OPERATIONS.SERVER_NGINX,
]);

const KNOWN_OPERATIONS = new Set(Object.values(OPERATIONS));
const DOMAIN_CHECKSUM = /^[a-f0-9]{64}$/;

export function isKnownOperation(operation) {
  return typeof operation === 'string' && KNOWN_OPERATIONS.has(operation);
}

export function isReadOnlyOperation(operation) {
  return READ_ONLY_OPERATIONS.includes(operation);
}

function validateMutationPayload(operation, payload, errors) {
  if (operation === OPERATIONS.DOMAIN_STAGE) {
    if (typeof payload.primaryDomain !== 'string' || payload.primaryDomain.length < 3 || payload.primaryDomain.length > 253) {
      errors.push('domain.stage primaryDomain is invalid');
    }
    if (payload.aliases !== undefined && (!Array.isArray(payload.aliases) || payload.aliases.length > 20)) {
      errors.push('domain.stage aliases must be an array with at most 20 entries');
    }
    if (!['static', 'proxy'].includes(payload.targetType)) {
      errors.push('domain.stage targetType must be static or proxy');
    }
    if (!payload.target || typeof payload.target !== 'object' || Array.isArray(payload.target)) {
      errors.push('domain.stage target must be an object');
    }
  }

  if (operation === OPERATIONS.DOMAIN_ACTIVATE) {
    if (typeof payload.primaryDomain !== 'string' || payload.primaryDomain.length < 3 || payload.primaryDomain.length > 253) {
      errors.push('domain.activate primaryDomain is invalid');
    }
    if (typeof payload.checksum !== 'string' || !DOMAIN_CHECKSUM.test(payload.checksum)) {
      errors.push('domain.activate checksum must be a SHA-256 hex digest');
    }
  }
}

export function validateOperationEnvelope(value) {
  const errors = [];

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['request must be an object'] };
  }

  if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) {
    errors.push('id must be a string between 8 and 128 characters');
  }

  if (!isKnownOperation(value.operation)) {
    errors.push('operation is not allowed');
  }

  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload must be an object');
  } else if (isKnownOperation(value.operation)) {
    validateMutationPayload(value.operation, value.payload, errors);
  }

  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
  }

  return { ok: errors.length === 0, errors };
}

export function createOperationEnvelope({ id, operation, payload = {} }) {
  const envelope = {
    id,
    operation,
    payload,
    protocolVersion: AGENT_PROTOCOL_VERSION,
  };

  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }

  return envelope;
}
