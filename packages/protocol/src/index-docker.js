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
const DOCKER_COMPOSE_REMOVE = 'docker.compose.remove';
const DOCKER_VOLUME_DELETE = 'docker.volume.delete';
const DOCKER_OPERATIONS = Object.freeze([
  DOCKER_COMPOSE_BUILD,
  DOCKER_COMPOSE_PULL,
  DOCKER_COMPOSE_START,
  DOCKER_COMPOSE_STOP,
  DOCKER_COMPOSE_RESTART,
  DOCKER_COMPOSE_REMOVE,
]);
const DOCKER_VOLUME_OPS = Object.freeze([DOCKER_VOLUME_DELETE]);
const DOCKER_OPERATION_SET = new Set(DOCKER_OPERATIONS);
const DOCKER_VOLUME_OPERATION_SET = new Set(DOCKER_VOLUME_OPS);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const VOLUME_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const REGISTRY_HOST_PATTERN = /^(?:localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;

export const OPERATIONS = Object.freeze({
  ...BASE_OPERATIONS,
  DOCKER_COMPOSE_BUILD,
  DOCKER_COMPOSE_PULL,
  DOCKER_COMPOSE_START,
  DOCKER_COMPOSE_STOP,
  DOCKER_COMPOSE_RESTART,
  DOCKER_COMPOSE_REMOVE,
  DOCKER_VOLUME_DELETE,
});

export const DOCKER_COMPOSE_OPERATIONS = DOCKER_OPERATIONS;
export const DOCKER_VOLUME_OPERATIONS = DOCKER_VOLUME_OPS;

export function isKnownOperation(operation) {
  return isBaseKnownOperation(operation)
    || DOCKER_OPERATION_SET.has(operation)
    || DOCKER_VOLUME_OPERATION_SET.has(operation);
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

function validateRemovalVolumes(payload, operation, errors) {
  const volumes = payload.volumes;
  if (payload.deleteVolumes !== true || !Array.isArray(volumes) || volumes.length < 1 || volumes.length > 64) {
    errors.push(`${operation} volume deletion is invalid`);
    return;
  }
  const seen = new Set();
  for (const entry of volumes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 3
      || typeof entry.volumeKey !== 'string' || !VOLUME_KEY_PATTERN.test(entry.volumeKey)
      || typeof entry.volumeName !== 'string' || !VOLUME_NAME_PATTERN.test(entry.volumeName)
      || entry.volumeName !== `${payload.projectName}_${entry.volumeKey}`
      || typeof entry.volumeFingerprint !== 'string' || !SHA256_PATTERN.test(entry.volumeFingerprint)
      || seen.has(entry.volumeKey)) {
      errors.push(`${operation} volumes is invalid`);
      return;
    }
    seen.add(entry.volumeKey);
  }
}

function validateDockerComposeLifecycle(payload, operation, errors) {
  const allowed = new Set([
    'projectId', 'expectedProjectRevision', 'expectedEnvironmentRevision',
    'expectedComposeSha256', 'credentialRevisions',
  ]);
  if (operation === DOCKER_COMPOSE_REMOVE) {
    allowed.add('projectName');
    if (typeof payload.projectName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(payload.projectName)) errors.push(`${operation} projectName is invalid`);
    // T969: named-volume deletion is an explicit, pinned opt-in carried together with its exact volume list.
    if (Object.hasOwn(payload, 'deleteVolumes') || Object.hasOwn(payload, 'volumes')) {
      allowed.add('deleteVolumes');
      allowed.add('volumes');
      validateRemovalVolumes(payload, operation, errors);
    }
  }
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

function validateDockerVolumeDelete(payload, operation, errors) {
  const allowed = new Set([
    'projectId',
    'projectName',
    'expectedProjectRevision',
    'expectedComposeSha256',
    'volumeKey',
    'volumeName',
    'volumeFingerprint',
    'previewDigest',
  ]);
  if (Object.keys(payload).length !== allowed.size || Object.keys(payload).some((key) => !allowed.has(key))) {
    errors.push(`${operation} contains unsupported arguments`);
  }
  try {
    if (assertUuid(payload.projectId, 'projectId') !== payload.projectId) throw new Error('noncanonical');
  } catch {
    errors.push(`${operation} projectId is invalid`);
  }
  if (typeof payload.projectName !== 'string' || !PROJECT_NAME_PATTERN.test(payload.projectName)) {
    errors.push(`${operation} projectName is invalid`);
  }
  if (!Number.isSafeInteger(payload.expectedProjectRevision) || payload.expectedProjectRevision < 1) {
    errors.push(`${operation} expectedProjectRevision is invalid`);
  }
  if (typeof payload.expectedComposeSha256 !== 'string' || !SHA256_PATTERN.test(payload.expectedComposeSha256)) {
    errors.push(`${operation} expectedComposeSha256 is invalid`);
  }
  if (typeof payload.volumeKey !== 'string' || !VOLUME_KEY_PATTERN.test(payload.volumeKey)) {
    errors.push(`${operation} volumeKey is invalid`);
  }
  if (typeof payload.volumeName !== 'string' || !VOLUME_NAME_PATTERN.test(payload.volumeName)
    || (typeof payload.projectName === 'string' && typeof payload.volumeKey === 'string'
      && payload.volumeName !== `${payload.projectName}_${payload.volumeKey}`)) {
    errors.push(`${operation} volumeName is invalid`);
  }
  if (typeof payload.volumeFingerprint !== 'string' || !SHA256_PATTERN.test(payload.volumeFingerprint)) {
    errors.push(`${operation} volumeFingerprint is invalid`);
  }
  if (typeof payload.previewDigest !== 'string' || !SHA256_PATTERN.test(payload.previewDigest)) {
    errors.push(`${operation} previewDigest is invalid`);
  }
}

export function validateOperationEnvelope(value) {
  const isCompose = DOCKER_OPERATION_SET.has(value?.operation);
  const isVolume = DOCKER_VOLUME_OPERATION_SET.has(value?.operation);
  if (!value || typeof value !== 'object' || Array.isArray(value) || (!isCompose && !isVolume)) {
    return validateBaseOperationEnvelope(value);
  }
  const errors = [];
  if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) {
    errors.push('id must be a string between 8 and 128 characters');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload must be an object');
  } else if (isCompose) {
    validateDockerComposeLifecycle(value.payload, value.operation, errors);
  } else {
    validateDockerVolumeDelete(value.payload, value.operation, errors);
  }
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
  }
  return { ok: errors.length === 0, errors };
}

export function createOperationEnvelope({ id, operation, payload = {} }) {
  if (!DOCKER_OPERATION_SET.has(operation) && !DOCKER_VOLUME_OPERATION_SET.has(operation)) {
    return createBaseOperationEnvelope({ id, operation, payload });
  }
  const envelope = { id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION };
  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return envelope;
}

export const dockerProtocolInternals = Object.freeze({
  operations: DOCKER_OPERATIONS,
  volumeOperations: DOCKER_VOLUME_OPS,
  validateDockerComposeLifecycle,
  validateDockerVolumeDelete,
  validateCredentialRevisions,
});
