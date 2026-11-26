import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { assertResticRcloneTarget, createResticManager } from '@yunpanel/host-runtime';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';
import { createProcessStoreLock } from './process-store-lock.js';
import { readJsonWithFallback, writeJsonAtomic } from '@yunpanel/shared/json-file-store';

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
  let target = record.target;
  let error = record.error ?? null;
  try {
    assertResticRcloneTarget(target);
  } catch (invalidTarget) {
    target = null;
    error = invalidTarget.message;
  }
  return Object.freeze({
    id: record.id,
    serverId: record.serverId,
    name: record.name,
    backend: record.backend,
    target,
    status: record.status,
    retentionPolicy: record.retentionPolicy ? Object.freeze({ ...record.retentionPolicy }) : null,
    lastCheckedAt: record.lastCheckedAt ?? null,
    lastSnapshotAt: record.lastSnapshotAt ?? null,
    error,
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
  const resolvedFilePath = path.resolve(filePath);
  const storeLock = createProcessStoreLock({ filePath: resolvedFilePath });
  const encryptionKey = masterKey ? normalizeMasterKey(masterKey) : null;
  const manager = resticManager ?? createResticManager({ now });
  let state = { version: STORE_VERSION, repositories: [] };
  let initialized = false;
  let storeQueue = Promise.resolve();

  function withStoreLock(action) {
    const execute = () => storeLock.withLock(action);
    const result = storeQueue.then(execute, execute);
    storeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function writeDiskState(nextState) {
    await writeJsonAtomic(resolvedFilePath, nextState);
    state = nextState;
  }

  async function syncFromDisk({ createIfMissing = false, strict = false } = {}) {
    try {
      const parsed = await readJsonWithFallback(resolvedFilePath);
      if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.repositories)) {
        if (strict) {
          throw new ResticRepositoryRegistryError('restic_repository_state_invalid', 'Restic repository store is invalid', 409);
        }
        return state;
      }
      state = parsed;
      return state;
    } catch (error) {
      if (error instanceof ResticRepositoryRegistryError) throw error;
      if (error?.code === 'ENOENT') {
        if (createIfMissing) {
          const emptyState = { version: STORE_VERSION, repositories: [] };
          await writeDiskState(emptyState);
        }
        return state;
      }
      if (strict) throw error;
      return state;
    }
  }

  async function init() {
    if (initialized) return;
    await withStoreLock(async () => {
      if (initialized) return;
      await syncFromDisk({ createIfMissing: true, strict: true });
      initialized = true;
    });
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
    try {
      assertResticRcloneTarget(resolvedTarget.trim());
    } catch (error) {
      throw new ResticRepositoryRegistryError(error.code, error.message, error.status);
    }

    const normalizedRetentionPolicy = normalizeRetentionPolicy(retentionPolicy);
    const encrypted = encryptPassword(encryptionKey, id, password);

    return withStoreLock(async () => {
      await syncFromDisk();
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

      const timestamp = new Date(now()).toISOString();
      const record = {
        id,
        serverId: normalizedServerId,
        name: repoName,
        backend,
        target: resolvedTarget.trim(),
        status: 'uninitialized',
        encryptedPassword: encrypted,
        retentionPolicy: normalizedRetentionPolicy,
        lastCheckedAt: null,
        lastSnapshotAt: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      state.repositories.push(record);
      await writeDiskState(state);
      return publicRepository(record);
    });
  }

  async function getRepository(repositoryId) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    return withStoreLock(async () => {
      await syncFromDisk();
      const record = state.repositories.find((r) => r.id === id);
      return record ? publicRepository(record) : null;
    });
  }

  async function listRepositories({ serverId = null } = {}) {
    await ensureInitialized();
    const normalizedServerId = serverId === null ? null : normalizeUuid(serverId, 'serverId');
    return withStoreLock(async () => {
      await syncFromDisk();
      return state.repositories
        .filter((r) => normalizedServerId === null || r.serverId === normalizedServerId)
        .map(publicRepository);
    });
  }

  async function updateRepository(repositoryId, { name, retentionPolicy } = {}) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const nextName = name !== undefined ? normalizeName(name) : undefined;
    const nextRetentionPolicy = retentionPolicy !== undefined ? normalizeRetentionPolicy(retentionPolicy) : undefined;

    return withStoreLock(async () => {
      await syncFromDisk();
      const record = state.repositories.find((r) => r.id === id);
      if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);

      if (nextName !== undefined) {
        if (state.repositories.some((r) => r.serverId === record.serverId && r.name === nextName && r.id !== id)) {
          throw new ResticRepositoryRegistryError('restic_repository_name_conflict', 'Repository name already exists on this server', 409);
        }
        record.name = nextName;
      }
      if (nextRetentionPolicy !== undefined) {
        record.retentionPolicy = nextRetentionPolicy;
      }
      record.updatedAt = new Date(now()).toISOString();
      await writeDiskState(state);
      return publicRepository(record);
    });
  }

  async function deleteRepository(repositoryId) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    return withStoreLock(async () => {
      await syncFromDisk();
      const index = state.repositories.findIndex((r) => r.id === id);
      if (index === -1) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
      state.repositories.splice(index, 1);
      await writeDiskState(state);
      return true;
    });
  }

  function revealPassword(repositoryId) {
    const id = normalizeUuid(repositoryId, 'repositoryId');
    const record = state.repositories.find((r) => r.id === id);
    if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
    return decryptPassword(encryptionKey, record);
  }

  async function readRepositoryCredentials(repositoryId) {
    await ensureInitialized();
    const id = normalizeUuid(repositoryId, 'repositoryId');
    return withStoreLock(async () => {
      await syncFromDisk();
      const record = state.repositories.find((r) => r.id === id);
      if (!record) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
      return {
        id,
        target: record.target,
        retentionPolicy: record.retentionPolicy ? { ...record.retentionPolicy } : null,
        password: decryptPassword(encryptionKey, record),
      };
    });
  }

  async function applyRepositoryMutation(id, mutate) {
    return withStoreLock(async () => {
      await syncFromDisk();
      const liveRecord = state.repositories.find((r) => r.id === id);
      if (!liveRecord) throw new ResticRepositoryRegistryError('restic_repository_not_found', 'Repository not found', 404);
      mutate(liveRecord);
      await writeDiskState(state);
      return liveRecord;
    });
  }

  // --- Restic Lifecycle Wrappers ---

  async function initResticRepository(repositoryId) {
    const { id, target, password } = await readRepositoryCredentials(repositoryId);

    try {
      const result = await manager.init({ repository: target, password });
      await applyRepositoryMutation(id, (liveRecord) => {
        liveRecord.status = 'ready';
        liveRecord.error = null;
        liveRecord.updatedAt = new Date(now()).toISOString();
      });
      return Object.freeze({ ...result, status: 'ready' });
    } catch (error) {
      await applyRepositoryMutation(id, (liveRecord) => {
        liveRecord.status = 'error';
        liveRecord.error = error.message;
        liveRecord.updatedAt = new Date(now()).toISOString();
      }).catch((mutationError) => {
        if (mutationError?.code !== 'restic_repository_not_found') throw mutationError;
      });
      throw error;
    }
  }

  async function checkResticRepository(repositoryId, { readDataSubset = null } = {}) {
    const { id, target, password } = await readRepositoryCredentials(repositoryId);

    try {
      const result = await manager.check({ repository: target, password, readDataSubset });
      await applyRepositoryMutation(id, (liveRecord) => {
        liveRecord.status = 'ready';
        liveRecord.error = null;
        liveRecord.lastCheckedAt = result.checkedAt;
        liveRecord.updatedAt = new Date(now()).toISOString();
      });
      return result;
    } catch (error) {
      await applyRepositoryMutation(id, (liveRecord) => {
        liveRecord.status = 'error';
        liveRecord.error = error.message;
        liveRecord.updatedAt = new Date(now()).toISOString();
      }).catch((mutationError) => {
        if (mutationError?.code !== 'restic_repository_not_found') throw mutationError;
      });
      throw error;
    }
  }

  async function unlockResticRepository(repositoryId, { removeAll = false } = {}) {
    const { target, password } = await readRepositoryCredentials(repositoryId);
    return manager.unlock({ repository: target, password, removeAll });
  }

  async function createSnapshot(repositoryId, { paths, tags = [], excludes = [], parentSnapshotId = null } = {}) {
    const { id, target, password } = await readRepositoryCredentials(repositoryId);

    const receipt = await manager.createSnapshot({
      repository: target,
      password,
      paths,
      tags,
      excludes,
      parentSnapshotId,
    });

    await applyRepositoryMutation(id, (liveRecord) => {
      liveRecord.lastSnapshotAt = receipt.createdAt;
      liveRecord.updatedAt = new Date(now()).toISOString();
    });
    return receipt;
  }

  async function listSnapshots(repositoryId, { tags = [], path = null } = {}) {
    const { target, password } = await readRepositoryCredentials(repositoryId);
    return manager.listSnapshots({ repository: target, password, tags, path });
  }

  async function applyRetention(repositoryId, { policy = null, prune = false, tags = [] } = {}) {
    const { target, password, retentionPolicy } = await readRepositoryCredentials(repositoryId);
    const effectivePolicy = policy ?? retentionPolicy ?? {};
    return manager.forget({ repository: target, password, policy: effectivePolicy, prune, tags });
  }

  async function pruneResticRepository(repositoryId) {
    const { target, password } = await readRepositoryCredentials(repositoryId);
    return manager.prune({ repository: target, password });
  }

  async function restoreSnapshot(repositoryId, { snapshotId, targetDirectory, include = [], exclude = [] } = {}) {
    const { target, password } = await readRepositoryCredentials(repositoryId);
    return manager.restore({
      repository: target,
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
