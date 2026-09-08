import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_OFFLINE_AFTER_MS = 90 * 1000;
const TOKEN_BYTES = 32;

export class RegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return {
    version: STORE_VERSION,
    enrollmentTokens: [],
    servers: [],
  };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeHashEquals(expectedHash, token) {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createSecret() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function validateHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length < 1 || hostname.length > 253) {
    throw new RegistryError('invalid_hostname', 'hostname must contain 1 to 253 characters');
  }

  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(hostname)) {
    throw new RegistryError('invalid_hostname', 'hostname contains unsupported characters');
  }

  return hostname.toLowerCase();
}

function validateDisplayName(displayName, fallback) {
  if (displayName == null || displayName === '') return fallback;
  if (typeof displayName !== 'string' || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw new RegistryError('invalid_display_name', 'displayName must be a printable string up to 80 characters');
  }
  return displayName.trim() || fallback;
}

function publicServer(server, now, offlineAfterMs) {
  let connectivity = 'pending';
  if (server.lastSeenAt) {
    connectivity = now - Date.parse(server.lastSeenAt) <= offlineAfterMs ? 'online' : 'offline';
  }

  return {
    id: server.id,
    name: server.name,
    hostname: server.hostname,
    connectivity,
    createdAt: server.createdAt,
    enrolledAt: server.enrolledAt,
    lastSeenAt: server.lastSeenAt,
    agentVersion: server.agentVersion ?? null,
    inventory: server.inventory ?? null,
    services: server.services ?? null,
  };
}

export function createServerRegistry({
  filePath = null,
  now = () => Date.now(),
  offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS,
} = {}) {
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();

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

  async function init() {
    if (initialized) return;

    if (filePath) {
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.servers) || !Array.isArray(parsed.enrollmentTokens)) {
          throw new Error('unsupported or invalid server registry state');
        }
        state = parsed;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function issueEnrollmentToken({ label = null, ttlMs = DEFAULT_ENROLLMENT_TTL_MS } = {}) {
    await ensureInitialized();

    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60 * 1000) {
      throw new RegistryError('invalid_ttl', 'Enrollment token TTL must be between 1 and 60 minutes');
    }

    if (label != null && (typeof label !== 'string' || label.length > 80)) {
      throw new RegistryError('invalid_label', 'Enrollment token label must be at most 80 characters');
    }

    const token = createSecret();
    const createdAtMs = now();
    const record = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      label: label?.trim() || null,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
      usedAt: null,
    };

    state.enrollmentTokens.push(record);
    await persist();

    return {
      token,
      id: record.id,
      label: record.label,
      expiresAt: record.expiresAt,
    };
  }

  async function enrollServer({ token, hostname, displayName = null }) {
    await ensureInitialized();

    if (typeof token !== 'string' || token.length < 20) {
      throw new RegistryError('invalid_enrollment_token', 'Enrollment token is invalid', 401);
    }

    const normalizedHostname = validateHostname(hostname);
    const tokenRecord = state.enrollmentTokens.find((record) => !record.usedAt && safeHashEquals(record.tokenHash, token));

    if (!tokenRecord || Date.parse(tokenRecord.expiresAt) < now()) {
      throw new RegistryError('invalid_enrollment_token', 'Enrollment token is invalid or expired', 401);
    }

    if (state.servers.some((server) => server.hostname === normalizedHostname)) {
      throw new RegistryError('server_exists', 'A server with this hostname is already enrolled', 409);
    }

    const agentToken = createSecret();
    const timestamp = new Date(now()).toISOString();
    const server = {
      id: randomUUID(),
      name: validateDisplayName(displayName, normalizedHostname),
      hostname: normalizedHostname,
      agentTokenHash: hashToken(agentToken),
      createdAt: timestamp,
      enrolledAt: timestamp,
      lastSeenAt: null,
      agentVersion: null,
      inventory: null,
      services: null,
    };

    tokenRecord.usedAt = timestamp;
    state.servers.push(server);
    await persist();

    return {
      server: publicServer(server, now(), offlineAfterMs),
      agentToken,
    };
  }

  async function authenticateAgent({ serverId, agentToken }) {
    await ensureInitialized();

    const server = state.servers.find((candidate) => candidate.id === serverId);
    if (!server || typeof agentToken !== 'string' || !safeHashEquals(server.agentTokenHash, agentToken)) {
      throw new RegistryError('invalid_agent_credentials', 'Agent credentials are invalid', 401);
    }

    return publicServer(server, now(), offlineAfterMs);
  }

  async function heartbeat({ serverId, agentToken, agentVersion = null, inventory = null, services = null }) {
    await ensureInitialized();
    const authenticatedServer = await authenticateAgent({ serverId, agentToken });

    if (agentVersion != null && (typeof agentVersion !== 'string' || agentVersion.length > 40)) {
      throw new RegistryError('invalid_agent_version', 'agentVersion must be a string up to 40 characters');
    }

    const server = state.servers.find((candidate) => candidate.id === authenticatedServer.id);
    const timestamp = new Date(now()).toISOString();
    server.lastSeenAt = timestamp;
    server.agentVersion = agentVersion ?? server.agentVersion;
    if (inventory != null) server.inventory = inventory;
    if (services != null) server.services = services;
    await persist();

    return publicServer(server, now(), offlineAfterMs);
  }

  async function listServers() {
    await ensureInitialized();
    const currentTime = now();
    return state.servers.map((server) => publicServer(server, currentTime, offlineAfterMs));
  }

  async function getServer(serverId) {
    await ensureInitialized();
    const server = state.servers.find((candidate) => candidate.id === serverId);
    return server ? publicServer(server, now(), offlineAfterMs) : null;
  }

  return {
    init,
    issueEnrollmentToken,
    enrollServer,
    authenticateAgent,
    heartbeat,
    listServers,
    getServer,
  };
}
