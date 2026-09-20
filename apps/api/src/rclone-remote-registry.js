import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { createRcloneManager, RcloneError } from '@yunpanel/host-runtime';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const DEFAULT_STORE_PATH = '/var/lib/yunpanel/control-plane/rclone-remotes.json';
const REMOTE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SUPPORTED_REMOTE_TYPES = new Set(['s3', 'b2', 'sftp', 'webdav']);
const REMOTE_STATUSES = new Set(['untested', 'verified', 'error']);

export class RcloneRemoteRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RcloneRemoteRegistryError';
    this.code = code;
    this.status = status;
  }
}

function normalizeUuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new RcloneRemoteRegistryError(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, `${field} must be a UUID`); }
}

function normalizeRemoteName(name) {
  if (typeof name !== 'string' || !REMOTE_NAME_PATTERN.test(name)) {
    throw new RcloneRemoteRegistryError('rclone_remote_name_invalid', 'Remote name must be 1-64 alphanumeric characters, underscores, or hyphens');
  }
  return name;
}

function normalizeRemoteType(type) {
  if (typeof type !== 'string' || !SUPPORTED_REMOTE_TYPES.has(type.toLowerCase())) {
    throw new RcloneRemoteRegistryError('rclone_remote_type_unsupported', `Remote type must be one of: ${[...SUPPORTED_REMOTE_TYPES].join(', ')}`);
  }
  return type.toLowerCase();
}

function normalizeMasterKey(value) {
  try { return normalizeEnvironmentMasterKey(value); }
  catch {
    throw new RcloneRemoteRegistryError('invalid_secret_master_key', 'Rclone encryption key is invalid', 500);
  }
}

function requireMasterKey(value) {
  if (!value) throw new RcloneRemoteRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  return value;
}

function encryptCredentials(masterKey, remoteId, credentials) {
  const key = requireMasterKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(`${remoteId}:rclone-credentials`, 'utf8'));
  const serialized = JSON.stringify(credentials);
  const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

function decryptCredentials(masterKey, record) {
  const key = requireMasterKey(masterKey);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.encryptedCredentials.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${record.id}:rclone-credentials`, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.encryptedCredentials.tag, 'base64'));
    const serialized = Buffer.concat([
      decipher.update(Buffer.from(record.encryptedCredentials.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(serialized);
  } catch {
    throw new RcloneRemoteRegistryError('rclone_credentials_decrypt_failed', 'Remote credentials could not be decrypted', 500);
  }
}

function publicRemote(record) {
  return Object.freeze({
    id: record.id,
    serverId: record.serverId,
    name: record.name,
    type: record.type,
    parameters: Object.freeze({ ...(record.parameters ?? {}) }),
    status: record.status,
    lastTestedAt: record.lastTestedAt ?? null,
    error: record.error ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function createRcloneRemoteRegistry({
  filePath = DEFAULT_STORE_PATH,
  masterKey = null,
  serverExists = async () => true,
  rcloneManager = null,
  now = () => Date.now(),
} = {}) {
  const encryptionKey = masterKey ? normalizeMasterKey(masterKey) : null;
  const manager = rcloneManager ?? createRcloneManager({ now });
  let state = { version: STORE_VERSION, remotes: [] };
  let initialized = false;
  let writeQueue = Promise.resolve();

  async function persist() {
    writeQueue = writeQueue.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      const payload = JSON.stringify(state, null, 2);
      await writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeQueue;
  }

  async function init() {
    if (!initialized) {
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.remotes)) {
          throw new RcloneRemoteRegistryError('rclone_remote_state_invalid', 'Rclone remote store is invalid', 409);
        }
        state = parsed;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist();
      }
      initialized = true;
    }
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function createRemote({
    remoteId = null,
    serverId,
    name,
    type,
    parameters = {},
    credentials = {},
  } = {}) {
    await ensureInitialized();
    const id = remoteId === null ? randomUUID() : normalizeUuid(remoteId, 'remoteId');
    const normalizedServerId = normalizeUuid(serverId, 'serverId');
    if (!(await serverExists(normalizedServerId))) {
      throw new RcloneRemoteRegistryError('server_not_found', 'Target server does not exist', 404);
    }
    const remoteName = normalizeRemoteName(name);
    const remoteType = normalizeRemoteType(type);

    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new RcloneRemoteRegistryError('rclone_parameters_invalid', 'Parameters must be an object');
    }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new RcloneRemoteRegistryError('rclone_credentials_invalid', 'Credentials must be an object');
    }

    const existing = state.remotes.find((r) => r.id === id) ?? null;
    if (existing) {
      if (existing.serverId !== normalizedServerId || existing.name !== remoteName || existing.type !== remoteType) {
        throw new RcloneRemoteRegistryError('rclone_remote_identity_conflict', 'Remote identity conflicts with existing state', 409);
      }
      return publicRemote(existing);
    }

    if (state.remotes.some((r) => r.serverId === normalizedServerId && r.name === remoteName)) {
      throw new RcloneRemoteRegistryError('rclone_remote_name_conflict', 'Remote name already exists on this server', 409);
    }

    const encrypted = encryptCredentials(encryptionKey, id, credentials);
    const timestamp = new Date(now()).toISOString();
    const record = {
      id,
      serverId: normalizedServerId,
      name: remoteName,
      type: remoteType,
      parameters: { ...parameters },
      encryptedCredentials: encrypted,
      status: 'untested',
      lastTestedAt: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    state.remotes.push(record);
    await persist();
    return publicRemote(record);
  }

  async function getRemote(remoteId) {
    await ensureInitialized();
    const id = normalizeUuid(remoteId, 'remoteId');
    const record = state.remotes.find((r) => r.id === id);
    return record ? publicRemote(record) : null;
  }

  async function listRemotes({ serverId = null } = {}) {
    await ensureInitialized();
    const normalizedServerId = serverId === null ? null : normalizeUuid(serverId, 'serverId');
    return state.remotes
      .filter((r) => normalizedServerId === null || r.serverId === normalizedServerId)
      .map(publicRemote);
  }

  async function updateRemote(remoteId, { name, parameters, credentials } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(remoteId, 'remoteId');
    const record = state.remotes.find((r) => r.id === id);
    if (!record) throw new RcloneRemoteRegistryError('rclone_remote_not_found', 'Remote not found', 404);

    if (name !== undefined) {
      const newName = normalizeRemoteName(name);
      if (state.remotes.some((r) => r.serverId === record.serverId && r.name === newName && r.id !== id)) {
        throw new RcloneRemoteRegistryError('rclone_remote_name_conflict', 'Remote name already exists on this server', 409);
      }
      record.name = newName;
    }
    if (parameters !== undefined) {
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
        throw new RcloneRemoteRegistryError('rclone_parameters_invalid', 'Parameters must be an object');
      }
      record.parameters = { ...parameters };
      record.status = 'untested';
    }
    if (credentials !== undefined) {
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        throw new RcloneRemoteRegistryError('rclone_credentials_invalid', 'Credentials must be an object');
      }
      record.encryptedCredentials = encryptCredentials(encryptionKey, id, credentials);
      record.status = 'untested';
    }
    record.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicRemote(record);
  }

  async function deleteRemote(remoteId) {
    await ensureInitialized();
    const id = normalizeUuid(remoteId, 'remoteId');
    const index = state.remotes.findIndex((r) => r.id === id);
    if (index === -1) throw new RcloneRemoteRegistryError('rclone_remote_not_found', 'Remote not found', 404);
    state.remotes.splice(index, 1);
    await persist();
    return true;
  }

  function revealCredentials(remoteId) {
    const id = normalizeUuid(remoteId, 'remoteId');
    const record = state.remotes.find((r) => r.id === id);
    if (!record) throw new RcloneRemoteRegistryError('rclone_remote_not_found', 'Remote not found', 404);
    return decryptCredentials(encryptionKey, record);
  }

  async function testRemote(remoteId, { tempDir = os.tmpdir() } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(remoteId, 'remoteId');
    const record = state.remotes.find((r) => r.id === id);
    if (!record) throw new RcloneRemoteRegistryError('rclone_remote_not_found', 'Remote not found', 404);

    const credentials = decryptCredentials(encryptionKey, record);
    const tempConfigPath = path.join(tempDir, `rclone-test-${id}-${randomUUID()}.conf`);
    try {
      await manager.writeConfigFile({
        remotes: [{
          name: record.name,
          type: record.type,
          parameters: record.parameters,
          credentials,
        }],
        targetPath: tempConfigPath,
      });

      const result = await manager.testRemote({
        remoteName: record.name,
        configFile: tempConfigPath,
      });

      record.status = 'verified';
      record.lastTestedAt = result.testedAt;
      record.error = null;
      record.updatedAt = new Date(now()).toISOString();
      await persist();
      return result;
    } catch (error) {
      record.status = 'error';
      record.error = error.message;
      record.updatedAt = new Date(now()).toISOString();
      await persist();
      throw error;
    } finally {
      await rm(tempConfigPath, { force: true }).catch(() => {});
    }
  }

  async function materializeConfigFile(targetPath, { serverId = null } = {}) {
    await ensureInitialized();
    const normalizedServerId = serverId === null ? null : normalizeUuid(serverId, 'serverId');
    const matched = state.remotes.filter((r) => normalizedServerId === null || r.serverId === normalizedServerId);

    const decryptedRemotes = matched.map((record) => ({
      name: record.name,
      type: record.type,
      parameters: record.parameters,
      credentials: decryptCredentials(encryptionKey, record),
    }));

    const result = await manager.writeConfigFile({
      remotes: decryptedRemotes,
      targetPath,
    });

    return Object.freeze({
      targetPath: result.targetPath,
      remoteCount: matched.length,
      writtenAt: result.writtenAt,
    });
  }

  return Object.freeze({
    init,
    createRemote,
    getRemote,
    listRemotes,
    updateRemote,
    deleteRemote,
    revealCredentials,
    testRemote,
    materializeConfigFile,
  });
}

export const rcloneRemoteRegistryInternals = Object.freeze({
  STORE_VERSION,
  ALGORITHM,
  encryptCredentials,
  decryptCredentials,
  normalizeRemoteName,
  normalizeRemoteType,
  publicRemote,
});
