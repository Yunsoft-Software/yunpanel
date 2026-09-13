import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export class DockerComposeProjectRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerComposeProjectRegistryError';
    this.code = code;
    this.status = status;
  }
}

function normalizeUuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new DockerComposeProjectRegistryError(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, `${field} must be a UUID`); }
}

function normalizeProjectName(value) {
  if (typeof value !== 'string' || !PROJECT_NAME_PATTERN.test(value)) {
    throw new DockerComposeProjectRegistryError('docker_compose_project_name_invalid', 'Docker Compose project name is invalid');
  }
  return value;
}

function normalizeMasterKey(value) {
  try { return normalizeEnvironmentMasterKey(value); }
  catch {
    throw new DockerComposeProjectRegistryError('invalid_secret_master_key', 'Docker Compose project encryption key is invalid', 500);
  }
}

function requireMasterKey(value) {
  if (!value) throw new DockerComposeProjectRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  return value;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new DockerComposeProjectRegistryError('docker_compose_project_state_invalid', 'Docker Compose project timestamp is invalid', 409);
  }
  return value;
}

function normalizeNameArray(value, field, pattern = RESOURCE_NAME_PATTERN, maximum = 128) {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string' || !pattern.test(item))
    || new Set(value).size !== value.length) {
    throw new DockerComposeProjectRegistryError('docker_compose_validation_invalid', `Docker Compose ${field} summary is invalid`);
  }
  return [...value].sort();
}

function normalizeValidation(value, projectName, document) {
  const bytes = Buffer.byteLength(document);
  const sha256 = createHash('sha256').update(document).digest('hex');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.projectName !== projectName
    || value.composeSha256 !== sha256 || value.composeBytes !== bytes
    || value.validated !== true || value.sideEffects !== false
    || !Number.isSafeInteger(value.serviceCount) || value.serviceCount < 1 || value.serviceCount > 64
    || !Array.isArray(value.services) || value.services.length !== value.serviceCount
    || !Number.isSafeInteger(value.secretCount) || value.secretCount < 0 || value.secretCount > 128
    || !Number.isSafeInteger(value.configCount) || value.configCount < 0 || value.configCount > 128) {
    throw new DockerComposeProjectRegistryError('docker_compose_validation_invalid', 'Docker Compose validation evidence does not match the project document');
  }
  const serviceNames = [];
  for (const service of value.services) {
    if (!service || typeof service !== 'object' || Array.isArray(service)
      || Object.keys(service).length !== 3
      || typeof service.name !== 'string' || !SERVICE_NAME_PATTERN.test(service.name)
      || typeof service.imageConfigured !== 'boolean' || typeof service.buildConfigured !== 'boolean') {
      throw new DockerComposeProjectRegistryError('docker_compose_validation_invalid', 'Docker Compose service summary is invalid');
    }
    serviceNames.push(service.name);
  }
  if (new Set(serviceNames).size !== serviceNames.length) {
    throw new DockerComposeProjectRegistryError('docker_compose_validation_invalid', 'Docker Compose service identities must be unique');
  }
  return Object.freeze({
    composeSha256: sha256,
    composeBytes: bytes,
    services: Object.freeze(value.services.map((service) => Object.freeze({ ...service })).sort((a, b) => a.name.localeCompare(b.name))),
    networks: Object.freeze(normalizeNameArray(value.networks, 'network')),
    volumes: Object.freeze(normalizeNameArray(value.volumes, 'volume')),
    secretCount: value.secretCount,
    configCount: value.configCount,
  });
}

function encryptedShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !['ciphertext', 'iv', 'tag'].every((field) => typeof value[field] === 'string' && value[field].length > 0)) {
    throw new DockerComposeProjectRegistryError('docker_compose_project_state_invalid', 'Docker Compose encrypted document state is invalid', 409);
  }
  let iv;
  let tag;
  try {
    iv = Buffer.from(value.iv, 'base64');
    tag = Buffer.from(value.tag, 'base64');
    Buffer.from(value.ciphertext, 'base64');
  } catch {
    throw new DockerComposeProjectRegistryError('docker_compose_project_state_invalid', 'Docker Compose encrypted document state is invalid', 409);
  }
  if (iv.length !== 12 || tag.length !== 16) {
    throw new DockerComposeProjectRegistryError('docker_compose_project_state_invalid', 'Docker Compose encrypted document metadata is invalid', 409);
  }
  return { ...value };
}

function encryptDocument(masterKey, projectId, revision, document) {
  const key = requireMasterKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(`${projectId}:compose:${revision}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(document, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

function decryptDocument(masterKey, record) {
  const key = requireMasterKey(masterKey);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.encryptedDocument.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${record.id}:compose:${record.revision}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.encryptedDocument.tag, 'base64'));
    const document = Buffer.concat([
      decipher.update(Buffer.from(record.encryptedDocument.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    if (Buffer.byteLength(document) !== record.composeBytes
      || createHash('sha256').update(document).digest('hex') !== record.composeSha256) {
      throw new Error('digest mismatch');
    }
    return document;
  } catch {
    throw new DockerComposeProjectRegistryError('docker_compose_project_decrypt_failed', 'Docker Compose project document could not be decrypted', 500);
  }
}

function publicProject(record) {
  return Object.freeze({
    id: record.id,
    serverId: record.serverId,
    projectName: record.projectName,
    revision: record.revision,
    composeSha256: record.composeSha256,
    composeBytes: record.composeBytes,
    services: Object.freeze(record.services.map((service) => Object.freeze({ ...service }))),
    networks: Object.freeze([...record.networks]),
    volumes: Object.freeze([...record.volumes]),
    secretCount: record.secretCount,
    configCount: record.configCount,
    documentConfigured: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function validatePersisted(value) {
  const fields = new Set([
    'id', 'serverId', 'projectName', 'revision', 'composeSha256', 'composeBytes', 'services',
    'networks', 'volumes', 'secretCount', 'configCount', 'encryptedDocument', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((key) => !fields.has(key))
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.composeSha256 !== 'string' || !SHA256_PATTERN.test(value.composeSha256)
    || !Number.isSafeInteger(value.composeBytes) || value.composeBytes < 1 || value.composeBytes > 512 * 1024
    || !Number.isSafeInteger(value.secretCount) || value.secretCount < 0 || value.secretCount > 128
    || !Number.isSafeInteger(value.configCount) || value.configCount < 0 || value.configCount > 128) {
    throw new DockerComposeProjectRegistryError('docker_compose_project_state_invalid', 'Docker Compose project state is invalid', 409);
  }
  const services = normalizeNameArray(value.services?.map?.((service) => service?.name) ?? null, 'service', SERVICE_NAME_PATTERN, 64);
  if (services.length < 1 || !Array.isArray(value.services) || value.services.length !== services.length) {
    throw new DockerComposeProjectRegistryError('docker_compose_project_state_invalid', 'Docker Compose project service state is invalid', 409);
  }
  const normalizedServices = value.services.map((service) => {
    if (!service || typeof service !== 'object' || Array.isArray(service)
      || Object.keys(service).length !== 3 || !SERVICE_NAME_PATTERN.test(service.name)
      || typeof service.imageConfigured !== 'boolean' || typeof service.buildConfigured !== 'boolean') {
      throw new DockerComposeProjectRegistryError('docker_compose_project_state_invalid', 'Docker Compose project service state is invalid', 409);
    }
    return { ...service };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: normalizeUuid(value.id, 'dockerProjectId'),
    serverId: normalizeUuid(value.serverId, 'serverId'),
    projectName: normalizeProjectName(value.projectName),
    revision: value.revision,
    composeSha256: value.composeSha256,
    composeBytes: value.composeBytes,
    services: normalizedServices,
    networks: normalizeNameArray(value.networks, 'network'),
    volumes: normalizeNameArray(value.volumes, 'volume'),
    secretCount: value.secretCount,
    configCount: value.configCount,
    encryptedDocument: encryptedShape(value.encryptedDocument),
    createdAt: validTimestamp(value.createdAt),
    updatedAt: validTimestamp(value.updatedAt),
  };
}

export function createDockerComposeProjectRegistry({
  filePath = null,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY,
  now = () => Date.now(),
  serverExists = async () => true,
} = {}) {
  if (typeof now !== 'function' || typeof serverExists !== 'function') {
    throw new DockerComposeProjectRegistryError('docker_compose_project_dependencies_invalid', 'Docker Compose project registry dependencies are invalid', 503);
  }
  const encryptionKey = normalizeMasterKey(masterKey);
  let state = { version: STORE_VERSION, projects: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
    });
    return writeChain;
  }

  async function requireServer(serverId, persisted = false) {
    const id = normalizeUuid(serverId, 'serverId');
    let exists;
    try { exists = await serverExists(id); }
    catch { throw new DockerComposeProjectRegistryError('docker_server_reference_unavailable', 'Docker project server reference could not be verified', 503); }
    if (!exists) throw new DockerComposeProjectRegistryError('docker_server_not_found', 'Docker project server does not exist', persisted ? 409 : 404);
    return id;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.projects)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((key) => !['version', 'projects'].includes(key))) {
          throw new DockerComposeProjectRegistryError('docker_compose_project_state_invalid', 'Docker Compose project store is invalid', 409);
        }
        const projects = parsed.projects.map(validatePersisted);
        const ids = new Set();
        const names = new Set();
        for (const project of projects) {
          const scopedName = `${project.serverId}:${project.projectName}`;
          if (ids.has(project.id) || names.has(scopedName)) {
            throw new DockerComposeProjectRegistryError('docker_compose_project_state_invalid', 'Docker Compose project identities must be unique', 409);
          }
          ids.add(project.id);
          names.add(scopedName);
          await requireServer(project.serverId, true);
        }
        state = { version: STORE_VERSION, projects };
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

  async function createProject({ projectId = null, serverId, projectName, document, validation } = {}) {
    await ensureInitialized();
    const id = projectId === null ? randomUUID() : normalizeUuid(projectId, 'dockerProjectId');
    const normalizedServerId = await requireServer(serverId);
    const name = normalizeProjectName(projectName);
    if (typeof document !== 'string' || document.length < 1) {
      throw new DockerComposeProjectRegistryError('docker_compose_document_invalid', 'Docker Compose project document is required');
    }
    const summary = normalizeValidation(validation, name, document);
    const existing = state.projects.find((project) => project.id === id) ?? null;
    if (existing) {
      if (projectId === null || existing.serverId !== normalizedServerId || existing.projectName !== name
        || existing.revision !== 1 || existing.composeSha256 !== summary.composeSha256) {
        throw new DockerComposeProjectRegistryError('docker_compose_project_identity_conflict', 'Docker Compose project identity conflicts with existing state', 409);
      }
      return publicProject(existing);
    }
    if (state.projects.some((project) => project.serverId === normalizedServerId && project.projectName === name)) {
      throw new DockerComposeProjectRegistryError('docker_compose_project_name_conflict', 'Docker Compose project name is already used on this server', 409);
    }
    const timestamp = new Date(now()).toISOString();
    const revision = 1;
    const record = {
      id,
      serverId: normalizedServerId,
      projectName: name,
      revision,
      ...summary,
      encryptedDocument: encryptDocument(encryptionKey, id, revision, document),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.projects.push(record);
    await persist();
    return publicProject(record);
  }

  async function updateProject(projectId, { expectedRevision, document, validation } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(projectId, 'dockerProjectId');
    const project = state.projects.find((candidate) => candidate.id === id);
    if (!project) throw new DockerComposeProjectRegistryError('docker_compose_project_not_found', 'Docker Compose project was not found', 404);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new DockerComposeProjectRegistryError('invalid_docker_compose_project_revision', 'A positive expected project revision is required');
    }
    if (project.revision !== expectedRevision) {
      throw new DockerComposeProjectRegistryError('docker_compose_project_revision_conflict', 'Docker Compose project changed before update', 409);
    }
    if (typeof document !== 'string' || document.length < 1) {
      throw new DockerComposeProjectRegistryError('docker_compose_document_invalid', 'Docker Compose project document is required');
    }
    const summary = normalizeValidation(validation, project.projectName, document);
    const revision = project.revision + 1;
    Object.assign(project, summary, {
      revision,
      encryptedDocument: encryptDocument(encryptionKey, id, revision, document),
      updatedAt: new Date(now()).toISOString(),
    });
    await persist();
    return publicProject(project);
  }

  async function getProject(projectId) {
    await ensureInitialized();
    const id = normalizeUuid(projectId, 'dockerProjectId');
    const project = state.projects.find((candidate) => candidate.id === id);
    return project ? publicProject(project) : null;
  }

  async function listProjects({ serverId = null } = {}) {
    await ensureInitialized();
    const normalizedServerId = serverId === null ? null : normalizeUuid(serverId, 'serverId');
    return state.projects
      .filter((project) => normalizedServerId === null || project.serverId === normalizedServerId)
      .map(publicProject);
  }

  async function materializeProject(projectId, { expectedRevision = null } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(projectId, 'dockerProjectId');
    const project = state.projects.find((candidate) => candidate.id === id);
    if (!project) throw new DockerComposeProjectRegistryError('docker_compose_project_not_found', 'Docker Compose project was not found', 404);
    if (expectedRevision !== null && project.revision !== expectedRevision) {
      throw new DockerComposeProjectRegistryError('docker_compose_project_revision_conflict', 'Docker Compose project revision is stale', 409);
    }
    return Object.freeze({ ...publicProject(project), document: decryptDocument(encryptionKey, project) });
  }

  return Object.freeze({ init, createProject, updateProject, getProject, listProjects, materializeProject });
}

export const dockerComposeProjectRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  normalizeProjectName,
  normalizeValidation,
  validatePersisted,
  encryptDocument,
  decryptDocument,
});
