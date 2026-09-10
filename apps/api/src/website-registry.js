import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const RUNTIME_TYPES = new Set(['static', 'node', 'proxy']);
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const STATIC_ROOT = '/var/www/yunpanel/apps';
const NODE_ROOT = '/var/lib/yunpanel/apps';
const MIGRATION_NAMESPACE = Buffer.from('8af0d7a45c4e4e6bb71a10ce8fba8261', 'hex');

export class WebsiteRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteRegistryError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return { version: STORE_VERSION, websites: [] };
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new WebsiteRegistryError(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, `${field} is invalid`); }
}

function name(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WebsiteRegistryError('invalid_website_name', 'Website name must be a printable string up to 120 characters');
  }
  return value.trim();
}

function appUnixUser(applicationId) {
  const id = uuid(applicationId, 'applicationId');
  return `yunapp-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
}

function migrationWebsiteId(domainId, applicationId) {
  const domain = uuid(domainId, 'domainId');
  uuid(applicationId, 'applicationId');
  const digest = createHash('sha1')
    .update(MIGRATION_NAMESPACE)
    .update(domain)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function applicationBinding(application, serverId) {
  if (!application || typeof application !== 'object' || Array.isArray(application)) {
    throw new WebsiteRegistryError('application_not_found', 'Application not found', 404);
  }
  const applicationId = uuid(application.id, 'applicationId');
  if (uuid(application.serverId, 'serverId') !== serverId) {
    throw new WebsiteRegistryError('website_application_server_mismatch', 'Application belongs to a different server', 409);
  }
  if (!['static', 'node'].includes(application.type)) {
    throw new WebsiteRegistryError('website_application_type_unsupported', 'Application type cannot be bound to a Website yet', 409);
  }
  let documentRoot;
  if (application.type === 'static') {
    const expected = path.posix.join(STATIC_ROOT, applicationId, 'current');
    if (application.webRoot !== expected) {
      throw new WebsiteRegistryError('website_application_root_drift', 'Static application document root does not match managed state', 409);
    }
    documentRoot = expected;
  } else {
    documentRoot = path.posix.join(NODE_ROOT, applicationId, 'current');
  }
  const unixUser = appUnixUser(applicationId);
  if (!APP_USER_PATTERN.test(unixUser)) throw new WebsiteRegistryError('website_application_user_invalid', 'Application Unix user identity is invalid', 409);
  return Object.freeze({ applicationId, runtimeType: application.type, documentRoot, unixUser });
}

function publicWebsite(website) {
  return Object.freeze({ ...website });
}

function validatePersistedWebsite(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid website registry entry');
  const allowed = new Set(['id', 'serverId', 'name', 'applicationId', 'runtimeType', 'documentRoot', 'unixUser', 'createdAt', 'updatedAt']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('invalid website registry entry');
  const id = uuid(value.id, 'websiteId');
  const serverId = uuid(value.serverId, 'serverId');
  const runtimeType = RUNTIME_TYPES.has(value.runtimeType) ? value.runtimeType : null;
  if (!runtimeType) throw new Error('invalid website registry entry');
  const createdAt = typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : null;
  const updatedAt = typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : null;
  if (!createdAt || !updatedAt) throw new Error('invalid website registry entry');

  let applicationId = null;
  let documentRoot = null;
  let unixUser = null;
  if (runtimeType === 'proxy') {
    if (value.applicationId !== null || value.documentRoot !== null || value.unixUser !== null) throw new Error('invalid website registry entry');
  } else {
    applicationId = uuid(value.applicationId, 'applicationId');
    const expectedRoot = runtimeType === 'static'
      ? path.posix.join(STATIC_ROOT, applicationId, 'current')
      : path.posix.join(NODE_ROOT, applicationId, 'current');
    if (value.documentRoot !== expectedRoot || value.unixUser !== appUnixUser(applicationId)) throw new Error('invalid website registry entry');
    documentRoot = expectedRoot;
    unixUser = value.unixUser;
  }
  return {
    id,
    serverId,
    name: name(value.name),
    applicationId,
    runtimeType,
    documentRoot,
    unixUser,
    createdAt,
    updatedAt,
  };
}

export function createWebsiteRegistry({
  filePath = null,
  now = () => Date.now(),
  serverExists = async () => true,
  getApplication = async () => null,
} = {}) {
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();

  if (typeof now !== 'function' || typeof serverExists !== 'function' || typeof getApplication !== 'function') {
    throw new WebsiteRegistryError('invalid_website_registry_dependencies', 'Website registry dependencies are invalid');
  }

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

  async function validatePersistedReferences(websites) {
    for (const website of websites) {
      let serverPresent;
      try { serverPresent = await serverExists(website.serverId); }
      catch { throw new WebsiteRegistryError('website_server_reference_unavailable', 'Website server reference could not be verified', 409); }
      if (!serverPresent) throw new WebsiteRegistryError('website_server_reference_missing', 'Persisted Website server does not exist', 409);
      if (!website.applicationId) continue;

      let application;
      try { application = await getApplication(website.applicationId); }
      catch { throw new WebsiteRegistryError('website_application_reference_unavailable', 'Website application reference could not be verified', 409); }
      if (!application) throw new WebsiteRegistryError('website_application_reference_missing', 'Persisted Website application does not exist', 409);
      const binding = applicationBinding(application, website.serverId);
      if (binding.applicationId !== website.applicationId
        || binding.runtimeType !== website.runtimeType
        || binding.documentRoot !== website.documentRoot
        || binding.unixUser !== website.unixUser) {
        throw new WebsiteRegistryError('website_application_binding_drift', 'Persisted Website application binding no longer matches managed state', 409);
      }
    }
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.websites)) throw new Error('unsupported or invalid website registry state');
        const websites = parsed.websites.map(validatePersistedWebsite);
        const ids = new Set();
        const applications = new Set();
        for (const website of websites) {
          if (ids.has(website.id)) throw new Error('duplicate website registry identity');
          ids.add(website.id);
          if (website.applicationId) {
            if (applications.has(website.applicationId)) throw new Error('application bound to multiple websites');
            applications.add(website.applicationId);
          }
        }
        await validatePersistedReferences(websites);
        state = { version: STORE_VERSION, websites };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function requireServer(serverId) {
    const id = uuid(serverId, 'serverId');
    if (!(await serverExists(id))) throw new WebsiteRegistryError('server_not_found', 'Target server does not exist', 404);
    return id;
  }

  async function createApplicationBackedWebsite({ websiteId, serverId, displayName, applicationId, runtimeType = null }) {
    const normalizedServerId = await requireServer(serverId);
    const normalizedApplicationId = uuid(applicationId, 'applicationId');
    const application = await getApplication(normalizedApplicationId);
    const binding = applicationBinding(application, normalizedServerId);
    if (runtimeType != null && runtimeType !== binding.runtimeType) {
      throw new WebsiteRegistryError('website_runtime_mismatch', 'Website runtime does not match the bound application', 409);
    }

    const normalizedWebsiteId = websiteId == null ? randomUUID() : uuid(websiteId, 'websiteId');
    const normalizedName = name(displayName);
    const existingById = state.websites.find((website) => website.id === normalizedWebsiteId) ?? null;
    if (existingById) {
      const exact = existingById.serverId === normalizedServerId
        && existingById.name === normalizedName
        && existingById.applicationId === binding.applicationId
        && existingById.runtimeType === binding.runtimeType
        && existingById.documentRoot === binding.documentRoot
        && existingById.unixUser === binding.unixUser;
      if (!exact) throw new WebsiteRegistryError('migration_website_identity_conflict', 'Migration Website identity conflicts with existing state', 409);
      return publicWebsite(existingById);
    }
    if (state.websites.some((website) => website.applicationId === normalizedApplicationId)) {
      throw new WebsiteRegistryError('application_already_bound', 'Application is already bound to a Website', 409);
    }

    const timestamp = new Date(now()).toISOString();
    const website = {
      id: normalizedWebsiteId,
      serverId: normalizedServerId,
      name: normalizedName,
      ...binding,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.websites.push(website);
    await persist();
    return publicWebsite(website);
  }

  async function createWebsite({ serverId, name: displayName, applicationId = null, runtimeType = null } = {}) {
    await ensureInitialized();
    if (applicationId == null) {
      const normalizedServerId = await requireServer(serverId);
      if (runtimeType !== 'proxy') throw new WebsiteRegistryError('website_application_required', 'Static and Node websites require an application binding');
      const timestamp = new Date(now()).toISOString();
      const website = {
        id: randomUUID(),
        serverId: normalizedServerId,
        name: name(displayName),
        applicationId: null,
        runtimeType: 'proxy',
        documentRoot: null,
        unixUser: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.websites.push(website);
      await persist();
      return publicWebsite(website);
    }
    return createApplicationBackedWebsite({ serverId, displayName, applicationId, runtimeType });
  }

  async function createMigrationWebsite({ domainId, serverId, name: displayName, applicationId } = {}) {
    await ensureInitialized();
    const normalizedApplicationId = uuid(applicationId, 'applicationId');
    const websiteId = migrationWebsiteId(domainId, normalizedApplicationId);
    return createApplicationBackedWebsite({
      websiteId,
      serverId,
      displayName,
      applicationId: normalizedApplicationId,
    });
  }

  async function deleteMigrationWebsite({ domainId, applicationId, websiteId, serverId, name: displayName } = {}) {
    await ensureInitialized();
    const normalizedApplicationId = uuid(applicationId, 'applicationId');
    const expectedWebsiteId = migrationWebsiteId(domainId, normalizedApplicationId);
    const normalizedWebsiteId = uuid(websiteId, 'websiteId');
    if (normalizedWebsiteId !== expectedWebsiteId) {
      throw new WebsiteRegistryError('migration_website_delete_identity_mismatch', 'Website is not the deterministic migration resource for this Domain and Application', 409);
    }
    const index = state.websites.findIndex((website) => website.id === normalizedWebsiteId);
    if (index < 0) return Object.freeze({ deleted: false, websiteId: normalizedWebsiteId });

    const website = state.websites[index];
    const normalizedServerId = uuid(serverId, 'serverId');
    const normalizedName = name(displayName);
    const application = await getApplication(normalizedApplicationId);
    const binding = applicationBinding(application, normalizedServerId);
    const exact = website.serverId === normalizedServerId
      && website.name === normalizedName
      && website.applicationId === normalizedApplicationId
      && website.runtimeType === binding.runtimeType
      && website.documentRoot === binding.documentRoot
      && website.unixUser === binding.unixUser;
    if (!exact) {
      throw new WebsiteRegistryError('migration_website_delete_state_mismatch', 'Migration Website state does not match rollback identity', 409);
    }
    state.websites.splice(index, 1);
    await persist();
    return Object.freeze({ deleted: true, websiteId: normalizedWebsiteId });
  }

  async function getWebsite(websiteId) {
    await ensureInitialized();
    const id = uuid(websiteId, 'websiteId');
    const website = state.websites.find((candidate) => candidate.id === id);
    return website ? publicWebsite(website) : null;
  }

  async function listWebsites({ serverId = null } = {}) {
    await ensureInitialized();
    const normalizedServerId = serverId == null ? null : uuid(serverId, 'serverId');
    return state.websites
      .filter((website) => normalizedServerId == null || website.serverId === normalizedServerId)
      .map(publicWebsite);
  }

  return Object.freeze({
    init,
    createWebsite,
    createMigrationWebsite,
    deleteMigrationWebsite,
    getWebsite,
    listWebsites,
  });
}

export const websiteRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  runtimeTypes: Object.freeze([...RUNTIME_TYPES]),
  appUnixUser,
  migrationWebsiteId,
  applicationBinding,
  validatePersistedWebsite,
});
