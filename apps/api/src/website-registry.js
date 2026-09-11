import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid, normalizeProxyHost } from '@yunpanel/shared';

const STORE_VERSION = 3;
const RUNTIME_TYPES = new Set(['static', 'node', 'docker', 'proxy']);
const UPDATE_FIELDS = new Set(['name', 'applicationId', 'dockerWorkloadId', 'runtimeType', 'proxyTarget']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
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

function proxyHost(value) {
  try {
    return normalizeProxyHost(value);
  } catch {
    throw new WebsiteRegistryError('invalid_website_proxy_host', 'Proxy host must be an IP address or DNS hostname without a URL scheme or path');
  }
}

function proxyTarget(value, { persisted = false } = {}) {
  if (value === null) return null;
  const allowed = new Set(['host', 'port', 'websocket']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))
    || (persisted && Object.keys(value).length !== allowed.size)) {
    throw new WebsiteRegistryError('invalid_website_proxy_target', 'Proxy target must contain only host, port and websocket');
  }
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) {
    throw new WebsiteRegistryError('invalid_website_proxy_port', 'Proxy port must be between 1024 and 65535');
  }
  if (value.websocket !== undefined && typeof value.websocket !== 'boolean') {
    throw new WebsiteRegistryError('invalid_website_proxy_websocket', 'Proxy websocket must be a boolean');
  }
  return Object.freeze({ host: proxyHost(value.host), port: value.port, websocket: value.websocket !== false });
}

function websiteUpdateFingerprint(plan) {
  return createHash('sha256').update(JSON.stringify({
    version: plan.version,
    websiteId: plan.websiteId,
    currentRevision: plan.currentRevision,
    nextWebsite: plan.nextWebsite,
  })).digest('hex');
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

function dockerBinding(workload, serverId) {
  if (!workload || typeof workload !== 'object' || Array.isArray(workload)) {
    throw new WebsiteRegistryError('docker_workload_not_found', 'Docker workload not found', 404);
  }
  const dockerWorkloadId = uuid(workload.id, 'dockerWorkloadId');
  if (uuid(workload.serverId, 'serverId') !== serverId) {
    throw new WebsiteRegistryError('website_docker_server_mismatch', 'Docker workload belongs to a different server', 409);
  }
  if (workload.managementMode !== 'external') {
    throw new WebsiteRegistryError('website_docker_mode_unsupported', 'Docker workload management mode is not supported yet', 409);
  }
  return Object.freeze({
    dockerWorkloadId,
    runtimeType: 'docker',
    proxyTarget: proxyTarget(workload.proxyTarget, { persisted: true }),
  });
}

function publicWebsite(website) {
  return Object.freeze({ ...website, proxyTarget: website.proxyTarget ? Object.freeze({ ...website.proxyTarget }) : null });
}

function validatePersistedWebsite(value, sourceVersion = STORE_VERSION) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid website registry entry');
  const allowed = new Set(['id', 'serverId', 'name', 'applicationId', 'runtimeType', 'documentRoot', 'unixUser', 'createdAt', 'updatedAt']);
  if (sourceVersion >= 2) {
    allowed.add('revision');
    allowed.add('proxyTarget');
  }
  if (sourceVersion >= 3) allowed.add('dockerWorkloadId');
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('invalid website registry entry');
  const id = uuid(value.id, 'websiteId');
  const serverId = uuid(value.serverId, 'serverId');
  const runtimeType = RUNTIME_TYPES.has(value.runtimeType) ? value.runtimeType : null;
  if (!runtimeType) throw new Error('invalid website registry entry');
  const createdAt = typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : null;
  const updatedAt = typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : null;
  if (!createdAt || !updatedAt) throw new Error('invalid website registry entry');
  const revision = sourceVersion === 1 ? 1 : value.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid website registry entry');

  let applicationId = null;
  let dockerWorkloadId = null;
  let documentRoot = null;
  let unixUser = null;
  let normalizedProxyTarget = null;
  if (runtimeType === 'proxy') {
    if (value.applicationId !== null || value.documentRoot !== null || value.unixUser !== null) throw new Error('invalid website registry entry');
    if (sourceVersion >= 3 && value.dockerWorkloadId !== null) throw new Error('invalid website registry entry');
    normalizedProxyTarget = sourceVersion === 1 ? null : proxyTarget(value.proxyTarget, { persisted: true });
  } else if (runtimeType === 'docker') {
    if (sourceVersion < 3 || value.applicationId !== null || value.documentRoot !== null || value.unixUser !== null) {
      throw new Error('invalid website registry entry');
    }
    dockerWorkloadId = uuid(value.dockerWorkloadId, 'dockerWorkloadId');
    normalizedProxyTarget = proxyTarget(value.proxyTarget, { persisted: true });
  } else {
    if (sourceVersion >= 2 && value.proxyTarget !== null) throw new Error('invalid website registry entry');
    if (sourceVersion >= 3 && value.dockerWorkloadId !== null) throw new Error('invalid website registry entry');
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
    dockerWorkloadId,
    runtimeType,
    documentRoot,
    unixUser,
    proxyTarget: normalizedProxyTarget,
    revision,
    createdAt,
    updatedAt,
  };
}

export function createWebsiteRegistry({
  filePath = null,
  now = () => Date.now(),
  serverExists = async () => true,
  getApplication = async () => null,
  getDockerWorkload = async () => null,
} = {}) {
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();

  if (typeof now !== 'function' || typeof serverExists !== 'function' || typeof getApplication !== 'function'
    || typeof getDockerWorkload !== 'function') {
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
    for (const website of websites) {
      if (!website.dockerWorkloadId) continue;
      let workload;
      try { workload = await getDockerWorkload(website.dockerWorkloadId); }
      catch { throw new WebsiteRegistryError('website_docker_reference_unavailable', 'Website Docker workload reference could not be verified', 409); }
      if (!workload) throw new WebsiteRegistryError('website_docker_reference_missing', 'Persisted Website Docker workload does not exist', 409);
      const binding = dockerBinding(workload, website.serverId);
      if (binding.dockerWorkloadId !== website.dockerWorkloadId
        || binding.runtimeType !== website.runtimeType
        || JSON.stringify(binding.proxyTarget) !== JSON.stringify(website.proxyTarget)) {
        throw new WebsiteRegistryError('website_docker_binding_drift', 'Persisted Website Docker binding no longer matches managed state', 409);
      }
    }
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (![1, 2, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.websites)) throw new Error('unsupported or invalid website registry state');
        const sourceVersion = parsed.version;
        const websites = parsed.websites.map((website) => validatePersistedWebsite(website, sourceVersion));
        const ids = new Set();
        const applications = new Set();
        const dockerWorkloads = new Set();
        for (const website of websites) {
          if (ids.has(website.id)) throw new Error('duplicate website registry identity');
          ids.add(website.id);
          if (website.applicationId) {
            if (applications.has(website.applicationId)) throw new Error('application bound to multiple websites');
            applications.add(website.applicationId);
          }
          if (website.dockerWorkloadId) {
            if (dockerWorkloads.has(website.dockerWorkloadId)) throw new Error('Docker workload bound to multiple websites');
            dockerWorkloads.add(website.dockerWorkloadId);
          }
        }
        await validatePersistedReferences(websites);
        state = { version: STORE_VERSION, websites };
        if (sourceVersion !== STORE_VERSION) await persist();
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

  async function createApplicationBackedWebsite({
    websiteId,
    serverId,
    displayName,
    applicationId,
    runtimeType = null,
    identityConflictCode = 'website_identity_conflict',
  }) {
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
        && existingById.dockerWorkloadId === null
        && existingById.runtimeType === binding.runtimeType
        && existingById.documentRoot === binding.documentRoot
        && existingById.unixUser === binding.unixUser
        && existingById.proxyTarget === null
        && existingById.revision === 1;
      if (!exact) throw new WebsiteRegistryError(identityConflictCode, 'Website identity conflicts with existing state', 409);
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
      dockerWorkloadId: null,
      proxyTarget: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.websites.push(website);
    await persist();
    return publicWebsite(website);
  }

  async function createWebsite({
    websiteId = null,
    serverId,
    name: displayName,
    applicationId = null,
    dockerWorkloadId = null,
    runtimeType = null,
    proxyTarget: requestedProxyTarget = null,
  } = {}) {
    await ensureInitialized();
    if (applicationId !== null && dockerWorkloadId !== null) {
      throw new WebsiteRegistryError('website_binding_conflict', 'Website cannot bind both an Application and a Docker workload');
    }
    if (dockerWorkloadId !== null) {
      if (applicationId !== null || runtimeType !== 'docker') {
        throw new WebsiteRegistryError('website_docker_binding_invalid', 'Docker Website requires runtimeType docker and no Application');
      }
      if (requestedProxyTarget !== null) {
        throw new WebsiteRegistryError('website_proxy_target_not_applicable', 'Docker Website proxy target is derived from its workload');
      }
      const normalizedServerId = await requireServer(serverId);
      const normalizedDockerWorkloadId = uuid(dockerWorkloadId, 'dockerWorkloadId');
      const workload = await getDockerWorkload(normalizedDockerWorkloadId);
      const binding = dockerBinding(workload, normalizedServerId);
      const normalizedWebsiteId = websiteId == null ? randomUUID() : uuid(websiteId, 'websiteId');
      const normalizedName = name(displayName);
      const existing = state.websites.find((candidate) => candidate.id === normalizedWebsiteId) ?? null;
      if (existing) {
        const exact = websiteId !== null && existing.serverId === normalizedServerId
          && existing.name === normalizedName && existing.applicationId === null
          && existing.dockerWorkloadId === binding.dockerWorkloadId && existing.runtimeType === 'docker'
          && existing.documentRoot === null && existing.unixUser === null
          && JSON.stringify(existing.proxyTarget) === JSON.stringify(binding.proxyTarget) && existing.revision === 1;
        if (!exact) throw new WebsiteRegistryError('website_identity_conflict', 'Website identity conflicts with existing state', 409);
        return publicWebsite(existing);
      }
      if (state.websites.some((website) => website.dockerWorkloadId === normalizedDockerWorkloadId)) {
        throw new WebsiteRegistryError('docker_workload_already_bound', 'Docker workload is already bound to a Website', 409);
      }
      const timestamp = new Date(now()).toISOString();
      const website = {
        id: normalizedWebsiteId,
        serverId: normalizedServerId,
        name: normalizedName,
        applicationId: null,
        dockerWorkloadId: binding.dockerWorkloadId,
        runtimeType: 'docker',
        documentRoot: null,
        unixUser: null,
        proxyTarget: binding.proxyTarget,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.websites.push(website);
      await persist();
      return publicWebsite(website);
    }
    if (applicationId == null) {
      const normalizedServerId = await requireServer(serverId);
      if (runtimeType !== 'proxy') throw new WebsiteRegistryError('website_application_required', 'Static and Node Websites require an Application; Docker Websites require a workload');
      const timestamp = new Date(now()).toISOString();
      const normalizedWebsiteId = websiteId == null ? randomUUID() : uuid(websiteId, 'websiteId');
      const website = {
        id: normalizedWebsiteId,
        serverId: normalizedServerId,
        name: name(displayName),
        applicationId: null,
        dockerWorkloadId: null,
        runtimeType: 'proxy',
        documentRoot: null,
        unixUser: null,
        proxyTarget: proxyTarget(requestedProxyTarget),
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const existing = state.websites.find((candidate) => candidate.id === normalizedWebsiteId) ?? null;
      if (existing) {
        const exact = websiteId !== null
          && existing.serverId === website.serverId
          && existing.name === website.name
          && existing.applicationId === null
          && existing.dockerWorkloadId === null
          && existing.runtimeType === 'proxy'
          && existing.documentRoot === null
          && existing.unixUser === null
          && JSON.stringify(existing.proxyTarget) === JSON.stringify(website.proxyTarget)
          && existing.revision === 1;
        if (!exact) throw new WebsiteRegistryError('website_identity_conflict', 'Website identity conflicts with existing state', 409);
        return publicWebsite(existing);
      }
      state.websites.push(website);
      await persist();
      return publicWebsite(website);
    }
    if (requestedProxyTarget !== null) {
      throw new WebsiteRegistryError('website_proxy_target_not_applicable', 'Application-backed Websites cannot define a proxy target');
    }
    return createApplicationBackedWebsite({ websiteId, serverId, displayName, applicationId, runtimeType });
  }

  function requireWebsite(websiteId) {
    const id = uuid(websiteId, 'websiteId');
    const website = state.websites.find((candidate) => candidate.id === id);
    if (!website) throw new WebsiteRegistryError('website_not_found', 'Website not found', 404);
    return website;
  }

  function assertUpdateChanges(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)
      || Object.keys(changes).length === 0 || Object.keys(changes).some((key) => !UPDATE_FIELDS.has(key))) {
      throw new WebsiteRegistryError('invalid_website_update', 'Website changes must contain only name, applicationId, dockerWorkloadId, runtimeType or proxyTarget');
    }
    return changes;
  }

  async function previewWebsiteUpdate(websiteId, requestedChanges) {
    await ensureInitialized();
    const website = requireWebsite(websiteId);
    const changes = assertUpdateChanges(requestedChanges);
    const hasApplicationId = Object.hasOwn(changes, 'applicationId');
    const hasDockerWorkloadId = Object.hasOwn(changes, 'dockerWorkloadId');
    const hasRuntimeType = Object.hasOwn(changes, 'runtimeType');
    const bindingRequested = hasApplicationId || hasDockerWorkloadId || hasRuntimeType;
    const next = {
      name: Object.hasOwn(changes, 'name') ? name(changes.name) : website.name,
      applicationId: website.applicationId,
      dockerWorkloadId: website.dockerWorkloadId,
      runtimeType: website.runtimeType,
      documentRoot: website.documentRoot,
      unixUser: website.unixUser,
      proxyTarget: website.proxyTarget ? { ...website.proxyTarget } : null,
    };

    if (hasApplicationId) next.applicationId = changes.applicationId == null ? null : uuid(changes.applicationId, 'applicationId');
    if (hasDockerWorkloadId) next.dockerWorkloadId = changes.dockerWorkloadId == null
      ? null
      : uuid(changes.dockerWorkloadId, 'dockerWorkloadId');
    if (hasRuntimeType) {
      if (!RUNTIME_TYPES.has(changes.runtimeType)) throw new WebsiteRegistryError('invalid_website_runtime', 'Website runtimeType must be static, node, docker or proxy');
      next.runtimeType = changes.runtimeType;
    } else if (hasApplicationId) {
      next.runtimeType = next.applicationId === null ? 'proxy' : next.runtimeType;
    } else if (hasDockerWorkloadId) {
      next.runtimeType = next.dockerWorkloadId === null ? 'proxy' : 'docker';
    }

    if (bindingRequested) {
      if (next.runtimeType === 'proxy') {
        if (next.applicationId !== null) {
          throw new WebsiteRegistryError('website_proxy_application_conflict', 'Switching to proxy requires applicationId to be explicitly null');
        }
        if (next.dockerWorkloadId !== null) {
          throw new WebsiteRegistryError('website_proxy_docker_conflict', 'Switching to proxy requires dockerWorkloadId to be explicitly null');
        }
        next.documentRoot = null;
        next.unixUser = null;
        if (website.runtimeType !== 'proxy') next.proxyTarget = null;
      } else if (next.runtimeType === 'docker') {
        if (next.applicationId !== null) {
          throw new WebsiteRegistryError('website_docker_application_conflict', 'Switching to Docker requires applicationId to be explicitly null');
        }
        if (next.dockerWorkloadId === null) {
          throw new WebsiteRegistryError('website_docker_workload_required', 'Docker Website requires a workload binding');
        }
        const workload = await getDockerWorkload(next.dockerWorkloadId);
        const binding = dockerBinding(workload, website.serverId);
        const conflict = state.websites.find((candidate) => candidate.id !== website.id
          && candidate.dockerWorkloadId === binding.dockerWorkloadId);
        if (conflict) throw new WebsiteRegistryError('docker_workload_already_bound', 'Docker workload is already bound to a Website', 409);
        Object.assign(next, binding, { applicationId: null, documentRoot: null, unixUser: null });
      } else {
        if (next.dockerWorkloadId !== null) {
          throw new WebsiteRegistryError('website_application_docker_conflict', 'Switching to an Application requires dockerWorkloadId to be explicitly null');
        }
        if (next.applicationId === null) throw new WebsiteRegistryError('website_application_required', 'Static and Node websites require an application binding');
        const application = await getApplication(next.applicationId);
        const binding = applicationBinding(application, website.serverId);
        if (binding.runtimeType !== next.runtimeType) {
          throw new WebsiteRegistryError('website_runtime_mismatch', 'Website runtime does not match the bound application', 409);
        }
        const conflict = state.websites.find((candidate) => candidate.id !== website.id && candidate.applicationId === binding.applicationId);
        if (conflict) throw new WebsiteRegistryError('application_already_bound', 'Application is already bound to a Website', 409);
        Object.assign(next, binding, { dockerWorkloadId: null, proxyTarget: null });
      }
    }

    if (Object.hasOwn(changes, 'proxyTarget')) {
      if (next.runtimeType !== 'proxy') {
        throw new WebsiteRegistryError('website_proxy_target_not_applicable', 'Proxy target can be changed only for unbound proxy Websites');
      }
      next.proxyTarget = proxyTarget(changes.proxyTarget);
    }

    const nameChanged = next.name !== website.name;
    const bindingChanged = next.applicationId !== website.applicationId
      || next.dockerWorkloadId !== website.dockerWorkloadId
      || next.runtimeType !== website.runtimeType
      || next.documentRoot !== website.documentRoot
      || next.unixUser !== website.unixUser;
    const proxyTargetChanged = JSON.stringify(next.proxyTarget) !== JSON.stringify(website.proxyTarget);
    if (!nameChanged && !bindingChanged && !proxyTargetChanged) {
      throw new WebsiteRegistryError('website_update_no_changes', 'Website update does not change current state', 409);
    }

    const plan = {
      version: 1,
      websiteId: website.id,
      currentRevision: website.revision,
      nextWebsite: Object.freeze(next),
      impact: Object.freeze({ nameChanged, bindingChanged, proxyTargetChanged }),
    };
    return Object.freeze({ ...plan, fingerprint: websiteUpdateFingerprint(plan) });
  }

  async function updateWebsite({ websiteId, expectedRevision, changes, previewFingerprint } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new WebsiteRegistryError('invalid_website_revision', 'A positive Website revision is required');
    }
    if (typeof previewFingerprint !== 'string' || !SHA256_PATTERN.test(previewFingerprint)) {
      throw new WebsiteRegistryError('invalid_website_update_fingerprint', 'A current Website update fingerprint is required');
    }
    const plan = await previewWebsiteUpdate(websiteId, changes);
    if (plan.currentRevision !== expectedRevision) {
      throw new WebsiteRegistryError('website_revision_conflict', 'Website changed after preview; request a new preview', 409);
    }
    if (plan.fingerprint !== previewFingerprint) {
      throw new WebsiteRegistryError('website_update_preview_stale', 'Website update preview is stale', 409);
    }
    const current = requireWebsite(plan.websiteId);
    if (current.revision !== expectedRevision) {
      throw new WebsiteRegistryError('website_revision_conflict', 'Website changed after preview; request a new preview', 409);
    }
    const timestamp = new Date(now()).toISOString();
    Object.assign(current, plan.nextWebsite, { revision: expectedRevision + 1, updatedAt: timestamp });
    await persist();
    return publicWebsite(current);
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
      identityConflictCode: 'migration_website_identity_conflict',
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
      && website.dockerWorkloadId === null
      && website.runtimeType === binding.runtimeType
      && website.documentRoot === binding.documentRoot
      && website.unixUser === binding.unixUser
      && website.proxyTarget === null
      && website.revision === 1;
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
    previewWebsiteUpdate,
    updateWebsite,
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
  dockerBinding,
  proxyHost,
  proxyTarget,
  websiteUpdateFingerprint,
  validatePersistedWebsite,
});
