import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const HOST_PATTERN = /^(?:localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;
const MAX_USERNAME_BYTES = 512;
const MAX_SECRET_BYTES = 16 * 1024;

export class DockerRegistryCredentialRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerRegistryCredentialRegistryError';
    this.code = code;
    this.status = status;
  }
}

function projectId(value) {
  try { return assertUuid(value, 'dockerProjectId'); }
  catch { throw new DockerRegistryCredentialRegistryError('invalid_docker_project_id', 'dockerProjectId must be a UUID'); }
}

function normalizeMasterKey(value) {
  try { return normalizeEnvironmentMasterKey(value); }
  catch { throw new DockerRegistryCredentialRegistryError('invalid_secret_master_key', 'Docker registry encryption key is invalid', 500); }
}

function requireMasterKey(value) {
  if (!value) throw new DockerRegistryCredentialRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  return value;
}

function registryHost(value) {
  if (typeof value !== 'string') {
    throw new DockerRegistryCredentialRegistryError('docker_registry_host_invalid', 'Docker registry host is invalid');
  }
  const normalized = value.trim().toLowerCase();
  if (!HOST_PATTERN.test(normalized) || normalized.includes('..')) {
    throw new DockerRegistryCredentialRegistryError('docker_registry_host_invalid', 'Docker registry host must be a hostname with an optional port');
  }
  const portSeparator = normalized.lastIndexOf(':');
  if (portSeparator > -1) {
    const port = Number.parseInt(normalized.slice(portSeparator + 1), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new DockerRegistryCredentialRegistryError('docker_registry_host_invalid', 'Docker registry port is invalid');
    }
  }
  if (normalized === 'index.docker.io' || normalized === 'registry-1.docker.io') return 'docker.io';
  return normalized;
}

function credentialInput(username, secret) {
  if (typeof username !== 'string' || username.length < 1 || username.includes('\u0000')
    || Buffer.byteLength(username) > MAX_USERNAME_BYTES
    || typeof secret !== 'string' || secret.length < 1 || secret.includes('\u0000')
    || Buffer.byteLength(secret) > MAX_SECRET_BYTES) {
    throw new DockerRegistryCredentialRegistryError('docker_registry_credential_invalid', 'Docker registry credential is invalid');
  }
  return { username, secret };
}

function encryptCredential(masterKey, id, host, revision, value) {
  const key = requireMasterKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(`${id}:registry:${host}:${revision}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptCredential(masterKey, record) {
  const key = requireMasterKey(masterKey);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.encryptedCredential.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${record.projectId}:registry:${record.registryHost}:${record.revision}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.encryptedCredential.tag, 'base64'));
    const parsed = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(record.encryptedCredential.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8'));
    return credentialInput(parsed.username, parsed.secret);
  } catch (error) {
    if (error instanceof DockerRegistryCredentialRegistryError) throw error;
    throw new DockerRegistryCredentialRegistryError('docker_registry_credential_decrypt_failed', 'Docker registry credential could not be decrypted', 500);
  }
}

function encryptedShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !['ciphertext', 'iv', 'tag'].every((field) => typeof value[field] === 'string' && value[field].length > 0)
    || Buffer.from(value.iv, 'base64').length !== 12 || Buffer.from(value.tag, 'base64').length !== 16) {
    throw new DockerRegistryCredentialRegistryError('docker_registry_credential_state_invalid', 'Docker registry encrypted credential state is invalid', 409);
  }
  return { ...value };
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new DockerRegistryCredentialRegistryError('docker_registry_credential_state_invalid', 'Docker registry credential timestamp is invalid', 409);
  }
  return value;
}

function validatePersisted(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 6
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new DockerRegistryCredentialRegistryError('docker_registry_credential_state_invalid', 'Docker registry credential state is invalid', 409);
  }
  return {
    projectId: projectId(value.projectId),
    registryHost: registryHost(value.registryHost),
    revision: value.revision,
    encryptedCredential: encryptedShape(value.encryptedCredential),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

function publicCredential(record, id, host) {
  return Object.freeze({
    projectId: id,
    registryHost: host,
    revision: record?.revision ?? 0,
    configured: Boolean(record),
    usernameConfigured: Boolean(record),
    createdAt: record?.createdAt ?? null,
    updatedAt: record?.updatedAt ?? null,
  });
}

export function createDockerRegistryCredentialRegistry({
  filePath = null,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY,
  now = () => Date.now(),
  projectExists = async () => true,
} = {}) {
  if (typeof now !== 'function' || typeof projectExists !== 'function') {
    throw new DockerRegistryCredentialRegistryError('docker_registry_credential_dependencies_invalid', 'Docker registry credential dependencies are invalid', 503);
  }
  const encryptionKey = normalizeMasterKey(masterKey);
  let state = { version: STORE_VERSION, credentials: [] };
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
    catch { throw new DockerRegistryCredentialRegistryError('docker_compose_project_reference_unavailable', 'Docker Compose project reference could not be verified', 503); }
    if (!exists) throw new DockerRegistryCredentialRegistryError('docker_compose_project_not_found', 'Docker Compose project does not exist', persisted ? 409 : 404);
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.credentials)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((key) => !['version', 'credentials'].includes(key))) {
          throw new DockerRegistryCredentialRegistryError('docker_registry_credential_state_invalid', 'Docker registry credential store is invalid', 409);
        }
        const credentials = parsed.credentials.map(validatePersisted);
        const identities = new Set();
        for (const credential of credentials) {
          const identity = `${credential.projectId}:${credential.registryHost}`;
          if (identities.has(identity)) {
            throw new DockerRegistryCredentialRegistryError('docker_registry_credential_state_invalid', 'Docker registry credential identities must be unique', 409);
          }
          identities.add(identity);
          await requireProject(credential.projectId, true);
        }
        state = { version: STORE_VERSION, credentials };
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

  async function getCredential(requestedProjectId, requestedRegistryHost) {
    await ensureInitialized();
    const id = projectId(requestedProjectId);
    const host = registryHost(requestedRegistryHost);
    await requireProject(id);
    const record = state.credentials.find((item) => item.projectId === id && item.registryHost === host) ?? null;
    return publicCredential(record, id, host);
  }

  async function listCredentials({ projectId: requestedProjectId } = {}) {
    await ensureInitialized();
    const id = projectId(requestedProjectId);
    await requireProject(id);
    return state.credentials
      .filter((item) => item.projectId === id)
      .sort((a, b) => a.registryHost.localeCompare(b.registryHost))
      .map((item) => publicCredential(item, id, item.registryHost));
  }

  async function setCredential(requestedProjectId, {
    registryHost: requestedRegistryHost,
    expectedRevision,
    username,
    secret,
  } = {}) {
    await ensureInitialized();
    const id = projectId(requestedProjectId);
    const host = registryHost(requestedRegistryHost);
    await requireProject(id);
    const current = state.credentials.find((item) => item.projectId === id && item.registryHost === host) ?? null;
    const currentRevision = current?.revision ?? 0;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new DockerRegistryCredentialRegistryError('invalid_docker_registry_credential_revision', 'A non-negative expected credential revision is required');
    }
    if (currentRevision !== expectedRevision) {
      throw new DockerRegistryCredentialRegistryError('docker_registry_credential_revision_conflict', 'Docker registry credential changed before update', 409);
    }
    const normalized = credentialInput(username, secret);
    const revision = currentRevision + 1;
    const timestampValue = new Date(now()).toISOString();
    const record = {
      projectId: id,
      registryHost: host,
      revision,
      encryptedCredential: encryptCredential(encryptionKey, id, host, revision, normalized),
      createdAt: current?.createdAt ?? timestampValue,
      updatedAt: timestampValue,
    };
    if (current) Object.assign(current, record);
    else state.credentials.push(record);
    await persist();
    return publicCredential(record, id, host);
  }

  async function materializeCredential(requestedProjectId, requestedRegistryHost, { expectedRevision = null } = {}) {
    await ensureInitialized();
    const id = projectId(requestedProjectId);
    const host = registryHost(requestedRegistryHost);
    await requireProject(id);
    const record = state.credentials.find((item) => item.projectId === id && item.registryHost === host) ?? null;
    if (!record) throw new DockerRegistryCredentialRegistryError('docker_registry_credential_not_found', 'Docker registry credential was not found', 404);
    if (expectedRevision !== null && record.revision !== expectedRevision) {
      throw new DockerRegistryCredentialRegistryError('docker_registry_credential_revision_conflict', 'Docker registry credential revision is stale', 409);
    }
    return Object.freeze({ ...publicCredential(record, id, host), ...decryptCredential(encryptionKey, record) });
  }

  return Object.freeze({ init, getCredential, listCredentials, setCredential, materializeCredential });
}

export const dockerRegistryCredentialRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  registryHost,
  credentialInput,
  validatePersisted,
});
