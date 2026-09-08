export const AGENT_PROTOCOL_VERSION = 1;

export const OPERATIONS = Object.freeze({
  SERVER_INSPECT: 'server.inspect',
  SERVER_SERVICES: 'server.services',
  SERVER_DOCKER: 'server.docker',
  SERVER_NGINX: 'server.nginx',
});

export const READ_ONLY_OPERATIONS = Object.freeze([
  OPERATIONS.SERVER_INSPECT,
  OPERATIONS.SERVER_SERVICES,
  OPERATIONS.SERVER_DOCKER,
  OPERATIONS.SERVER_NGINX,
]);

const KNOWN_OPERATIONS = new Set(Object.values(OPERATIONS));

export function isKnownOperation(operation) {
  return typeof operation === 'string' && KNOWN_OPERATIONS.has(operation);
}

export function isReadOnlyOperation(operation) {
  return READ_ONLY_OPERATIONS.includes(operation);
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
