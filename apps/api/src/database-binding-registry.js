import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;

export class DatabaseBindingRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DatabaseBindingRegistryError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return { version: STORE_VERSION, bindings: [] };
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new DatabaseBindingRegistryError(
      `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      `${field} is invalid`,
    );
  }
}

function databaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value) || RESERVED_DATABASES.has(value.toLowerCase())) {
    throw new DatabaseBindingRegistryError('invalid_database_name', 'Database name is invalid');
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new DatabaseBindingRegistryError('database_binding_state_invalid', 'Database binding timestamp is invalid', 409);
  }
  return new Date(value).toISOString();
}

function publicBinding(binding) {
  return Object.freeze({ ...binding });
}

function normalizePersisted(value) {
  const allowed = new Set([
    'id', 'serverId', 'databaseName', 'websiteId', 'applicationId', 'unixUser',
    'revision', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== allowed.size || Object.keys(value).some((key) => !allowed.has(key))
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.unixUser !== 'string' || !APP_USER_PATTERN.test(value.unixUser)) {
    throw new DatabaseBindingRegistryError('database_binding_state_invalid', 'Database binding state is invalid', 409);
  }
  return {
    id: uuid(value.id, 'databaseBindingId'),
    serverId: uuid(value.serverId, 'serverId'),
    databaseName: databaseName(value.databaseName),
    websiteId: uuid(value.websiteId, 'websiteId'),
    applicationId: uuid(value.applicationId, 'applicationId'),
    unixUser: value.unixUser,
    revision: value.revision,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

export function createDatabaseBindingRegistry({
  filePath = null,
  now = () => Date.now(),
  serverExists,
  getWebsite,
  getApplication,
} = {}) {
  if (typeof now !== 'function' || typeof serverExists !== 'function'
    || typeof getWebsite !== 'function' || typeof getApplication !== 'function') {
    throw new DatabaseBindingRegistryError(
      'database_binding_dependencies_invalid',
      'Database binding registry dependencies are unavailable',
      503,
    );
  }
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
    });
    return writeChain;
  }

  async function resolveOwnership({ serverId, websiteId, applicationId = null }) {
    const normalizedServerId = uuid(serverId, 'serverId');
    const normalizedWebsiteId = uuid(websiteId, 'websiteId');
    let serverPresent;
    try { serverPresent = await serverExists(normalizedServerId); }
    catch {
      throw new DatabaseBindingRegistryError('database_binding_server_unavailable', 'Server state could not be verified', 503);
    }
    if (!serverPresent) throw new DatabaseBindingRegistryError('server_not_found', 'Server not found', 404);

    let website;
    try { website = await getWebsite(normalizedWebsiteId); }
    catch {
      throw new DatabaseBindingRegistryError('database_binding_website_unavailable', 'Website state could not be verified', 503);
    }
    if (!website) throw new DatabaseBindingRegistryError('website_not_found', 'Website not found', 404);
    if (website.serverId !== normalizedServerId) {
      throw new DatabaseBindingRegistryError('database_binding_website_server_mismatch', 'Website belongs to a different server', 409);
    }
    if (!['static', 'node'].includes(website.runtimeType)
      || typeof website.applicationId !== 'string' || !website.applicationId
      || typeof website.unixUser !== 'string' || !APP_USER_PATTERN.test(website.unixUser)) {
      throw new DatabaseBindingRegistryError(
        'database_binding_website_unsupported',
        'Database binding requires a managed static or Node Website with a site user',
        409,
      );
    }
    const normalizedApplicationId = uuid(website.applicationId, 'applicationId');
    if (applicationId !== null && uuid(applicationId, 'applicationId') !== normalizedApplicationId) {
      throw new DatabaseBindingRegistryError(
        'database_binding_application_mismatch',
        'Requested Application does not match the Website binding',
        409,
      );
    }

    let application;
    try { application = await getApplication(normalizedApplicationId); }
    catch {
      throw new DatabaseBindingRegistryError('database_binding_application_unavailable', 'Application state could not be verified', 503);
    }
    if (!application || application.id !== normalizedApplicationId) {
      throw new DatabaseBindingRegistryError('application_not_found', 'Application not found', 404);
    }
    if (application.serverId !== normalizedServerId || application.type !== website.runtimeType) {
      throw new DatabaseBindingRegistryError(
        'database_binding_application_server_mismatch',
        'Application ownership does not match the Website and Server',
        409,
      );
    }
    return Object.freeze({
      serverId: normalizedServerId,
      websiteId: normalizedWebsiteId,
      applicationId: normalizedApplicationId,
      unixUser: website.unixUser,
    });
  }

  async function validateBindingReference(binding, { persisted = false } = {}) {
    try {
      const ownership = await resolveOwnership(binding);
      if (ownership.unixUser !== binding.unixUser) {
        throw new DatabaseBindingRegistryError(
          'database_binding_site_user_drift',
          'Database binding site user no longer matches Website ownership',
          409,
        );
      }
    } catch (error) {
      if (persisted && error instanceof DatabaseBindingRegistryError && error.status === 404) {
        throw new DatabaseBindingRegistryError('database_binding_state_invalid', 'Persisted database binding reference is stale', 409);
      }
      throw error;
    }
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((key) => !['version', 'bindings'].includes(key))) {
          throw new DatabaseBindingRegistryError('database_binding_state_invalid', 'Database binding store is invalid', 409);
        }
        const bindings = parsed.bindings.map(normalizePersisted);
        const ids = new Set();
        const databases = new Set();
        for (const binding of bindings) {
          const databaseKey = `${binding.serverId}:${binding.databaseName.toLowerCase()}`;
          if (ids.has(binding.id) || databases.has(databaseKey)) {
            throw new DatabaseBindingRegistryError('database_binding_state_invalid', 'Database binding identities must be unique', 409);
          }
          ids.add(binding.id);
          databases.add(databaseKey);
          await validateBindingReference(binding, { persisted: true });
        }
        state = { version: STORE_VERSION, bindings };
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

  async function bindDatabase({ serverId, databaseName: requestedName, websiteId, applicationId = null, confirmation } = {}) {
    await ensureInitialized();
    const name = databaseName(requestedName);
    const ownership = await resolveOwnership({ serverId, websiteId, applicationId });
    const expectedConfirmation = `bind-database:${ownership.serverId}:${name}:${ownership.websiteId}`;
    if (confirmation !== expectedConfirmation) {
      throw new DatabaseBindingRegistryError('database_binding_confirmation_mismatch', 'Database binding confirmation does not match', 409);
    }
    const existing = state.bindings.find((binding) => binding.serverId === ownership.serverId
      && binding.databaseName.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (existing.websiteId === ownership.websiteId && existing.applicationId === ownership.applicationId
        && existing.unixUser === ownership.unixUser && existing.databaseName === name) return publicBinding(existing);
      throw new DatabaseBindingRegistryError('database_already_bound', 'Database is already bound to another Website', 409);
    }
    const current = new Date(now()).toISOString();
    const binding = {
      id: randomUUID(),
      serverId: ownership.serverId,
      databaseName: name,
      websiteId: ownership.websiteId,
      applicationId: ownership.applicationId,
      unixUser: ownership.unixUser,
      revision: 1,
      createdAt: current,
      updatedAt: current,
    };
    state.bindings.push(binding);
    await persist();
    return publicBinding(binding);
  }

  async function unbindDatabase(bindingId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(bindingId, 'databaseBindingId');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new DatabaseBindingRegistryError('invalid_database_binding_revision', 'A positive expectedRevision is required');
    }
    const index = state.bindings.findIndex((binding) => binding.id === normalizedId);
    if (index < 0) throw new DatabaseBindingRegistryError('database_binding_not_found', 'Database binding not found', 404);
    const binding = state.bindings[index];
    if (binding.revision !== expectedRevision) {
      throw new DatabaseBindingRegistryError('database_binding_revision_conflict', 'Database binding changed before removal', 409);
    }
    const expectedConfirmation = `unbind-database:${binding.id}:${binding.revision}`;
    if (confirmation !== expectedConfirmation) {
      throw new DatabaseBindingRegistryError('database_binding_confirmation_mismatch', 'Database unbind confirmation does not match', 409);
    }
    state.bindings.splice(index, 1);
    await persist();
    return Object.freeze({ id: binding.id, databaseName: binding.databaseName, unbound: true });
  }

  async function getBinding(bindingId) {
    await ensureInitialized();
    const binding = state.bindings.find((candidate) => candidate.id === bindingId);
    return binding ? publicBinding(binding) : null;
  }

  async function getByDatabase({ serverId, databaseName: requestedName } = {}) {
    await ensureInitialized();
    const normalizedServerId = uuid(serverId, 'serverId');
    const name = databaseName(requestedName);
    const binding = state.bindings.find((candidate) => candidate.serverId === normalizedServerId
      && candidate.databaseName.toLowerCase() === name.toLowerCase());
    return binding ? publicBinding(binding) : null;
  }

  async function listBindings({ serverId = null, websiteId = null, applicationId = null } = {}) {
    await ensureInitialized();
    const normalizedServerId = serverId === null ? null : uuid(serverId, 'serverId');
    const normalizedWebsiteId = websiteId === null ? null : uuid(websiteId, 'websiteId');
    const normalizedApplicationId = applicationId === null ? null : uuid(applicationId, 'applicationId');
    return state.bindings
      .filter((binding) => normalizedServerId === null || binding.serverId === normalizedServerId)
      .filter((binding) => normalizedWebsiteId === null || binding.websiteId === normalizedWebsiteId)
      .filter((binding) => normalizedApplicationId === null || binding.applicationId === normalizedApplicationId)
      .map(publicBinding);
  }

  return Object.freeze({ init, bindDatabase, unbindDatabase, getBinding, getByDatabase, listBindings });
}

export const databaseBindingRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  databaseName,
  normalizePersisted,
  appUserPattern: APP_USER_PATTERN,
});
