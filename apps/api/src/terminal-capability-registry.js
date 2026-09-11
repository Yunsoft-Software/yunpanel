import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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
    return Object.freeze({ target: record.target, expiresAt: record.expiresAt });
  }

  return { issue, consume, size: () => capabilities.size };
}

export const terminalCapabilityInternals = Object.freeze({
  defaultTtlMs: DEFAULT_TTL_MS,
  defaultLimit: DEFAULT_LIMIT,
  normalizeTarget,
});
