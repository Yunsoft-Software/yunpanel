import { createHash, randomBytes } from 'node:crypto';
import { createWebsitePathContract } from '@yunpanel/host-runtime';
import { assertUuid } from '@yunpanel/shared';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const SUPPORTED_RUNTIMES = new Set(['static', 'node', 'php']);
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_LIMIT = 100;
const PROTOCOL = 'yunpanel-elfinder-handoff-v1';
const AUDIENCE = 'elfinder';

export class ElFinderHandoffError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ElFinderHandoffError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new ElFinderHandoffError('elfinder_handoff_identity_invalid', `${field} is invalid`);
  }
}

function identity(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ElFinderHandoffError('elfinder_handoff_identity_invalid', `${field} is invalid`);
  }
  return value;
}

function applicationUser(applicationId) {
  return `yunapp-${createHash('sha256').update(applicationId).digest('hex').slice(0, 12)}`;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createElFinderHandoffService({
  websiteRegistry,
  localServerId,
  liveSessions = null,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxHandoffs = DEFAULT_LIMIT,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new ElFinderHandoffError(
      'elfinder_handoff_dependencies_invalid',
      'elFinder handoff dependencies are unavailable',
      503,
    );
  }
  const normalizedLocalServerId = uuid(localServerId, 'localServerId');
  if (liveSessions !== null && typeof liveSessions?.register !== 'function') {
    throw new TypeError('elFinder handoff live session registry is invalid');
  }
  if (typeof now !== 'function'
    || !Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 60_000
    || !Number.isSafeInteger(maxHandoffs) || maxHandoffs < 1 || maxHandoffs > 1_000) {
    throw new TypeError('elFinder handoff policy is invalid');
  }

  const handoffs = new Map();

  function remove(key) {
    const record = handoffs.get(key);
    if (!record) return false;
    handoffs.delete(key);
    record.unregister?.();
    return true;
  }

  function prune() {
    const current = now();
    for (const [key, record] of handoffs) {
      if (record.expiresAt <= current) remove(key);
    }
    while (handoffs.size >= maxHandoffs) remove(handoffs.keys().next().value);
  }

  async function resolveState({ serverId, websiteId }) {
    const normalizedServerId = uuid(serverId, 'serverId');
    const normalizedWebsiteId = uuid(websiteId, 'websiteId');
    if (normalizedServerId !== normalizedLocalServerId) {
      throw new ElFinderHandoffError(
        'elfinder_handoff_server_not_local',
        'elFinder is available only for the active local server',
        404,
      );
    }

    let website;
    try { website = await websiteRegistry.getWebsite(normalizedWebsiteId); }
    catch {
      throw new ElFinderHandoffError(
        'elfinder_handoff_website_unavailable',
        'Website state could not be read',
        503,
      );
    }
    if (!website || website.id !== normalizedWebsiteId || website.serverId !== normalizedServerId) {
      throw new ElFinderHandoffError(
        'elfinder_handoff_website_not_found',
        'Website was not found',
        404,
      );
    }
    if (!SUPPORTED_RUNTIMES.has(website.runtimeType)
      || typeof website.applicationId !== 'string'
      || typeof website.unixUser !== 'string'
      || !Number.isSafeInteger(website.revision) || website.revision < 1) {
      throw new ElFinderHandoffError(
        'elfinder_handoff_website_unsupported',
        'Website does not have a supported managed filesystem identity',
        409,
      );
    }

    const applicationId = uuid(website.applicationId, 'applicationId');
    const expectedUser = applicationUser(applicationId);
    if (!APP_USER_PATTERN.test(website.unixUser) || website.unixUser !== expectedUser) {
      throw new ElFinderHandoffError(
        'elfinder_handoff_site_user_drift',
        'Website Unix user no longer matches canonical ownership',
        409,
      );
    }

    let contract;
    try {
      contract = createWebsitePathContract({
        websiteId: normalizedWebsiteId,
        applicationId,
      });
    } catch {
      throw new ElFinderHandoffError(
        'elfinder_handoff_path_contract_invalid',
        'Website filesystem contract could not be resolved',
        409,
      );
    }
    const root = contract.workspace.sftpRoot;
    if (contract.workspace.authority !== 'site_user'
      || root !== contract.workspace.homeDirectory
      || typeof root !== 'string' || !root.startsWith('/var/lib/yunpanel/data/')) {
      throw new ElFinderHandoffError(
        'elfinder_handoff_path_contract_invalid',
        'Website filesystem root is outside the canonical site workspace',
        409,
      );
    }

    return Object.freeze({
      serverId: normalizedServerId,
      websiteId: normalizedWebsiteId,
      websiteRevision: website.revision,
      applicationId,
      unixUser: expectedUser,
      root,
      audience: AUDIENCE,
    });
  }

  async function issue({ sessionId, userId, serverId, websiteId } = {}) {
    const normalizedSessionId = identity(sessionId, 'sessionId');
    const normalizedUserId = identity(userId, 'userId');
    const state = await resolveState({ serverId, websiteId });
    prune();

    const capability = randomBytes(32).toString('base64url');
    const key = digest(capability);
    const expiresAt = now() + ttlMs;
    const record = {
      sessionId: normalizedSessionId,
      userId: normalizedUserId,
      state,
      expiresAt,
      unregister: null,
    };
    handoffs.set(key, record);
    if (liveSessions) {
      record.unregister = liveSessions.register({
        sessionId: normalizedSessionId,
        userId: normalizedUserId,
        terminate: () => remove(key),
      }).unregister;
    }

    return Object.freeze({
      capability,
      expiresAt,
      protocol: PROTOCOL,
      audience: AUDIENCE,
      target: Object.freeze({
        serverId: state.serverId,
        websiteId: state.websiteId,
      }),
    });
  }

  async function consume(capability) {
    if (typeof capability !== 'string' || !TOKEN_PATTERN.test(capability)) {
      throw new ElFinderHandoffError('elfinder_handoff_invalid', 'elFinder handoff is invalid', 401);
    }
    const key = digest(capability);
    const record = handoffs.get(key);
    if (!record) {
      throw new ElFinderHandoffError('elfinder_handoff_invalid', 'elFinder handoff is invalid', 401);
    }
    remove(key);
    if (record.expiresAt <= now()) {
      throw new ElFinderHandoffError('elfinder_handoff_expired', 'elFinder handoff expired', 401);
    }

    const current = await resolveState({
      serverId: record.state.serverId,
      websiteId: record.state.websiteId,
    });
    for (const field of [
      'serverId', 'websiteId', 'websiteRevision', 'applicationId', 'unixUser', 'root', 'audience',
    ]) {
      if (current[field] !== record.state[field]) {
        throw new ElFinderHandoffError(
          'elfinder_handoff_stale',
          'elFinder handoff became stale before use',
          409,
        );
      }
    }

    return Object.freeze({
      version: 1,
      protocol: PROTOCOL,
      audience: AUDIENCE,
      serverId: current.serverId,
      websiteId: current.websiteId,
      websiteRevision: current.websiteRevision,
      applicationId: current.applicationId,
      unixUser: current.unixUser,
      root: current.root,
      expiresAt: record.expiresAt,
    });
  }

  return Object.freeze({
    issue,
    consume,
    size: () => handoffs.size,
  });
}

export const elFinderHandoffInternals = Object.freeze({
  protocol: PROTOCOL,
  audience: AUDIENCE,
  defaultTtlMs: DEFAULT_TTL_MS,
  defaultLimit: DEFAULT_LIMIT,
  supportedRuntimes: Object.freeze([...SUPPORTED_RUNTIMES]),
  applicationUser,
  digest,
});
