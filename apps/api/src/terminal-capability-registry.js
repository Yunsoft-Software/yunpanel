import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_CONTAINER_SHELLS = new Set(['/bin/bash', '/bin/sh']);
const DOCKER_CONTAINER_TARGET_KEYS = Object.freeze([
  'scope',
  'serverId',
  'dockerProjectId',
  'projectName',
  'serviceName',
  'containerId',
  'containerName',
  'user',
  'uid',
  'gid',
  'cwd',
  'shell',
]);
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_LIMIT = 100;

export class TerminalCapabilityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TerminalCapabilityError';
    this.code = code;
    this.status = status;
  }
}

function boundedIdentity(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TerminalCapabilityError('terminal_capability_invalid', `${field} is invalid`);
  }
  return value;
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TerminalCapabilityError('terminal_target_invalid', 'Terminal target is invalid');
  }
  const common = {
    scope: value.scope,
    serverId: boundedIdentity(value.serverId, 'serverId'),
    user: boundedIdentity(value.user, 'user'),
    cwd: boundedIdentity(value.cwd, 'cwd'),
  };
  if (value.scope === 'server') {
    if (Object.keys(value).some((key) => !['scope', 'serverId', 'user', 'cwd'].includes(key))
      || value.user !== 'root' || value.cwd !== '/root') {
      throw new TerminalCapabilityError('terminal_target_invalid', 'Server terminal target is invalid');
    }
    return Object.freeze(common);
  }
  if (value.scope === 'site') {
    if (Object.keys(value).some((key) => !['scope', 'serverId', 'websiteId', 'user', 'cwd'].includes(key))) {
      throw new TerminalCapabilityError('terminal_target_invalid', 'Site terminal target is invalid');
    }
    return Object.freeze({ ...common, websiteId: boundedIdentity(value.websiteId, 'websiteId') });
  }
  if (value.scope === 'docker_container') {
    const keys = Object.keys(value);
    if (keys.length !== DOCKER_CONTAINER_TARGET_KEYS.length
      || keys.some((key) => !DOCKER_CONTAINER_TARGET_KEYS.includes(key))) {
      throw new TerminalCapabilityError('terminal_target_invalid', 'Container console target is invalid');
    }
    const dockerProjectId = boundedIdentity(value.dockerProjectId, 'dockerProjectId');
    const projectName = boundedIdentity(value.projectName, 'projectName');
    const serviceName = boundedIdentity(value.serviceName, 'serviceName');
    const containerId = boundedIdentity(value.containerId, 'containerId');
    const containerName = boundedIdentity(value.containerName, 'containerName');
    const shell = boundedIdentity(value.shell, 'shell');
    const { uid, gid } = value;
    if (!UUID_PATTERN.test(dockerProjectId)
      || !PROJECT_NAME_PATTERN.test(projectName)
      || !SERVICE_NAME_PATTERN.test(serviceName)
      || !CONTAINER_ID_PATTERN.test(containerId)
      || !Number.isSafeInteger(uid) || uid < 1 || uid > 2_147_483_647
      || !Number.isSafeInteger(gid) || gid < 1 || gid > 2_147_483_647
      || common.user !== `${uid}:${gid}`
      || !common.cwd.startsWith('/')
      || !ALLOWED_CONTAINER_SHELLS.has(shell)) {
      throw new TerminalCapabilityError('terminal_target_invalid', 'Container console target is invalid');
    }
    return Object.freeze({
      ...common,
      dockerProjectId,
      projectName,
      serviceName,
      containerId,
      containerName,
      uid,
      gid,
      shell,
    });
  }
  throw new TerminalCapabilityError('terminal_target_invalid', 'Terminal scope is invalid');
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

export function createTerminalCapabilityRegistry({
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxCapabilities = DEFAULT_LIMIT,
  liveSessions = null,
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 60_000
    || !Number.isSafeInteger(maxCapabilities) || maxCapabilities < 1 || maxCapabilities > 1_000) {
    throw new TypeError('Terminal capability policy is invalid');
  }
  if (liveSessions !== null && typeof liveSessions?.register !== 'function') {
    throw new TypeError('Terminal capability live session registry is invalid');
  }
  const capabilities = new Map();

  function assertOpen(target) {
    if (!liveSessions) return;
    if (target.scope === 'site') {
      try { liveSessions.assertWebsiteOpen(target.websiteId); }
      catch (error) { throw new TerminalCapabilityError(error.code ?? 'terminal_website_removing',
        error.code === 'terminal_website_removing' ? 'Site siliniyor' : 'Terminal kullanılamıyor', error.status ?? 409); }
      return;
    }
    if (target.scope === 'docker_container' && typeof liveSessions.assertDockerProjectOpen === 'function') {
      try { liveSessions.assertDockerProjectOpen(target.dockerProjectId); }
      catch (error) {
        throw new TerminalCapabilityError(
          error.code ?? 'terminal_docker_project_busy',
          error.code === 'terminal_docker_project_busy' ? 'Docker projesi durduruluyor veya kaldırılıyor' : 'Terminal kullanılamıyor',
          error.status ?? 409,
        );
      }
    }
  }

  function remove(key) {
    const record = capabilities.get(key);
    if (!record) return false;
    capabilities.delete(key);
    record.unregister?.();
    return true;
  }

  function prune() {
    const timestamp = now();
    for (const [key, record] of capabilities) if (record.expiresAt <= timestamp) remove(key);
    while (capabilities.size >= maxCapabilities) remove(capabilities.keys().next().value);
  }

  function issue({ sessionId, userId, target } = {}) {
    const normalizedSessionId = boundedIdentity(sessionId, 'sessionId');
    const normalizedUserId = boundedIdentity(userId, 'userId');
    const normalizedTarget = normalizeTarget(target);
    assertOpen(normalizedTarget);
    prune();
    const capability = randomBytes(32).toString('base64url');
    const key = digest(capability);
    const expiresAt = now() + ttlMs;
    const record = {
      sessionId: normalizedSessionId,
      userId: normalizedUserId,
      target: normalizedTarget,
      expiresAt,
      unregister: null,
    };
    capabilities.set(key, record);
    if (liveSessions) {
      record.unregister = liveSessions.register({
        sessionId: normalizedSessionId,
        userId: normalizedUserId,
        websiteId: normalizedTarget.scope === 'site' ? normalizedTarget.websiteId : null,
        dockerProjectId: normalizedTarget.scope === 'docker_container' ? normalizedTarget.dockerProjectId : null,
        containerId: normalizedTarget.scope === 'docker_container' ? normalizedTarget.containerId : null,
        terminate: () => remove(key),
      }).unregister;
    }
    return Object.freeze({ capability, expiresAt, protocol: 'yunpanel-terminal-v1', target: normalizedTarget });
  }

  function consume(capability, { sessionId, userId } = {}) {
    if (typeof capability !== 'string' || !TOKEN_PATTERN.test(capability)) {
      throw new TerminalCapabilityError('terminal_capability_invalid', 'Terminal capability is invalid', 401);
    }
    const key = digest(capability);
    const record = capabilities.get(key);
    if (!record) throw new TerminalCapabilityError('terminal_capability_invalid', 'Terminal capability is invalid', 401);
    remove(key);
    if (record.expiresAt <= now()) {
      throw new TerminalCapabilityError('terminal_capability_expired', 'Terminal capability expired', 401);
    }
    if (record.sessionId !== sessionId || record.userId !== userId) {
      throw new TerminalCapabilityError('terminal_capability_binding_invalid', 'Terminal capability is bound to another session', 403);
    }
    assertOpen(record.target);
    return Object.freeze({ target: record.target, expiresAt: record.expiresAt });
  }

  return { issue, consume, size: () => capabilities.size };
}

export const terminalCapabilityInternals = Object.freeze({
  defaultTtlMs: DEFAULT_TTL_MS,
  defaultLimit: DEFAULT_LIMIT,
  normalizeTarget,
});
