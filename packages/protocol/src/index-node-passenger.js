export * from './index-docker.js';

import path from 'node:path';
import {
  normalizeDomainSet,
  normalizeNginxSettings,
  normalizeNodeStatusSpec,
  normalizeRelativeBuildPath,
} from '@yunpanel/shared';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS as DOCKER_OPERATIONS,
  createOperationEnvelope as createDockerOperationEnvelope,
  isKnownOperation as isDockerKnownOperation,
  validateOperationEnvelope as validateDockerOperationEnvelope,
} from './index-docker.js';

const APP_NODE_PASSENGER_MIGRATE = 'app.node.passenger-migrate';
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const DOMAIN_FIELDS = new Set([
  'primaryDomain',
  'aliases',
  'tls',
  'canonicalRedirect',
  'httpsRedirect',
  'nginxSettings',
]);
const NODE_FIELDS = new Set(['applicationId', 'releaseId', 'runtime']);

export const OPERATIONS = Object.freeze({
  ...DOCKER_OPERATIONS,
  APP_NODE_PASSENGER_MIGRATE,
});

export function isKnownOperation(operation) {
  return isDockerKnownOperation(operation) || operation === APP_NODE_PASSENGER_MIGRATE;
}

function validateSafeAbsolutePath(value, field, errors) {
  if (typeof value !== 'string' || value.length > 500 || !SAFE_ABSOLUTE_PATH.test(value)
    || path.posix.normalize(value) !== value || value.includes('/../') || value.endsWith('/..')) {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} ${field} is invalid`);
  }
}

function validateNode(value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== NODE_FIELDS.size
    || Object.keys(value).some((field) => !NODE_FIELDS.has(field))) {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} node is invalid`);
    return;
  }
  try {
    const normalized = normalizeNodeStatusSpec(value);
    if (normalized.runtime.start.mode !== 'node') {
      errors.push(`${APP_NODE_PASSENGER_MIGRATE} only supports node entry-file start mode`);
    }
  } catch {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} node is invalid`);
  }
}

function validateDomain(value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !DOMAIN_FIELDS.has(field))) {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} domain is invalid`);
    return;
  }

  const aliases = value.aliases ?? [];
  try {
    const normalized = normalizeDomainSet(value.primaryDomain, aliases);
    if (normalized.primary !== value.primaryDomain
      || normalized.aliases.length !== aliases.length
      || normalized.aliases.some((alias, index) => alias !== aliases[index])) {
      errors.push(`${APP_NODE_PASSENGER_MIGRATE} domain names must be canonical`);
    }
  } catch {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} domain names are invalid`);
  }

  if (value.canonicalRedirect !== undefined && typeof value.canonicalRedirect !== 'boolean') {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} canonicalRedirect is invalid`);
  }
  if (value.httpsRedirect !== undefined && typeof value.httpsRedirect !== 'boolean') {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} httpsRedirect is invalid`);
  }

  if (value.tls !== undefined && value.tls !== null) {
    const tls = value.tls;
    const tlsFields = new Set(['fullchainPath', 'privateKeyPath']);
    if (!tls || typeof tls !== 'object' || Array.isArray(tls)
      || Object.keys(tls).length !== tlsFields.size
      || Object.keys(tls).some((field) => !tlsFields.has(field))) {
      errors.push(`${APP_NODE_PASSENGER_MIGRATE} tls is invalid`);
    } else {
      validateSafeAbsolutePath(tls.fullchainPath, 'tls.fullchainPath', errors);
      validateSafeAbsolutePath(tls.privateKeyPath, 'tls.privateKeyPath', errors);
    }
  }

  if (value.nginxSettings !== undefined) {
    try { normalizeNginxSettings('proxy', value.nginxSettings); }
    catch { errors.push(`${APP_NODE_PASSENGER_MIGRATE} nginxSettings are invalid`); }
  }
}

function validateNodePassengerMigration(payload, errors) {
  const allowed = new Set(['node', 'domain']);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== allowed.size
    || Object.keys(payload).some((field) => !allowed.has(field))) {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} contains unsupported arguments`);
    return;
  }
  validateNode(payload.node, errors);
  validateDomain(payload.domain, errors);
}

function isPassengerDomainStage(value) {
  return value?.operation === DOCKER_OPERATIONS.DOMAIN_STAGE && value?.payload?.targetType === 'passenger';
}

function validatePassengerDomainStage(value) {
  const startupFile = value?.payload?.target?.startupFile;
  const baseEnvelope = structuredClone(value);
  if (baseEnvelope?.payload?.target && typeof baseEnvelope.payload.target === 'object' && !Array.isArray(baseEnvelope.payload.target)) {
    baseEnvelope.payload.target.startupFile = 'server.js';
  }
  const base = validateDockerOperationEnvelope(baseEnvelope);
  const errors = [...base.errors];
  try {
    if (normalizeRelativeBuildPath(startupFile) !== startupFile) throw new Error('noncanonical');
  } catch {
    errors.push('domain.stage Passenger target.startupFile is invalid');
  }
  return { ok: errors.length === 0, errors };
}

export function validateOperationEnvelope(value) {
  if (isPassengerDomainStage(value)) return validatePassengerDomainStage(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.operation !== APP_NODE_PASSENGER_MIGRATE) {
    return validateDockerOperationEnvelope(value);
  }
  const errors = [];
  if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) {
    errors.push('id must be a string between 8 and 128 characters');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload must be an object');
  } else {
    validateNodePassengerMigration(value.payload, errors);
  }
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
  }
  return { ok: errors.length === 0, errors };
}

export function createOperationEnvelope({ id, operation, payload = {} }) {
  if (operation !== APP_NODE_PASSENGER_MIGRATE && !(operation === DOCKER_OPERATIONS.DOMAIN_STAGE && payload?.targetType === 'passenger')) {
    return createDockerOperationEnvelope({ id, operation, payload });
  }
  const envelope = { id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION };
  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return envelope;
}

export const nodePassengerProtocolInternals = Object.freeze({
  operation: APP_NODE_PASSENGER_MIGRATE,
  validateNodePassengerMigration,
  validateNode,
  validateDomain,
  validatePassengerDomainStage,
});
