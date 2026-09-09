import {
  ApplicationValidationError,
  assertUuid,
  normalizeNodeApplicationSpec,
  normalizeNodeRestartSpec,
  normalizeNodeRollbackSpec,
  normalizeNodeStatusSpec,
  normalizeStaticApplicationSpec,
} from '@yunpanel/shared';

export const AGENT_PROTOCOL_VERSION = 4;

export const MANAGED_SERVICE_IDS = Object.freeze([
  'nginx', 'mariadb', 'mysql', 'docker', 'cron', 'postfix', 'dovecot', 'rspamd',
]);
export const MANAGED_SERVICE_ACTIONS = Object.freeze(['start', 'stop', 'restart']);
const MANAGED_SERVICE_ID_SET = new Set(MANAGED_SERVICE_IDS);
const MANAGED_SERVICE_ACTION_SET = new Set(MANAGED_SERVICE_ACTIONS);

export const OPERATIONS = Object.freeze({
  SERVER_INSPECT: 'server.inspect',
  SERVER_SERVICES: 'server.services',
  SERVER_DOCKER: 'server.docker',
  SERVER_NGINX: 'server.nginx',
  SYSTEM_PACKAGES_INSPECT: 'system.packages.inspect',
  SYSTEM_SERVICES_INSPECT: 'system.services.inspect',
  SYSTEM_SERVICE_INSTALL: 'system.service.install',
  SYSTEM_SERVICE_CONTROL: 'system.service.control',
  SYSTEM_UPGRADE: 'system.upgrade',
  DOMAIN_STAGE: 'domain.stage',
  DOMAIN_ACTIVATE: 'domain.activate',
  SSL_ISSUE: 'ssl.issue',
  SSL_RENEW: 'ssl.renew',
  APP_STATIC_DEPLOY: 'app.static.deploy',
  APP_STATIC_ROLLBACK: 'app.static.rollback',
  APP_NODE_DEPLOY: 'app.node.deploy',
  APP_NODE_ROLLBACK: 'app.node.rollback',
  APP_NODE_RESTART: 'app.node.restart',
  APP_NODE_STATUS: 'app.node.status',
});

export const READ_ONLY_OPERATIONS = Object.freeze([
  OPERATIONS.SERVER_INSPECT,
  OPERATIONS.SERVER_SERVICES,
  OPERATIONS.SERVER_DOCKER,
  OPERATIONS.SERVER_NGINX,
  OPERATIONS.SYSTEM_PACKAGES_INSPECT,
  OPERATIONS.SYSTEM_SERVICES_INSPECT,
  OPERATIONS.APP_NODE_STATUS,
]);

const KNOWN_OPERATIONS = new Set(Object.values(OPERATIONS));
const DOMAIN_CHECKSUM = /^[a-f0-9]{64}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export function isKnownOperation(operation) {
  return typeof operation === 'string' && KNOWN_OPERATIONS.has(operation);
}

export function isReadOnlyOperation(operation) {
  return READ_ONLY_OPERATIONS.includes(operation);
}

function validateDomainList(domains, fieldName, errors) {
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 21) {
    errors.push(`${fieldName} must contain between 1 and 21 domains`);
    return;
  }

  const normalized = new Set();
  for (const domain of domains) {
    if (typeof domain !== 'string' || !DOMAIN_PATTERN.test(domain) || domain.includes('*')) {
      errors.push(`${fieldName} contains an invalid domain`);
      continue;
    }
    if (normalized.has(domain)) errors.push(`${fieldName} contains duplicate domains`);
    normalized.add(domain);
  }
}

function validateSafePath(value, fieldName, errors) {
  if (typeof value !== 'string' || value.length > 500 || !SAFE_ABSOLUTE_PATH.test(value) || value.includes('/../') || value.endsWith('/..')) {
    errors.push(`${fieldName} is invalid`);
  }
}

function validateManagedServiceId(value, fieldName, errors) {
  if (typeof value !== 'string' || !MANAGED_SERVICE_ID_SET.has(value)) errors.push(`${fieldName} is invalid`);
}

function rejectUnexpectedKeys(payload, allowedKeys, operation, errors) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(payload).some((key) => !allowed.has(key))) errors.push(`${operation} contains unsupported arguments`);
}

function validateMutationPayload(operation, payload, errors) {
  if (operation === OPERATIONS.SYSTEM_PACKAGES_INSPECT || operation === OPERATIONS.SYSTEM_UPGRADE) {
    if (Object.keys(payload).length !== 0) errors.push(`${operation} does not accept arguments`);
  }

  if (operation === OPERATIONS.SYSTEM_SERVICES_INSPECT) {
    rejectUnexpectedKeys(payload, ['serviceId'], operation, errors);
    if (payload.serviceId !== undefined) validateManagedServiceId(payload.serviceId, 'system.services.inspect serviceId', errors);
  }

  if (operation === OPERATIONS.SYSTEM_SERVICE_INSTALL) {
    rejectUnexpectedKeys(payload, ['serviceId'], operation, errors);
    validateManagedServiceId(payload.serviceId, 'system.service.install serviceId', errors);
  }

  if (operation === OPERATIONS.SYSTEM_SERVICE_CONTROL) {
    rejectUnexpectedKeys(payload, ['serviceId', 'action'], operation, errors);
    validateManagedServiceId(payload.serviceId, 'system.service.control serviceId', errors);
    if (typeof payload.action !== 'string' || !MANAGED_SERVICE_ACTION_SET.has(payload.action)) errors.push('system.service.control action is invalid');
  }

  if (operation === OPERATIONS.DOMAIN_STAGE) {
    if (typeof payload.primaryDomain !== 'string' || payload.primaryDomain.length < 3 || payload.primaryDomain.length > 253) errors.push('domain.stage primaryDomain is invalid');
    if (payload.aliases !== undefined && (!Array.isArray(payload.aliases) || payload.aliases.length > 20)) errors.push('domain.stage aliases must be an array with at most 20 entries');
    if (!['static', 'proxy'].includes(payload.targetType)) errors.push('domain.stage targetType must be static or proxy');
    if (!payload.target || typeof payload.target !== 'object' || Array.isArray(payload.target)) errors.push('domain.stage target must be an object');
    if (payload.tls !== undefined && payload.tls !== null) {
      if (!payload.tls || typeof payload.tls !== 'object' || Array.isArray(payload.tls)) {
        errors.push('domain.stage tls must be an object');
      } else {
        validateSafePath(payload.tls.fullchainPath, 'domain.stage tls.fullchainPath', errors);
        validateSafePath(payload.tls.privateKeyPath, 'domain.stage tls.privateKeyPath', errors);
      }
    }
  }

  if (operation === OPERATIONS.DOMAIN_ACTIVATE) {
    if (typeof payload.primaryDomain !== 'string' || payload.primaryDomain.length < 3 || payload.primaryDomain.length > 253) errors.push('domain.activate primaryDomain is invalid');
    if (typeof payload.checksum !== 'string' || !DOMAIN_CHECKSUM.test(payload.checksum)) errors.push('domain.activate checksum must be a SHA-256 hex digest');
  }

  if (operation === OPERATIONS.SSL_ISSUE) {
    validateDomainList(payload.domains, 'ssl.issue domains', errors);
    if (typeof payload.email !== 'string' || payload.email.length > 254 || !EMAIL_PATTERN.test(payload.email)) errors.push('ssl.issue email is invalid');
    if (payload.staging !== undefined && typeof payload.staging !== 'boolean') errors.push('ssl.issue staging must be boolean');
  }

  if (operation === OPERATIONS.SSL_RENEW) {
    if (typeof payload.certName !== 'string' || !DOMAIN_PATTERN.test(payload.certName) || payload.certName.includes('*')) errors.push('ssl.renew certName is invalid');
    if (payload.dryRun !== undefined && typeof payload.dryRun !== 'boolean') errors.push('ssl.renew dryRun must be boolean');
  }

  if (operation === OPERATIONS.APP_STATIC_DEPLOY) {
    try {
      normalizeStaticApplicationSpec(payload);
    } catch (error) {
      errors.push(error instanceof ApplicationValidationError ? error.message : 'app.static.deploy payload is invalid');
    }
  }

  if (operation === OPERATIONS.APP_STATIC_ROLLBACK) {
    try {
      assertUuid(payload.applicationId, 'applicationId');
      assertUuid(payload.releaseId, 'releaseId');
      assertUuid(payload.currentReleaseId, 'currentReleaseId');
    } catch (error) {
      errors.push(error instanceof ApplicationValidationError ? error.message : 'app.static.rollback payload is invalid');
    }
  }

  if (operation === OPERATIONS.APP_NODE_DEPLOY) {
    try {
      normalizeNodeApplicationSpec(payload);
    } catch (error) {
      errors.push(error instanceof ApplicationValidationError ? error.message : 'app.node.deploy payload is invalid');
    }
  }

  if (operation === OPERATIONS.APP_NODE_ROLLBACK) {
    try {
      normalizeNodeRollbackSpec(payload);
    } catch (error) {
      errors.push(error instanceof ApplicationValidationError ? error.message : 'app.node.rollback payload is invalid');
    }
  }

  if (operation === OPERATIONS.APP_NODE_RESTART) {
    try {
      normalizeNodeRestartSpec(payload);
    } catch (error) {
      errors.push(error instanceof ApplicationValidationError ? error.message : 'app.node.restart payload is invalid');
    }
  }

  if (operation === OPERATIONS.APP_NODE_STATUS) {
    try {
      normalizeNodeStatusSpec(payload);
    } catch (error) {
      errors.push(error instanceof ApplicationValidationError ? error.message : 'app.node.status payload is invalid');
    }
  }
}

export function validateOperationEnvelope(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['request must be an object'] };
  if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) errors.push('id must be a string between 8 and 128 characters');
  if (!isKnownOperation(value.operation)) errors.push('operation is not allowed');
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload must be an object');
  } else if (isKnownOperation(value.operation)) {
    validateMutationPayload(value.operation, value.payload, errors);
  }
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) errors.push(`protocolVersion must equal ${AGENT_PROTOCOL_VERSION}`);
  return { ok: errors.length === 0, errors };
}

export function createOperationEnvelope({ id, operation, payload = {} }) {
  const envelope = { id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION };
  const validation = validateOperationEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return envelope;
}
