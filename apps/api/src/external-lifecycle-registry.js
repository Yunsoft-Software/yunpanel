import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid, DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const STORE_VERSION = 1;
const EXTERNAL_MANAGEMENT_MODE = 'external';
const LOCAL_MANAGEMENT_MODE = 'local';
const STATUSES = new Set(['unverified', 'ready', 'degraded']);
const LOCAL_MAIL_STATUSES = new Set(['disabled', 'enabled']);
const WEB_DOMAIN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,119}$/;
const DNS_OBSERVATION_DIAGNOSES = Object.freeze({
  dns_expected_address_unavailable: Object.freeze({ message: 'The managed Server does not expose a usable public address.', action: 'Inspect the managed Server network inventory.' }),
  dns_resolver_unavailable: Object.freeze({ message: 'Public DNS resolution could not be completed.', action: 'Retry DNS readiness after resolver connectivity recovers.' }),
  resolver_timeout: Object.freeze({ message: 'Public DNS resolution timed out.', action: 'Retry DNS readiness after resolver connectivity recovers.' }),
  dns_address_missing: Object.freeze({ message: 'The web hostname has no public address record.', action: 'Publish the required A or AAAA record, then refresh readiness.' }),
  dns_target_mismatch: Object.freeze({ message: 'A public DNS address does not match the managed Server.', action: 'Correct the hostname target, then refresh readiness.' }),
});

export class ExternalLifecycleRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ExternalLifecycleRegistryError';
    this.code = code;
    this.status = status;
  }
}

function timestamp(value, field, prefix) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ExternalLifecycleRegistryError(`${prefix}_state_invalid`, `${field} is invalid`, 409);
  }
  return new Date(value).toISOString();
}

function id(value, prefix) {
  try { return assertUuid(value, `${prefix}Id`); }
  catch { throw new ExternalLifecycleRegistryError(`invalid_${prefix}_id`, `${prefix}Id must be a UUID`); }
}

function webDomainId(value, prefix) {
  if (value === null) return null;
  if (typeof value !== 'string' || !WEB_DOMAIN_ID_PATTERN.test(value)) {
    throw new ExternalLifecycleRegistryError(`invalid_${prefix}_web_domain_id`, 'webDomainId must be a safe Domain identity or null');
  }
  return value;
}

function canonicalName(value, prefix) {
  try { return normalizeDomainSet(value, []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) {
      throw new ExternalLifecycleRegistryError(`invalid_${prefix}_name`, error.message);
    }
    throw error;
  }
}

function errorCode(value, status, prefix) {
  if (status === 'degraded') {
    if (typeof value !== 'string' || !ERROR_CODE_PATTERN.test(value)) {
      throw new ExternalLifecycleRegistryError(`invalid_${prefix}_error_code`, 'Degraded status requires a bounded authored error code');
    }
    return value;
  }
  if (value !== null && value !== undefined) {
    throw new ExternalLifecycleRegistryError(`invalid_${prefix}_error_code`, 'Only degraded status accepts an error code');
  }
  return null;
}

function managementMode(value, resourceType, prefix) {
  if (value === EXTERNAL_MANAGEMENT_MODE
    || (resourceType === 'mail_domain' && value === LOCAL_MANAGEMENT_MODE)) return value;
  throw new ExternalLifecycleRegistryError(
    `${prefix}_management_mode_unsupported`,
    resourceType === 'mail_domain'
      ? 'Mail domain managementMode must be external or local'
      : 'Only explicit external lifecycle tracking is implemented',
    409,
  );
}

function publicResource(resource, { resourceType, nameField }) {
  const diagnosis = resourceType === 'dns_zone' ? dnsObservationDiagnosis(resource) : null;
  return Object.freeze({
    id: resource.id,
    resourceType,
    [nameField]: resource[nameField],
    webDomainId: resource.webDomainId,
    managementMode: resource.managementMode,
    status: resource.status,
    revision: resource.revision,
    lastObservedAt: resource.lastObservedAt,
    lastErrorCode: resourceType === 'dns_zone'
      ? diagnosis?.severity === 'error' ? diagnosis.code : null
      : resource.lastErrorCode,
    diagnosis,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  });
}

function dnsObservationDiagnosis(resource) {
  if (resource.status === 'unverified') {
    return Object.freeze({
      severity: 'action_required', code: 'dns_readiness_required',
      message: 'DNS readiness has not been checked.',
      action: 'Run a DNS readiness refresh for the current zone revision.',
    });
  }
  if (resource.status !== 'degraded') return null;
  const authored = DNS_OBSERVATION_DIAGNOSES[resource.lastErrorCode];
  if (!authored) {
    return Object.freeze({
      severity: 'error', code: 'dns_observation_failed',
      message: 'The last DNS readiness observation failed.',
      action: 'Inspect the protected DNS diagnostics and refresh readiness.',
    });
  }
  return Object.freeze({ severity: 'error', code: resource.lastErrorCode, ...authored });
}

function validatePersisted(value, options) {
  const { prefix, resourceType, nameField } = options;
  const allowed = new Set([
    'id', nameField, 'webDomainId', 'managementMode', 'status', 'revision', 'lastObservedAt', 'lastErrorCode', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== allowed.size
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ExternalLifecycleRegistryError(`${prefix}_state_invalid`, `${resourceType} state is invalid`, 409);
  }
  const normalizedManagementMode = managementMode(value.managementMode, resourceType, prefix);
  const normalizedStatus = (normalizedManagementMode === EXTERNAL_MANAGEMENT_MODE ? STATUSES : LOCAL_MAIL_STATUSES).has(value.status)
    ? value.status
    : null;
  if (!normalizedStatus
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new ExternalLifecycleRegistryError(`${prefix}_state_invalid`, `${resourceType} lifecycle state is invalid`, 409);
  }
  const lastObservedAt = value.lastObservedAt === null ? null : timestamp(value.lastObservedAt, 'lastObservedAt', prefix);
  if (normalizedManagementMode === EXTERNAL_MANAGEMENT_MODE
    && (normalizedStatus === 'unverified') !== (lastObservedAt === null)) {
    throw new ExternalLifecycleRegistryError(`${prefix}_state_invalid`, `${resourceType} observation state is inconsistent`, 409);
  }
  if (normalizedManagementMode === LOCAL_MANAGEMENT_MODE && lastObservedAt !== null) {
    throw new ExternalLifecycleRegistryError(`${prefix}_state_invalid`, 'Local mail-domain state cannot contain an external observation', 409);
  }
  return {
    id: id(value.id, prefix),
    [nameField]: canonicalName(value[nameField], prefix),
    webDomainId: webDomainId(value.webDomainId, prefix),
    managementMode: normalizedManagementMode,
    status: normalizedStatus,
    revision: value.revision,
    lastObservedAt,
    lastErrorCode: errorCode(value.lastErrorCode, normalizedStatus, prefix),
    createdAt: timestamp(value.createdAt, 'createdAt', prefix),
    updatedAt: timestamp(value.updatedAt, 'updatedAt', prefix),
  };
}

export function createExternalLifecycleRegistry({
  filePath = null,
  now = () => Date.now(),
  getWebDomain = null,
  prefix,
  resourceType,
  collectionKey,
  nameField,
} = {}) {
  const supported = (
    prefix === 'dns_zone' && resourceType === 'dns_zone' && collectionKey === 'dnsZones' && nameField === 'zoneName'
  ) || (
    prefix === 'mail_domain' && resourceType === 'mail_domain' && collectionKey === 'mailDomains' && nameField === 'domainName'
  );
  if (!supported
    || typeof now !== 'function' || (getWebDomain !== null && typeof getWebDomain !== 'function')) {
    throw new ExternalLifecycleRegistryError('external_lifecycle_dependencies_invalid', 'External lifecycle registry dependencies are invalid', 503);
  }
  const options = Object.freeze({ prefix, resourceType, collectionKey, nameField });
  const managementModeValue = (value) => managementMode(value, resourceType, prefix);
  let state = { version: STORE_VERSION, [collectionKey]: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function validateReference(resource, { persisted = false } = {}) {
    if (resource.webDomainId === null) return;
    if (typeof getWebDomain !== 'function') {
      throw new ExternalLifecycleRegistryError(`${prefix}_web_domain_unavailable`, 'Web Domain registry is unavailable', 503);
    }
    let domain;
    try { domain = await getWebDomain(resource.webDomainId); }
    catch {
      throw new ExternalLifecycleRegistryError(`${prefix}_web_domain_unavailable`, 'Web Domain reference could not be verified', 503);
    }
    if (!domain) {
      throw new ExternalLifecycleRegistryError(`${prefix}_web_domain_not_found`, 'Referenced web Domain does not exist', persisted ? 409 : 404);
    }
    if (domain.primaryDomain !== resource[nameField]) {
      throw new ExternalLifecycleRegistryError(`${prefix}_web_domain_mismatch`, 'Lifecycle name must exactly match the referenced web Domain', 409);
    }
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed[collectionKey])
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((key) => !['version', collectionKey].includes(key))) {
          throw new ExternalLifecycleRegistryError(`${prefix}_state_invalid`, `${resourceType} store is invalid`, 409);
        }
        const resources = parsed[collectionKey].map((value) => validatePersisted(value, options));
        const ids = new Set();
        const names = new Set();
        const references = new Set();
        for (const resource of resources) {
          if (ids.has(resource.id) || names.has(resource[nameField])
            || (resource.webDomainId !== null && references.has(resource.webDomainId))) {
            throw new ExternalLifecycleRegistryError(`${prefix}_state_invalid`, `${resourceType} identities must be unique`, 409);
          }
          ids.add(resource.id);
          names.add(resource[nameField]);
          if (resource.webDomainId !== null) references.add(resource.webDomainId);
          await validateReference(resource, { persisted: true });
        }
        state = { version: STORE_VERSION, [collectionKey]: resources };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist();
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function createResource({ name, webDomainId: requestedWebDomainId = null, managementMode } = {}) {
    await ensureInitialized();
    const normalizedManagementMode = managementModeValue(managementMode);
    const normalizedName = canonicalName(name, prefix);
    const normalizedWebDomainId = webDomainId(requestedWebDomainId, prefix);
    const candidate = { [nameField]: normalizedName, webDomainId: normalizedWebDomainId };
    await validateReference(candidate);
    if (state[collectionKey].some((resource) => resource[nameField] === normalizedName)) {
      throw new ExternalLifecycleRegistryError(`${prefix}_name_conflict`, `${resourceType} name is already tracked`, 409);
    }
    if (normalizedWebDomainId !== null && state[collectionKey].some((resource) => resource.webDomainId === normalizedWebDomainId)) {
      throw new ExternalLifecycleRegistryError(`${prefix}_web_domain_conflict`, 'Web Domain already has this lifecycle relationship', 409);
    }
    const current = new Date(now()).toISOString();
    const resource = {
      id: randomUUID(),
      [nameField]: normalizedName,
      webDomainId: normalizedWebDomainId,
      managementMode: normalizedManagementMode,
      status: normalizedManagementMode === EXTERNAL_MANAGEMENT_MODE ? 'unverified' : 'disabled',
      revision: 1,
      lastObservedAt: null,
      lastErrorCode: null,
      createdAt: current,
      updatedAt: current,
    };
    state[collectionKey].push(resource);
    await persist();
    return publicResource(resource, options);
  }

  async function recordObservation(resourceId, { expectedRevision, status, errorCode: requestedErrorCode = null } = {}) {
    await ensureInitialized();
    const normalizedId = id(resourceId, prefix);
    const resource = state[collectionKey].find((candidate) => candidate.id === normalizedId);
    if (!resource) throw new ExternalLifecycleRegistryError(`${prefix}_not_found`, `${resourceType} was not found`, 404);
    if (resource.managementMode !== EXTERNAL_MANAGEMENT_MODE) {
      throw new ExternalLifecycleRegistryError(`${prefix}_observation_not_applicable`, 'Local mail-domain state does not accept external observations', 409);
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ExternalLifecycleRegistryError(`invalid_${prefix}_revision`, 'A positive expected revision is required');
    }
    if (resource.revision !== expectedRevision) {
      throw new ExternalLifecycleRegistryError(`${prefix}_revision_conflict`, `${resourceType} changed before observation`, 409);
    }
    if (!STATUSES.has(status) || status === 'unverified') {
      throw new ExternalLifecycleRegistryError(`invalid_${prefix}_status`, 'Observed status must be ready or degraded');
    }
    const normalizedErrorCode = errorCode(requestedErrorCode, status, prefix);
    const current = new Date(now()).toISOString();
    resource.status = status;
    resource.revision += 1;
    resource.lastObservedAt = current;
    resource.lastErrorCode = normalizedErrorCode;
    resource.updatedAt = current;
    await persist();
    return publicResource(resource, options);
  }

  async function transitionLocalStatus(resourceId, { expectedRevision, status } = {}) {
    await ensureInitialized();
    const normalizedId = id(resourceId, prefix);
    const resource = state[collectionKey].find((candidate) => candidate.id === normalizedId);
    if (!resource) throw new ExternalLifecycleRegistryError(`${prefix}_not_found`, `${resourceType} was not found`, 404);
    if (resourceType !== 'mail_domain' || resource.managementMode !== LOCAL_MANAGEMENT_MODE) {
      throw new ExternalLifecycleRegistryError(`${prefix}_local_status_not_applicable`, 'Only locally managed mail domains have a local lifecycle status', 409);
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ExternalLifecycleRegistryError(`invalid_${prefix}_revision`, 'A positive expected revision is required');
    }
    if (resource.revision !== expectedRevision) {
      throw new ExternalLifecycleRegistryError(`${prefix}_revision_conflict`, `${resourceType} changed before local status transition`, 409);
    }
    if (!LOCAL_MAIL_STATUSES.has(status)) {
      throw new ExternalLifecycleRegistryError(`invalid_${prefix}_status`, 'Local mail-domain status must be disabled or enabled');
    }
    if (resource.status === status) {
      throw new ExternalLifecycleRegistryError(`${prefix}_status_no_change`, 'Local mail-domain status is unchanged', 409);
    }
    resource.status = status;
    resource.revision += 1;
    resource.lastObservedAt = null;
    resource.lastErrorCode = null;
    resource.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicResource(resource, options);
  }

  async function getResource(resourceId) {
    await ensureInitialized();
    const resource = state[collectionKey].find((candidate) => candidate.id === resourceId);
    return resource ? publicResource(resource, options) : null;
  }

  async function listResources() {
    await ensureInitialized();
    return state[collectionKey].map((resource) => publicResource(resource, options));
  }

  return Object.freeze({ init, createResource, recordObservation, transitionLocalStatus, getResource, listResources });
}

export const externalLifecycleRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  managementModes: Object.freeze([EXTERNAL_MANAGEMENT_MODE, LOCAL_MANAGEMENT_MODE]),
  statuses: Object.freeze([...STATUSES]),
  localMailStatuses: Object.freeze([...LOCAL_MAIL_STATUSES]),
  webDomainId,
  canonicalName,
  errorCode,
  publicResource,
  dnsObservationDiagnosis,
  validatePersisted,
});
