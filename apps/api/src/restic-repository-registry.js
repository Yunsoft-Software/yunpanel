import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { createResticManager, ResticError } from '@yunpanel/host-runtime';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const DEFAULT_STORE_PATH = '/var/lib/yunpanel/control-plane/restic-repositories.json';
const DEFAULT_LOCAL_REPO_BASE = '/var/lib/yunpanel/backups/restic/repos';
const REPO_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const BACKEND_KINDS = new Set(['local', 'rclone']);
const REPO_STATUSES = new Set(['uninitialized', 'ready', 'error']);

export class ResticRepositoryRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ResticRepositoryRegistryError';
    this.code = code;
    this.status = status;
  }
}

function normalizeUuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new ResticRepositoryRegistryError(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, `${field} must be a UUID`); }
}

function normalizeName(value) {
  if (typeof value !== 'string' || !REPO_NAME_PATTERN.test(value)) {
    throw new ResticRepositoryRegistryError('restic_repository_name_invalid', 'Repository name must be 1-80 alphanumeric characters');
  }
  return value;
}

function normalizeMasterKey(value) {
  try { return normalizeEnvironmentMasterKey(value); }
  catch {
    throw new ResticRepositoryRegistryError('invalid_secret_master_key', 'Repository encryption key is invalid', 500);
  }
}

function requireMasterKey(value) {
  if (!value) throw new ResticRepositoryRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  return value;
}

function encryptPassword(masterKey, repoId, password) {
  const key = requireMasterKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(`${repoId}:restic-password`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

function decryptPassword(masterKey, record) {
  const key = requireMasterKey(masterKey);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.encryptedPassword.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${record.id}:restic-password`, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.encryptedPassword.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.encryptedPassword.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ResticRepositoryRegistryError('restic_password_decrypt_failed', 'Repository password could not be decrypted', 500);
  }
}

function normalizeRetentionPolicy(policy) {
  if (policy === undefined || policy === null) return null;
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    throw new ResticRepositoryRegistryError('restic_retention_policy_invalid', 'Retention policy must be an object');
  }
  const normalized = {};
  if (policy.keepLast !== undefined) {
    if (!Number.isSafeInteger(policy.keepLast) || policy.keepLast < 1) {
      throw new ResticRepositoryRegistryError('restic_retention_policy_invalid', 'keepLast must be a positive integer');
    }
    normalized.keepLast = policy.keepLast;
  }
  if (policy.keepDaily !== undefined) {
    if (!Number.isSafeInteger(policy.keepDaily) || policy.keepDaily < 1) {
      throw new ResticRepositoryRegistryError('restic_retention_policy_invalid', 'keepDaily must be a positive integer');
    }
    normalized.keepDaily = policy.keepDaily;
  }
  if (policy.keepWeekly !== undefined) {
    if (!Number.isSafeInteger(policy.keepWeekly) || policy.keepWeekly < 1) {
      throw new ResticRepositoryRegistryError('restic_retention_policy_invalid', 'keepWeekly must be a positive integer');
    }
    normalized.keepWeekly = policy.keepWeekly;
  }
  if (policy.keepMonthly !== undefined) {
    if (!Number.isSafeInteger(policy.keepMonthly) || policy.keepMonthly < 1) {
      throw new ResticRepositoryRegistryError('restic_retention_policy_invalid', 'keepMonthly must be a positive integer');
    }
    normalized.keepMonthly = policy.keepMonthly;
  }
  if (policy.keepYearly !== undefined) {
    if (!Number.isSafeInteger(policy.keepYearly) || policy.keepYearly < 1) {
      throw new ResticRepositoryRegistryError('restic_retention_policy_invalid', 'keepYearly must be a positive integer');
    }
    normalized.keepYearly = policy.keepYearly;
  }
  if (policy.keepTags !== undefined) {
    if (!Array.isArray(policy.keepTags) || policy.keepTags.some((t) => typeof t !== 'string' || t.trim().length < 1)) {
      throw new ResticRepositoryRegistryError('restic_retention_policy_invalid', 'keepTags must be an array of strings');
    }
    normalized.keepTags = Object.freeze([...policy.keepTags.map((t) => t.trim())]);
  }
  return Object.freeze(normalized);
}

function publicRepository(record) {
  return Object.freeze({
    id: record.id,
    serverId: record.serverId,
    name: record.name,
    backend: record.backend,
    target: record.target,
    status: record.status,
    retentionPolicy: record.retentionPolicy ? Object.freeze({ ...record.retentionPolicy }) : null,
    lastCheckedAt: record.lastCheckedAt ?? null,
    lastSnapshotAt: record.lastSnapshotAt ?? null,
    error: record.error ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function createResticRepositoryRegistry({
  filePath = DEFAULT_STORE_PATH,
  localRepoBase = DEFAULT_LOCAL_REPO_BASE,
  masterKey = null,
  serverExists = async () => true,
  resticManager = null,
  now = () => Date.now(),
} = {}) {
  const encryptionKey = masterKey ? normalizeMasterKey(masterKey) : null;
  const manager = resticManager ?? createResticManager({ now });
  let state = { version: STORE_VERSION, repositories: [] };
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
        if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.repositories)) {
          throw new ResticRepositoryRegistryError('restic_repository_state_invalid', 'Restic repository store is invalid', 409);
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

  async function createRepository({
    repositoryId = null,
    serverId,
    name,
    backend = 'local',
    target = null,
    password,
    retentionPolicy = null,
  } = {}) {
    await ensureInitialized();
    const id = repositoryId === null ? randomUUID() : normalizeUuid(repositoryId, 'repositoryId');
    const normalizedServerId = normalizeUuid(serverId, 'serverId');
    if (!(await serverExists(normalizedServerId))) {
      throw new ResticRepositoryRegistryError('server_not_found', 'Target server does not exist', 404);
    }
    const repoName = normalizeName(name);
    if (!BACKEND_KINDS.has(backend)) {
      throw new ResticRepositoryRegistryError('restic_backend_invalid', 'Backend must be local or rclone');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new ResticRepositoryRegistryError('restic_password_invalid', 'Repository password must be at least 8 characters');
    }

    const resolvedTarget = target ?? (backend === 'local' ? path.join(localRepoBase, id) : null);
    if (!resolvedTarget || typeof resolvedTarget !== 'string' || resolvedTarget.trim().length < 1) {
      throw new ResticRepositoryRegistryError('restic_target_invalid', 'Repository target is required');
    }

    const existing = state.repositories.find((r) => r.id === id) ?? null;
    if (existing) {
      if (existing.serverId !== normalizedServerId || existing.name !== repoName) {
        throw new ResticRepositoryRegistryError('restic_repository_identity_conflict', 'Repository identity conflicts with existing state', 409);
      }
      return publicRepository(existing);
    }

    if (state.repositories.some((r) => r.serverId === normalizedServerId && r.name === repoName)) {
      throw new ResticRepositoryRegistryError('restic_repository_name_conflict', 'Repository name already exists on this server', 409);
    }

    const encrypted = encryptPassword(encryptionKey, id, password);
    const timestamp = new Date(now()).toISOString();
    const record = {
      id,
      serverId: normalizedServerId,
      name: repoName,
      backend,
      target: resolvedTarget.trim(),
      status: 'uninitialized',
      encryptedPassword: encrypted,
      retentionPolicy: normalizeRetentionPolicy(retentionPolicy),
      lastCheckedAt: null,
      lastSnapshotAt: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    state.repositories.push(record);
    await persist();
    return publicRepository(record);
  }

  async function reloadFromDisk() {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === STORE_VERSION && Array.isArray(parsed.repositories)) {
        state = parsed;
      }
    } catch {
      // ignore
    }
  }

  async function getRepository(repositoryId) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    let record = state.repositories.find((r) => r.id === id);
    if (!record) {
      await reloadFromDisk();
      record = state.repositories.find((r) => r.id === id);
    }
    return record ? publicRepository(record) : null;
  }

  async function listRepositories({ serverId = null } = {}) {
    await ensureInitialized();
    await reloadFromDisk();
    const normalizedServerId = serverId === null ? null : normalizeUuid(serverId, 'serverId');
    return state.repositories
      .filter((r) => normalizedServerId === null || r.serverId === normalizedServerId)
      .map(publicRepository);
  }

  async function updateRepository(repositoryId, { name, retentionPolicy } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);

    if (name !== undefined) {
      const newName = normalizeName(name);
      if (state.repositories.some((r) => r.serverId === record.serverId && r.name === newName && r.id !== id)) {
        throw new ResticRepositoryRegistryError('restic_repository_name_conflict', 'Repository name already exists on this server', 409);
      }
      record.name = newName;
    }
    if (retentionPolicy !== undefined) {
      record.retentionPolicy = normalizeRetentionPolicy(retentionPolicy);
    }
    record.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicRepository(record);
  }

  async function deleteRepository(repositoryId) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const index = state.repositories.findIndex((r) => r.id === id);
    if (index === -1) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    state.repositories.splice(index, 1);
    await persist();
    return true;
  }

  function revealPassword(repositoryId) {
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    return decryptPassword(encryptionKey, record);
  }

  // --- Restic Lifecycle Wrappers ---

  async function initResticRepository(repositoryId) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    const password = decryptPassword(encryptionKey, record);

    try {
      const result = await manager.init({ repository: record.target, password });
      record.status = 'ready';
      record.error = null;
      record.updatedAt = new Date(now()).toISOString();
      await persist();
      return Object.freeze({ ...result, status: 'ready' });
    } catch (error) {
      record.status = 'error';
      record.error = error.message;
      record.updatedAt = new Date(now()).toISOString();
      await persist();
      throw error;
    }
  }

  async function checkResticRepository(repositoryId, { readDataSubset = null } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    const password = decryptPassword(encryptionKey, record);

    try {
      const result = await manager.check({ repository: record.target, password, readDataSubset });
      record.status = 'ready';
      record.error = null;
      record.lastCheckedAt = result.checkedAt;
      record.updatedAt = new Date(now()).toISOString();
      await persist();
      return result;
    } catch (error) {
      record.status = 'error';
      record.error = error.message;
      record.updatedAt = new Date(now()).toISOString();
      await persist();
      throw error;
    }
  }

  async function unlockResticRepository(repositoryId, { removeAll = false } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    const password = decryptPassword(encryptionKey, record);
    return manager.unlock({ repository: record.target, password, removeAll });
  }

  async function createSnapshot(repositoryId, { paths, tags = [], excludes = [], parentSnapshotId = null } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    const password = decryptPassword(encryptionKey, record);

    const receipt = await manager.createSnapshot({
      repository: record.target,
      password,
      paths,
      tags,
      excludes,
      parentSnapshotId,
    });

    record.lastSnapshotAt = receipt.createdAt;
    record.updatedAt = new Date(now()).toISOString();
    await persist();
    return receipt;
  }

  async function listSnapshots(repositoryId, { tags = [], path = null } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    const password = decryptPassword(encryptionKey, record);
    return manager.listSnapshots({ repository: record.target, password, tags, path });
  }

  async function applyRetention(repositoryId, { policy = null, prune = false } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    const password = decryptPassword(encryptionKey, record);
    const effectivePolicy = policy ?? record.retentionPolicy ?? {};
    return manager.forget({ repository: record.target, password, policy: effectivePolicy, prune });
  }

  async function pruneResticRepository(repositoryId) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    const password = decryptPassword(encryptionKey, record);
    return manager.prune({ repository: record.target, password });
  }

  async function restoreSnapshot(repositoryId, { snapshotId, targetDirectory, include = [], exclude = [] } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    const password = decryptPassword(encryptionKey, record);
    return manager.restore({
      repository: record.target,
      password,
      snapshotId,
      targetDirectory,
      include,
      exclude,
    });
  }

  return Object.freeze({
    init,
    createRepository,
    getRepository,
    listRepositories,
    updateRepository,
    deleteRepository,
    revealPassword,
    initResticRepository,
    checkResticRepository,
    unlockResticRepository,
    createSnapshot,
    listSnapshots,
    applyRetention,
    pruneResticRepository,
    restoreSnapshot,
  });
}

export const resticRepositoryRegistryInternals = Object.freeze({
  STORE_VERSION,
  ALGORITHM,
  encryptPassword,
  decryptPassword,
  normalizeRetentionPolicy,
  publicRepository,
});
