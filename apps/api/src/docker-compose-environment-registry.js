import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VARIABLES = 256;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

export class DockerComposeEnvironmentRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerComposeEnvironmentRegistryError';
    this.code = code;
    this.status = status;
  }
}

function projectId(value) {
  try { return assertUuid(value, 'dockerProjectId'); }
  catch { throw new DockerComposeEnvironmentRegistryError('invalid_docker_project_id', 'dockerProjectId must be a UUID'); }
}

function normalizeMasterKey(value) {
  try { return normalizeEnvironmentMasterKey(value); }
  catch { throw new DockerComposeEnvironmentRegistryError('invalid_secret_master_key', 'Docker environment encryption key is invalid', 500); }
}

function requireMasterKey(value) {
  if (!value) throw new DockerComposeEnvironmentRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  return value;
}

function normalizeVariables(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_invalid', 'Docker Compose environment must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_VARIABLES) {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_too_large', 'Docker Compose environment has too many variables');
  }
  let totalBytes = 0;
  const normalized = [];
  for (const [key, rawValue] of entries) {
    const bytes = typeof rawValue === 'string' ? Buffer.byteLength(rawValue) : -1;
    if (!KEY_PATTERN.test(key) || typeof rawValue !== 'string' || rawValue.includes('\u0000') || bytes > MAX_VALUE_BYTES) {
      throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_invalid', 'Docker Compose environment contains an invalid variable');
    }
    totalBytes += Buffer.byteLength(key) + bytes;
    normalized.push([key, rawValue]);
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_too_large', 'Docker Compose environment exceeds the safe size limit');
  }
  normalized.sort(([left], [right]) => left.localeCompare(right));
  return normalized;
}

function encryptValue(masterKey, id, revision, key, value) {
  const secretKey = requireMasterKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, secretKey, iv);
  cipher.setAAD(Buffer.from(`${id}:env:${revision}:${key}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    key,
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptValue(masterKey, id, revision, record) {
  const secretKey = requireMasterKey(masterKey);
  try {
    const decipher = createDecipheriv(ALGORITHM, secretKey, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${id}:env:${revision}:${record.key}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_decrypt_failed', 'Docker Compose environment could not be decrypted', 500);
  }
}

function encryptedVariable(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4 || !KEY_PATTERN.test(value.key)
    || !['ciphertext', 'iv', 'tag'].every((field) => typeof value[field] === 'string' && value[field].length > 0)) {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_state_invalid', 'Docker Compose encrypted environment state is invalid', 409);
  }
  if (Buffer.from(value.iv, 'base64').length !== 12 || Buffer.from(value.tag, 'base64').length !== 16) {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_state_invalid', 'Docker Compose encrypted environment metadata is invalid', 409);
  }
  return { ...value };
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_state_invalid', 'Docker Compose environment timestamp is invalid', 409);
  }
  return value;
}

function validatePersisted(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Array.isArray(value.variables) || value.variables.length > MAX_VARIABLES) {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_state_invalid', 'Docker Compose environment state is invalid', 409);
  }
  const id = projectId(value.projectId);
  const variables = value.variables.map(encryptedVariable).sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(variables.map((item) => item.key)).size !== variables.length) {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_state_invalid', 'Docker Compose environment keys must be unique', 409);
  }
  return { projectId: id, revision: value.revision, variables, updatedAt: timestamp(value.updatedAt) };
}

function publicEnvironment(record, id) {
  return Object.freeze({
    projectId: id,
    revision: record?.revision ?? 0,
    keys: Object.freeze(record ? record.variables.map((item) => item.key) : []),
    variableCount: record?.variables.length ?? 0,
    configured: Boolean(record && record.variables.length > 0),
    updatedAt: record?.updatedAt ?? null,
  });
}

export function createDockerComposeEnvironmentRegistry({
  filePath = null,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY,
  now = () => Date.now(),
  projectExists = async () => true,
} = {}) {
  if (typeof now !== 'function' || typeof projectExists !== 'function') {
    throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_dependencies_invalid', 'Docker Compose environment registry dependencies are invalid', 503);
  }
  const encryptionKey = normalizeMasterKey(masterKey);
  let state = { version: STORE_VERSION, environments: [] };
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

  async function requireProject(id, persisted = false) {
    let exists;
    try { exists = await projectExists(id); }
    catch { throw new DockerComposeEnvironmentRegistryError('docker_compose_project_reference_unavailable', 'Docker Compose project reference could not be verified', 503); }
    if (!exists) throw new DockerComposeEnvironmentRegistryError('docker_compose_project_not_found', 'Docker Compose project does not exist', persisted ? 409 : 404);
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.environments)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((key) => !['version', 'environments'].includes(key))) {
          throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_state_invalid', 'Docker Compose environment store is invalid', 409);
        }
        const environments = parsed.environments.map(validatePersisted);
        if (new Set(environments.map((item) => item.projectId)).size !== environments.length) {
          throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_state_invalid', 'Docker Compose environment project identities must be unique', 409);
        }
        for (const environment of environments) await requireProject(environment.projectId, true);
        state = { version: STORE_VERSION, environments };
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

  async function getEnvironment(requestedProjectId) {
    await ensureInitialized();
    const id = projectId(requestedProjectId);
    await requireProject(id);
    return publicEnvironment(state.environments.find((item) => item.projectId === id) ?? null, id);
  }

  async function replaceEnvironment(requestedProjectId, { expectedRevision, variables } = {}) {
    await ensureInitialized();
    const id = projectId(requestedProjectId);
    await requireProject(id);
    const current = state.environments.find((item) => item.projectId === id) ?? null;
    const currentRevision = current?.revision ?? 0;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new DockerComposeEnvironmentRegistryError('invalid_docker_compose_environment_revision', 'A non-negative expected environment revision is required');
    }
    if (currentRevision !== expectedRevision) {
      throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_revision_conflict', 'Docker Compose environment changed before update', 409);
    }
    const normalized = normalizeVariables(variables);
    const revision = currentRevision + 1;
    const record = {
      projectId: id,
      revision,
      variables: normalized.map(([key, value]) => encryptValue(encryptionKey, id, revision, key, value)),
      updatedAt: new Date(now()).toISOString(),
    };
    if (current) Object.assign(current, record);
    else state.environments.push(record);
    await persist();
    return publicEnvironment(record, id);
  }

  async function materializeEnvironment(requestedProjectId, { expectedRevision = null } = {}) {
    await ensureInitialized();
    const id = projectId(requestedProjectId);
    await requireProject(id);
    const record = state.environments.find((item) => item.projectId === id) ?? null;
    const revision = record?.revision ?? 0;
    if (expectedRevision !== null && revision !== expectedRevision) {
      throw new DockerComposeEnvironmentRegistryError('docker_compose_environment_revision_conflict', 'Docker Compose environment revision is stale', 409);
    }
    if (!record) return Object.freeze({ projectId: id, revision: 0, variables: Object.freeze({}) });
    const variables = Object.fromEntries(record.variables.map((item) => [
      item.key,
      decryptValue(encryptionKey, id, record.revision, item),
    ]));
    return Object.freeze({ projectId: id, revision: record.revision, variables: Object.freeze(variables) });
  }

  return Object.freeze({ init, getEnvironment, replaceEnvironment, materializeEnvironment });
}

export const dockerComposeEnvironmentRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  maxVariables: MAX_VARIABLES,
  maxValueBytes: MAX_VALUE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  normalizeVariables,
  validatePersisted,
});
