import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const ADAPTERS = new Set(['direct-systemd', 'passenger', 'static']);
const STATES = new Set(['active', 'cleanup_required']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const APP_ENV_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
const PASSENGER_TARGET_FIELDS = new Set([
  'appRoot',
  'documentRoot',
  'startupFile',
  'nodeBinary',
  'user',
  'group',
  'appEnv',
  'environmentInclude',
]);
const STATIC_TARGET_FIELDS = new Set([
  'publishRoot',
  'documentRoot',
  'user',
  'group',
]);

export class ApplicationRuntimeBindingRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApplicationRuntimeBindingRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new ApplicationRuntimeBindingRegistryError('runtime_binding_identity_invalid', `${field} must be a UUID`); }
}

function revision(value, field, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ApplicationRuntimeBindingRegistryError('runtime_binding_revision_invalid', `${field} is invalid`);
  }
  return value;
}

function domains(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new ApplicationRuntimeBindingRegistryError('runtime_binding_domains_invalid', 'Runtime binding domains are invalid');
  }
  const seen = new Set();
  const normalized = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 3) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_domains_invalid', 'Runtime binding domains are invalid');
    }
    const domainId = uuid(entry.domainId, 'domainId');
    if (seen.has(domainId)) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_domains_invalid', 'Runtime binding domains must be unique');
    }
    seen.add(domainId);
    if (typeof entry.nginxChecksum !== 'string' || !SHA256_PATTERN.test(entry.nginxChecksum)) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_checksum_invalid', 'Runtime binding Nginx checksum is invalid');
    }
    return Object.freeze({
      domainId,
      desiredRevision: revision(entry.desiredRevision, 'domain desiredRevision'),
      nginxChecksum: entry.nginxChecksum,
    });
  });
  normalized.sort((left, right) => left.domainId.localeCompare(right.domainId));
  return Object.freeze(normalized);
}

function safeAbsolutePath(value) {
  return typeof value === 'string' && value.length <= 500 && SAFE_PATH_PATTERN.test(value)
    && path.posix.normalize(value) === value && !value.includes('/../') && !value.endsWith('/..');
}

function staticTarget(value, adapter) {
  if (adapter !== 'static') {
    if (value !== null && value !== undefined) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_target_invalid', `${adapter} runtime binding cannot persist a static target`, 409);
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== STATIC_TARGET_FIELDS.size
    || Object.keys(value).some((field) => !STATIC_TARGET_FIELDS.has(field))
    || !safeAbsolutePath(value.publishRoot)
    || !safeAbsolutePath(value.documentRoot)
    || !APP_USER_PATTERN.test(value.user)
    || value.group !== value.user) {
    throw new ApplicationRuntimeBindingRegistryError('runtime_binding_target_invalid', 'Static runtime binding target is invalid', 409);
  }
  return Object.freeze({ ...value });
}

function passengerTarget(value, adapter) {
  if (adapter !== 'passenger') {
    if (value !== null && value !== undefined) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_target_invalid', `${adapter} runtime binding cannot persist a Passenger target`, 409);
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== PASSENGER_TARGET_FIELDS.size
    || Object.keys(value).some((field) => !PASSENGER_TARGET_FIELDS.has(field))
    || !safeAbsolutePath(value.appRoot)
    || !safeAbsolutePath(value.documentRoot)
    || !safeAbsolutePath(value.nodeBinary)
    || (value.environmentInclude !== null && !safeAbsolutePath(value.environmentInclude))
    || typeof value.startupFile !== 'string' || value.startupFile.length > 300
    || !SAFE_RELATIVE_PATH_PATTERN.test(value.startupFile)
    || path.posix.isAbsolute(value.startupFile)
    || path.posix.normalize(value.startupFile) !== value.startupFile
    || value.startupFile.startsWith('../') || value.startupFile.includes('/../')
    || !APP_USER_PATTERN.test(value.user)
    || value.group !== value.user
    || typeof value.appEnv !== 'string' || !APP_ENV_PATTERN.test(value.appEnv)) {
    throw new ApplicationRuntimeBindingRegistryError('runtime_binding_target_invalid', 'Passenger runtime binding target is invalid', 409);
  }
  return Object.freeze({ ...value });
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !ADAPTERS.has(value.adapter) || !STATES.has(value.state)) {
    throw new ApplicationRuntimeBindingRegistryError('runtime_binding_state_invalid', 'Persisted runtime binding state is invalid', 409);
  }
  const normalized = {
    applicationId: uuid(value.applicationId, 'applicationId'),
    serverId: uuid(value.serverId, 'serverId'),
    adapter: value.adapter,
    state: value.state,
    revision: revision(value.revision, 'revision'),
    sourceOperationId: uuid(value.sourceOperationId, 'sourceOperationId'),
    releaseId: uuid(value.releaseId, 'releaseId'),
    websiteId: uuid(value.websiteId, 'websiteId'),
    websiteRevision: revision(value.websiteRevision, 'websiteRevision'),
    domains: domains(value.domains),
    passengerTarget: passengerTarget(value.passengerTarget, value.adapter),
    staticTarget: staticTarget(value.staticTarget, value.adapter),
    updatedAt: value.updatedAt,
  };
  if (typeof normalized.updatedAt !== 'string' || Number.isNaN(Date.parse(normalized.updatedAt))) {
    throw new ApplicationRuntimeBindingRegistryError('runtime_binding_state_invalid', 'Persisted runtime binding timestamp is invalid', 409);
  }
  if (normalized.adapter !== 'passenger' && normalized.state !== 'active') {
    throw new ApplicationRuntimeBindingRegistryError('runtime_binding_state_invalid', `${normalized.adapter} runtime binding cannot require Passenger cleanup`, 409);
  }
  return Object.freeze(normalized);
}

function publicRecord(record) {
  if (!record) return null;
  return Object.freeze({
    ...record,
    domains: Object.freeze(record.domains.map((entry) => Object.freeze({ ...entry }))),
    passengerTarget: record.passengerTarget ? Object.freeze({ ...record.passengerTarget }) : null,
    staticTarget: record.staticTarget ? Object.freeze({ ...record.staticTarget }) : null,
  });
}

function sameActivation(left, right) {
  return left.applicationId === right.applicationId
    && left.serverId === right.serverId
    && left.adapter === right.adapter
    && left.state === right.state
    && left.sourceOperationId === right.sourceOperationId
    && left.releaseId === right.releaseId
    && left.websiteId === right.websiteId
    && left.websiteRevision === right.websiteRevision
    && JSON.stringify(left.domains) === JSON.stringify(right.domains)
    && JSON.stringify(left.passengerTarget) === JSON.stringify(right.passengerTarget)
    && JSON.stringify(left.staticTarget) === JSON.stringify(right.staticTarget);
}

export function createApplicationRuntimeBindingRegistry({ filePath = null, now = () => Date.now() } = {}) {
  let state = { version: STORE_VERSION, bindings: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)) {
          throw new ApplicationRuntimeBindingRegistryError('runtime_binding_store_invalid', 'Runtime binding store is invalid', 409);
        }
        state = { version: STORE_VERSION, bindings: parsed.bindings.map((entry) => ({ ...normalizeRecord(entry) })) };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function getBinding(applicationId) {
    await ensureInitialized();
    const id = uuid(applicationId, 'applicationId');
    return publicRecord(state.bindings.find((entry) => entry.applicationId === id) ?? null);
  }

  async function activate(input, { expectedRevision = 0 } = {}) {
    await ensureInitialized();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_expected_revision_invalid', 'Expected runtime binding revision is invalid');
    }
    const candidate = normalizeRecord({
      ...input,
      revision: Math.max(1, expectedRevision + 1),
      updatedAt: new Date(now()).toISOString(),
    });
    const index = state.bindings.findIndex((entry) => entry.applicationId === candidate.applicationId);
    const existing = index < 0 ? null : normalizeRecord(state.bindings[index]);
    if (existing && sameActivation(existing, candidate)) return publicRecord(existing);
    const currentRevision = existing?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_revision_conflict', 'Runtime binding changed after preview', 409);
    }
    if (existing && existing.serverId !== candidate.serverId) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_server_conflict', 'Runtime binding cannot move applications between servers', 409);
    }
    if (index < 0) state.bindings.push({ ...candidate });
    else state.bindings[index] = { ...candidate };
    await persist();
    return publicRecord(candidate);
  }

  async function removeOwnedPassenger(applicationId, { sourceOperationId, expectedRevision } = {}) {
    await ensureInitialized();
    const id = uuid(applicationId, 'applicationId');
    const operationId = uuid(sourceOperationId, 'sourceOperationId');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_expected_revision_invalid', 'Expected runtime binding revision is invalid');
    }
    const index = state.bindings.findIndex((entry) => entry.applicationId === id);
    if (index < 0) return null;
    const existing = normalizeRecord(state.bindings[index]);
    if (existing.adapter !== 'passenger' || existing.sourceOperationId !== operationId) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_ownership_conflict', 'Runtime binding is not owned by the requested Passenger operation', 409);
    }
    if (existing.revision !== expectedRevision) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_revision_conflict', 'Runtime binding changed after provisioning', 409);
    }
    state.bindings.splice(index, 1);
    await persist();
    return publicRecord(existing);
  }

  async function removeOwnedStatic(applicationId, { sourceOperationId, expectedRevision } = {}) {
    await ensureInitialized();
    const id = uuid(applicationId, 'applicationId');
    const operationId = uuid(sourceOperationId, 'sourceOperationId');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_expected_revision_invalid', 'Expected runtime binding revision is invalid');
    }
    const index = state.bindings.findIndex((entry) => entry.applicationId === id);
    if (index < 0) return null;
    const existing = normalizeRecord(state.bindings[index]);
    if (existing.adapter !== 'static' || existing.sourceOperationId !== operationId) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_ownership_conflict', 'Runtime binding is not owned by the requested static operation', 409);
    }
    if (existing.revision !== expectedRevision) {
      throw new ApplicationRuntimeBindingRegistryError('runtime_binding_revision_conflict', 'Runtime binding changed after provisioning', 409);
    }
    state.bindings.splice(index, 1);
    await persist();
    return publicRecord(existing);
  }

  return Object.freeze({ init, getBinding, activate, removeOwnedPassenger, removeOwnedStatic });
}

export const applicationRuntimeBindingRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  adapters: Object.freeze([...ADAPTERS]),
  states: Object.freeze([...STATES]),
  normalizeRecord,
  domains,
  passengerTarget,
  staticTarget,
  sameActivation,
});
