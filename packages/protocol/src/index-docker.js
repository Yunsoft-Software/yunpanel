export * from './index-database-backup.js';

import { assertUuid } from '@yunpanel/shared';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS as BASE_OPERATIONS,
  createOperationEnvelope as createBaseOperationEnvelope,
  isKnownOperation as isBaseKnownOperation,
  validateOperationEnvelope as validateBaseOperationEnvelope,
} from './index-database-backup.js';

const DOCKER_COMPOSE_BUILD = 'docker.compose.build';
const DOCKER_COMPOSE_PULL = 'docker.compose.pull';
const DOCKER_COMPOSE_START = 'docker.compose.start';
const DOCKER_COMPOSE_STOP = 'docker.compose.stop';
const DOCKER_COMPOSE_RESTART = 'docker.compose.restart';
const DOCKER_OPERATIONS = Object.freeze([
  DOCKER_COMPOSE_BUILD,
  DOCKER_COMPOSE_PULL,
  DOCKER_COMPOSE_START,
  DOCKER_COMPOSE_STOP,
  DOCKER_COMPOSE_RESTART,
]);
const DOCKER_OPERATION_SET = new Set(DOCKER_OPERATIONS);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REGISTRY_HOST_PATTERN = /^(?:localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;

export const OPERATIONS = Object.freeze({
  ...BASE_OPERATIONS,
  DOCKER_COMPOSE_BUILD,
  DOCKER_COMPOSE_PULL,
  DOCKER_COMPOSE_START,
  DOCKER_COMPOSE_STOP,
  DOCKER_COMPOSE_RESTART,
});

export const DOCKER_COMPOSE_OPERATIONS = DOCKER_OPERATIONS;

export function isKnownOperation(operation) {
  return isBaseKnownOperation(operation) || DOCKER_OPERATION_SET.has(operation);
}

function validateCredentialRevisions(value, operation, errors) {
  if (!Array.isArray(value) || value.length > 32) {
    errors.push(`${operation} credentialRevisions is invalid`);
    return;
  }
  const seen = new Set();
  let previous = null;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || typeof entry.registryHost !== 'string' || !REGISTRY_HOST_PATTERN.test(entry.registryHost)
      || !Number.isSafeInteger(entry.revision) || entry.revision < 1
      || seen.has(entry.registryHost) || (previous !== null && entry.registryHost.localeCompare(previous) <= 0)) {
      errors.push(`${operation} credentialRevisions is invalid`);
      return;
    }
    seen.add(entry.registryHost);
    previous = entry.registryHost;
  }
}

function validateDockerComposeLifecycle(payload, operation, errors) {
  const allowed = new Set([
    'projectId', 'expectedProjectRevision', 'expectedEnvironmentRevision',
    'expectedComposeSha256', 'credentialRevisions',
  ]);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${operation} contains unsupported arguments`);
  }
  try {
    if (assertUuid(payload.projectId, 'projectId') !== payload.projectId) throw new Error('noncanonical');
  } catch {
    errors.push(`${operation} projectId is invalid`);
  }
  if (!Number.isSafeInteger(payload.expectedProjectRevision) || payload.expectedProjectRevision < 1) {
    errors.push(`${operation} expectedProjectRevision is invalid`);
  }
  if (!Number.isSafeInteger(payload.expectedEnvironmentRevision) || payload.expectedEnvironmentRevision < 0) {
    errors.push(`${operation} expectedEnvironmentRevision is invalid`);
  }
  if (typeof payload.expectedComposeSha256 !== 'string' || !SHA256_PATTERN.test(payload.expectedComposeSha256)) {
    errors.push(`${operation} expectedComposeSha256 is invalid`);
  }
  validateCredentialRevisions(payload.credentialRevisions, operation, errors);
}

export function validateOperationEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !DOCKER_OPERATION_SET.has(value.operation)) {
    return validateBaseOperationEnvelope(value);
  }
  const errors = [];
  if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) {
    errors.push('id must be a string between 8 and 128 characters');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload must be an object');
  } else {
    validateDockerComposeLifecycle(value.payload, value.operation, errors);
  }
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
  }
  return { ok: errors.length === 0, errors };
}

export function createOperationEnvelope({ id, operation, payload = {} }) {
  if (!DOCKER_OPERATION_SET.has(operation)) {
    return createBaseOperationEnvelope({ id, operation, payload });
  }
  const envelope = { id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION };
  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return envelope;
}

export const dockerProtocolInternals = Object.freeze({
  operations: DOCKER_OPERATIONS,
  validateDockerComposeLifecycle,
  validateCredentialRevisions,
});
