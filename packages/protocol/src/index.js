import {
  ApplicationValidationError,
  assertUuid,
  normalizeDomainSet,
  normalizeNodeApplicationSpec,
  normalizeNodeProcessSpec,
  MANAGED_NODE_RUNTIME_MAJORS as SHARED_MANAGED_NODE_RUNTIME_MAJORS,
  normalizeNodeRestartSpec,
  normalizeNodeRollbackSpec,
  normalizeNodeStatusSpec,
  normalizeStaticApplicationSpec,
} from '@yunpanel/shared';
import { isIP, SocketAddress } from 'node:net';

export const AGENT_PROTOCOL_VERSION = 6;

export const MANAGED_SERVICE_IDS = Object.freeze([
  'nginx', 'mariadb', 'mysql', 'docker', 'cron', 'postfix', 'dovecot', 'rspamd',
]);
export const MANAGED_SERVICE_ACTIONS = Object.freeze(['start', 'stop', 'restart']);
export const MANAGED_NODE_RUNTIME_MAJORS = SHARED_MANAGED_NODE_RUNTIME_MAJORS;
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
  SYSTEM_NODE_RUNTIMES_INSPECT: 'system.node-runtimes.inspect',
  SYSTEM_NODE_RUNTIME_INSTALL: 'system.node-runtime.install',
  DATABASE_INSPECT: 'database.inspect',
  DATABASE_CREATE: 'database.create',
  DATABASE_DELETE: 'database.delete',
  DNS_RECORD_APPLY: 'dns.record.apply',
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
  APP_NODE_PROCESS: 'app.node.process',
});

export const READ_ONLY_OPERATIONS = Object.freeze([
  OPERATIONS.SERVER_INSPECT,
  OPERATIONS.SERVER_SERVICES,
  OPERATIONS.SERVER_DOCKER,
  OPERATIONS.SERVER_NGINX,
  OPERATIONS.SYSTEM_PACKAGES_INSPECT,
  OPERATIONS.SYSTEM_SERVICES_INSPECT,
  OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT,
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.APP_NODE_STATUS,
]);

const KNOWN_OPERATIONS = new Set(Object.values(OPERATIONS));
const DOMAIN_CHECKSUM = /^[a-f0-9]{64}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASE_NAMES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const DNS_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function isKnownOperation(operation) {
  return typeof operation === 'string' && KNOWN_OPERATIONS.has(operation);
}

export function isReadOnlyOperation(operation) {
  return READ_ONLY_OPERATIONS.includes(operation);
}

function validateDomainList(domains, fieldName, errors, { allowWildcard = false } = {}) {
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 21) {
    errors.push(`${fieldName} must contain between 1 and 21 domains`);
    return;
  }

  const normalized = new Set();
  for (const domain of domains) {
    const wildcard = typeof domain === 'string' && domain.startsWith('*.');
    const hostname = wildcard ? domain.slice(2) : domain;
    if (typeof domain !== 'string' || !DOMAIN_PATTERN.test(hostname)
      || (wildcard && !allowWildcard) || (!wildcard && domain.includes('*'))) {
      errors.push(`${fieldName} contains an invalid domain`);
      continue;
    }
    if (normalized.has(domain)) errors.push(`${fieldName} contains duplicate domains`);
    normalized.add(domain);
  }
  if (typeof domains[0] === 'string' && domains[0].startsWith('*.')) errors.push(`${fieldName} first domain cannot be a wildcard`);
}

function validateAcmeChallenge(value, operation, errors) {
  if (value === undefined) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${operation} challenge is invalid`);
    return false;
  }
  if (value.type === 'http-01' && Object.keys(value).length === 1) return false;
  const allowed = new Set(['type', 'provider', 'credentialId', 'dnsZoneId', 'propagationSeconds']);
  if (value.type !== 'dns-01' || value.provider !== 'cloudflare'
    || Object.keys(value).length !== allowed.size || Object.keys(value).some((key) => !allowed.has(key))) {
    errors.push(`${operation} DNS challenge is invalid`);
    return false;
  }
  try {
    assertUuid(value.credentialId, 'credentialId');
    assertUuid(value.dnsZoneId, 'dnsZoneId');
  } catch {
    errors.push(`${operation} DNS challenge identities are invalid`);
  }
  if (!Number.isInteger(value.propagationSeconds) || value.propagationSeconds < 10 || value.propagationSeconds > 120) {
    errors.push(`${operation} DNS propagation seconds are invalid`);
  }
  return true;
}

function validateSafePath(value, fieldName, errors) {
  if (typeof value !== 'string' || value.length > 500 || !SAFE_ABSOLUTE_PATH.test(value) || value.includes('/../') || value.endsWith('/..')) {
    errors.push(`${fieldName} is invalid`);
  }
}

function validateManagedServiceId(value, fieldName, errors) {
  if (typeof value !== 'string' || !MANAGED_SERVICE_ID_SET.has(value)) errors.push(`${fieldName} is invalid`);
}

function validateDatabaseName(value, fieldName, errors) {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value) || RESERVED_DATABASE_NAMES.has(value.toLowerCase())) {
    errors.push(`${fieldName} is invalid`);
  }
}

function canonicalDomain(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch { return null; }
}

function canonicalIp(value, family) {
  if (isIP(value) !== family) return null;
  return new SocketAddress({ address: value, family: family === 4 ? 'ipv4' : 'ipv6', port: 0 }).address;
}

function validateDnsRecordApply(payload, operation, errors) {
  rejectUnexpectedKeys(payload, [
    'provider', 'credentialId', 'dnsZoneId', 'zoneName', 'action', 'record', 'expectedSnapshotDigest',
  ], operation, errors);
  if (payload.provider !== 'cloudflare' || !['upsert', 'delete'].includes(payload.action)
    || typeof payload.expectedSnapshotDigest !== 'string' || !SHA256_PATTERN.test(payload.expectedSnapshotDigest)) {
    errors.push(`${operation} provider action or snapshot is invalid`);
  }
  try {
    if (assertUuid(payload.credentialId, 'credentialId') !== payload.credentialId
      || assertUuid(payload.dnsZoneId, 'dnsZoneId') !== payload.dnsZoneId) throw new Error('noncanonical');
  } catch { errors.push(`${operation} identities are invalid`); }
  const zoneName = canonicalDomain(payload.zoneName);
  if (!zoneName || zoneName !== payload.zoneName) errors.push(`${operation} zoneName is invalid`);
  const record = payload.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    errors.push(`${operation} record is invalid`);
    return;
  }
  rejectUnexpectedKeys(record, ['type', 'name', 'content', 'ttl', 'proxied'], `${operation} record`, errors);
  const type = typeof record.type === 'string' ? record.type : '';
  const name = canonicalDomain(record.name);
  const content = type === 'A' ? canonicalIp(record.content, 4)
    : type === 'AAAA' ? canonicalIp(record.content, 6)
      : type === 'CNAME' ? canonicalDomain(record.content) : null;
  if (!DNS_RECORD_TYPES.has(type) || !name || name !== record.name || !content || content !== record.content
    || !zoneName || (name !== zoneName && !name.endsWith(`.${zoneName}`))
    || !Number.isInteger(record.ttl) || (record.ttl !== 1 && (record.ttl < 60 || record.ttl > 86_400))
    || typeof record.proxied !== 'boolean' || (record.proxied && record.ttl !== 1)) {
    errors.push(`${operation} record fields are invalid`);
  }
}

function rejectUnexpectedKeys(payload, allowedKeys, operation, errors) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(payload).some((key) => !allowed.has(key))) errors.push(`${operation} contains unsupported arguments`);
}

function validateEnvironmentRevision(payload, operation, errors) {
  if (payload.environmentRevision !== undefined
    && (!Number.isSafeInteger(payload.environmentRevision) || payload.environmentRevision < 0)) {
    errors.push(`${operation} environmentRevision is invalid`);
  }
}

function validateMutationPayload(operation, payload, errors) {
  if (operation === OPERATIONS.SYSTEM_PACKAGES_INSPECT || operation === OPERATIONS.SYSTEM_UPGRADE
    || operation === OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT || operation === OPERATIONS.DATABASE_INSPECT) {
    if (Object.keys(payload).length !== 0) errors.push(`${operation} does not accept arguments`);
  }

  if (operation === OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL) {
    rejectUnexpectedKeys(payload, ['major'], operation, errors);
    if (!Number.isInteger(payload.major) || !MANAGED_NODE_RUNTIME_MAJORS.includes(payload.major)) {
      errors.push('system.node-runtime.install major is invalid');
    }
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

  if (operation === OPERATIONS.DATABASE_CREATE || operation === OPERATIONS.DATABASE_DELETE) {
    rejectUnexpectedKeys(payload, ['name'], operation, errors);
    validateDatabaseName(payload.name, `${operation} name`, errors);
  }

  if (operation === OPERATIONS.DNS_RECORD_APPLY) validateDnsRecordApply(payload, operation, errors);

  if (operation === OPERATIONS.DOMAIN_STAGE) {
    rejectUnexpectedKeys(payload, ['primaryDomain', 'aliases', 'targetType', 'target', 'tls', 'canonicalRedirect', 'httpsRedirect'], operation, errors);
    if (typeof payload.primaryDomain !== 'string' || payload.primaryDomain.length < 3 || payload.primaryDomain.length > 253) errors.push('domain.stage primaryDomain is invalid');
    if (payload.aliases !== undefined && (!Array.isArray(payload.aliases) || payload.aliases.length > 20)) errors.push('domain.stage aliases must be an array with at most 20 entries');
    if (!['static', 'proxy'].includes(payload.targetType)) errors.push('domain.stage targetType must be static or proxy');
    if (!payload.target || typeof payload.target !== 'object' || Array.isArray(payload.target)) errors.push('domain.stage target must be an object');
    if (payload.canonicalRedirect !== undefined && typeof payload.canonicalRedirect !== 'boolean') errors.push('domain.stage canonicalRedirect must be a boolean');
    if (payload.httpsRedirect !== undefined && typeof payload.httpsRedirect !== 'boolean') errors.push('domain.stage httpsRedirect must be a boolean');
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
    rejectUnexpectedKeys(payload, ['primaryDomain', 'previousPrimaryDomain', 'checksum'], operation, errors);
    if (typeof payload.primaryDomain !== 'string' || payload.primaryDomain.length < 3 || payload.primaryDomain.length > 253) errors.push('domain.activate primaryDomain is invalid');
    if (payload.previousPrimaryDomain !== undefined && payload.previousPrimaryDomain !== null
      && (typeof payload.previousPrimaryDomain !== 'string' || !DOMAIN_PATTERN.test(payload.previousPrimaryDomain))) {
      errors.push('domain.activate previousPrimaryDomain is invalid');
    }
    if (typeof payload.checksum !== 'string' || !DOMAIN_CHECKSUM.test(payload.checksum)) errors.push('domain.activate checksum must be a SHA-256 hex digest');
  }

  if (operation === OPERATIONS.SSL_ISSUE) {
    rejectUnexpectedKeys(payload, ['domains', 'email', 'staging', 'challenge'], operation, errors);
    const dnsChallenge = validateAcmeChallenge(payload.challenge, operation, errors);
    validateDomainList(payload.domains, 'ssl.issue domains', errors, { allowWildcard: dnsChallenge });
    if (typeof payload.email !== 'string' || payload.email.length > 254 || !EMAIL_PATTERN.test(payload.email)) errors.push('ssl.issue email is invalid');
    if (payload.staging !== undefined && typeof payload.staging !== 'boolean') errors.push('ssl.issue staging must be boolean');
  }

  if (operation === OPERATIONS.SSL_RENEW) {
    rejectUnexpectedKeys(payload, ['certName', 'dryRun', 'challenge'], operation, errors);
    validateAcmeChallenge(payload.challenge, operation, errors);
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
    rejectUnexpectedKeys(payload, [
      'applicationId', 'deploymentId', 'repositoryUrl', 'branch', 'gitTarget', 'runtime', 'retention', 'environmentRevision',
    ], operation, errors);
    validateEnvironmentRevision(payload, operation, errors);
    try {
      normalizeNodeApplicationSpec(payload);
    } catch (error) {
      errors.push(error instanceof ApplicationValidationError ? error.message : 'app.node.deploy payload is invalid');
    }
  }

  if (operation === OPERATIONS.APP_NODE_ROLLBACK) {
    rejectUnexpectedKeys(payload, ['applicationId', 'releaseId', 'currentReleaseId', 'runtime', 'environmentRevision'], operation, errors);
    validateEnvironmentRevision(payload, operation, errors);
    try {
      normalizeNodeRollbackSpec(payload);
    } catch (error) {
      errors.push(error instanceof ApplicationValidationError ? error.message : 'app.node.rollback payload is invalid');
    }
  }

  if (operation === OPERATIONS.APP_NODE_RESTART) {
    rejectUnexpectedKeys(payload, ['applicationId', 'releaseId', 'runtime', 'environmentRevision'], operation, errors);
    validateEnvironmentRevision(payload, operation, errors);
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

  if (operation === OPERATIONS.APP_NODE_PROCESS) {
    try {
      normalizeNodeProcessSpec(payload);
    } catch (error) {
      errors.push(error instanceof ApplicationValidationError ? error.message : 'app.node.process payload is invalid');
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
