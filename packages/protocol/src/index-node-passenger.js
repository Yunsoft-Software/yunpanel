export * from './index-docker.js';

import path from 'node:path';
import {
  assertUuid,
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
const WEBSITE_PHP_ACTION = 'website.php.action';
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const PHP_SOCKET_PATTERN = /^\/run\/php\/yunpanel-yunapp-[a-f0-9]{12}\.sock$/;
const DOMAIN_FIELDS = new Set([
  'primaryDomain',
  'aliases',
  'tls',
  'canonicalRedirect',
  'httpsRedirect',
  'nginxSettings',
]);
const NODE_FIELDS = new Set(['applicationId', 'releaseId', 'runtime']);
const AUTHORITY_FIELDS = new Set([
  'websiteId',
  'websiteRevision',
  'domainId',
  'domainDesiredRevision',
  'domainAppliedRevision',
]);
const PHP_ACTION_FIELDS = new Set([
  'websiteId', 'applicationId', 'unixUser', 'expectedWebsiteRevision',
  'actionId', 'previewDigest', 'confirmation',
]);
const PHP_ACTION_IDS = new Set([
  'wp.cache.flush',
  'wp.transients.delete-all',
  'composer.dump-autoload',
]);
const PHP_ACTION_USER = /^yunapp-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const OPERATIONS = Object.freeze({
  ...DOCKER_OPERATIONS,
  APP_NODE_PASSENGER_MIGRATE,
  WEBSITE_PHP_ACTION,
});

export function isKnownOperation(operation) {
  return isDockerKnownOperation(operation) || operation === APP_NODE_PASSENGER_MIGRATE || operation === WEBSITE_PHP_ACTION;
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

function validateAuthority(value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== AUTHORITY_FIELDS.size
    || Object.keys(value).some((field) => !AUTHORITY_FIELDS.has(field))) {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} authority is invalid`);
    return;
  }
  try {
    if (assertUuid(value.websiteId, 'websiteId') !== value.websiteId
      || assertUuid(value.domainId, 'domainId') !== value.domainId) {
      throw new Error('noncanonical');
    }
  } catch {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} authority identities are invalid`);
  }
  if (!Number.isSafeInteger(value.websiteRevision) || value.websiteRevision < 1
    || !Number.isSafeInteger(value.domainDesiredRevision) || value.domainDesiredRevision < 1
    || !Number.isSafeInteger(value.domainAppliedRevision) || value.domainAppliedRevision < 1
    || value.domainAppliedRevision !== value.domainDesiredRevision) {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} authority revisions are invalid`);
  }
}

function validateNodePassengerMigration(payload, errors) {
  const allowed = new Set(['node', 'domain', 'authority']);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== allowed.size
    || Object.keys(payload).some((field) => !allowed.has(field))) {
    errors.push(`${APP_NODE_PASSENGER_MIGRATE} contains unsupported arguments`);
    return;
  }
  validateNode(payload.node, errors);
  validateDomain(payload.domain, errors);
  validateAuthority(payload.authority, errors);
}


function validateWebsitePhpAction(payload, errors) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== PHP_ACTION_FIELDS.size
    || Object.keys(payload).some((field) => !PHP_ACTION_FIELDS.has(field))) {
    errors.push(`${WEBSITE_PHP_ACTION} contains unsupported arguments`);
    return;
  }
  try {
    if (assertUuid(payload.websiteId, 'websiteId') !== payload.websiteId
      || assertUuid(payload.applicationId, 'applicationId') !== payload.applicationId) throw new Error('noncanonical');
  } catch {
    errors.push(`${WEBSITE_PHP_ACTION} identities are invalid`);
  }
  if (typeof payload.unixUser !== 'string' || !PHP_ACTION_USER.test(payload.unixUser)) {
    errors.push(`${WEBSITE_PHP_ACTION} unixUser is invalid`);
  }
  if (!Number.isSafeInteger(payload.expectedWebsiteRevision) || payload.expectedWebsiteRevision < 1) {
    errors.push(`${WEBSITE_PHP_ACTION} expectedWebsiteRevision is invalid`);
  }
  if (typeof payload.actionId !== 'string' || !PHP_ACTION_IDS.has(payload.actionId)) {
    errors.push(`${WEBSITE_PHP_ACTION} actionId is invalid`);
  }
  if (typeof payload.previewDigest !== 'string' || !SHA256.test(payload.previewDigest)) {
    errors.push(`${WEBSITE_PHP_ACTION} previewDigest is invalid`);
  }
  const confirmation = `php-tool:${payload.websiteId}:${payload.actionId}:${payload.previewDigest}`;
  if (payload.confirmation !== confirmation) {
    errors.push(`${WEBSITE_PHP_ACTION} confirmation is invalid`);
  }
}

function isPassengerDomainStage(value) {
  return value?.operation === DOCKER_OPERATIONS.DOMAIN_STAGE && value?.payload?.targetType === 'passenger';
}

function isPhpDomainStage(value) {
  return value?.operation === DOCKER_OPERATIONS.DOMAIN_STAGE && value?.payload?.targetType === 'php';
}

const PYTHON_SOCKET_PATTERN = /^\/run\/yunpanel\/python-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sock$/i;

function isPythonDomainStage(value) {
  return value?.operation === DOCKER_OPERATIONS.DOMAIN_STAGE && value?.payload?.targetType === 'python';
}

function validatePythonDomainStage(value) {
  const target = value?.payload?.target;
  const baseEnvelope = structuredClone(value);
  if (baseEnvelope?.payload) {
    baseEnvelope.payload.targetType = 'proxy';
    baseEnvelope.payload.target = {
      host: '127.0.0.1',
      port: 3000,
      websocket: value?.payload?.nginxSettings?.websocket !== false,
    };
  }
  const base = validateDockerOperationEnvelope(baseEnvelope);
  const errors = [...base.errors];
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    errors.push('domain.stage Python target must be an object');
    return { ok: false, errors };
  }
  if (!target.socketPath && !target.upstreamPort) {
    errors.push('domain.stage Python target requires either socketPath or upstreamPort');
  }
  if (target.socketPath) {
    if (typeof target.socketPath !== 'string' || !PYTHON_SOCKET_PATTERN.test(target.socketPath)) {
      errors.push('domain.stage Python target.socketPath is invalid');
    }
  }
  if (target.upstreamPort !== undefined && target.upstreamPort !== null) {
    if (!Number.isInteger(target.upstreamPort) || target.upstreamPort < 1024 || target.upstreamPort > 65535) {
      errors.push('domain.stage Python target.upstreamPort is invalid');
    }
  }
  try {
    const normalized = normalizeNginxSettings('python', value.payload.nginxSettings ?? {});
    if (JSON.stringify(normalized) !== JSON.stringify(value.payload.nginxSettings ?? {})) {
      errors.push('domain.stage Python nginxSettings must be canonical');
    }
  } catch {
    errors.push('domain.stage Python nginxSettings are invalid');
  }
  return { ok: errors.length === 0, errors };
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

function validatePhpDomainStage(value) {
  const target = value?.payload?.target;
  const baseEnvelope = structuredClone(value);
  if (baseEnvelope?.payload) {
    baseEnvelope.payload.targetType = 'passenger';
    baseEnvelope.payload.target = {
      root: target?.root,
      startupFile: 'server.js',
      nodeBinary: '/usr/bin/node',
    };
  }
  const base = validateDockerOperationEnvelope(baseEnvelope);
  const errors = [...base.errors];
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || Object.keys(target).length !== 2
    || !Object.hasOwn(target, 'root') || !Object.hasOwn(target, 'socketPath')) {
    errors.push('domain.stage PHP target must contain only root and socketPath');
    return { ok: false, errors };
  }
  if (typeof target.socketPath !== 'string' || !PHP_SOCKET_PATTERN.test(target.socketPath)
    || path.posix.normalize(target.socketPath) !== target.socketPath) {
    errors.push('domain.stage PHP target.socketPath is invalid');
  }
  try {
    const normalized = normalizeNginxSettings('php', value.payload.nginxSettings ?? {});
    if (JSON.stringify(normalized) !== JSON.stringify(value.payload.nginxSettings ?? {})) {
      errors.push('domain.stage PHP nginxSettings must be canonical');
    }
  } catch {
    errors.push('domain.stage PHP nginxSettings are invalid');
  }
  return { ok: errors.length === 0, errors };
}

export function validateOperationEnvelope(value) {
  if (value?.operation === WEBSITE_PHP_ACTION) {
    const errors = [];
    if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) {
      errors.push('id must be a string between 8 and 128 characters');
    }
    validateWebsitePhpAction(value.payload, errors);
    if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
    return { ok: errors.length === 0, errors };
  }
  if (isPassengerDomainStage(value)) return validatePassengerDomainStage(value);
  if (isPhpDomainStage(value)) return validatePhpDomainStage(value);
  if (isPythonDomainStage(value)) return validatePythonDomainStage(value);
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
  const specialDomainStage = operation === DOCKER_OPERATIONS.DOMAIN_STAGE
    && ['passenger', 'php', 'python'].includes(payload?.targetType);
  if (operation !== APP_NODE_PASSENGER_MIGRATE && operation !== WEBSITE_PHP_ACTION && !specialDomainStage) {
    return createDockerOperationEnvelope({ id, operation, payload });
  }
  const envelope = { id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION };
  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return envelope;
}

export const nodePassengerProtocolInternals = Object.freeze({
  operation: APP_NODE_PASSENGER_MIGRATE,
  phpActionOperation: WEBSITE_PHP_ACTION,
  validateWebsitePhpAction,
  validateNodePassengerMigration,
  validateNode,
  validateDomain,
  validateAuthority,
  validatePassengerDomainStage,
  validatePhpDomainStage,
  phpSocketPattern: PHP_SOCKET_PATTERN,
});
