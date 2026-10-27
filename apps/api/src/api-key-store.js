import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';

// Machine keys for the automation API. A key is scoped to one parent Domain and an
// upstream port range; the secret is shown once and only its SHA-256 is stored.
const TOKEN = /^ypk_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;
const FIELDS = new Set(['name', 'parentDomain', 'portMin', 'portMax', 'createdBy']);
const MAX_KEYS = 20;
const USE_PERSIST_INTERVAL_MS = 60_000;

export class ApiKeyStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApiKeyStoreError';
    this.code = code;
    this.status = status;
  }
}

const digest = (secret) => createHash('sha256').update(secret).digest();

function port(value, field) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new ApiKeyStoreError('invalid_api_key_ports', `${field} must be between 1024 and 65535`);
  }
  return value;
}

function definition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !FIELDS.has(key))) {
    throw new ApiKeyStoreError('invalid_api_key', 'Send name, parentDomain, portMin and portMax');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ApiKeyStoreError('invalid_api_key_name', 'Key name must contain 1 to 64 printable characters');
  }
  let parentDomain;
  try { parentDomain = normalizeDomainSet(input.parentDomain, []).primary; }
  catch { throw new ApiKeyStoreError('invalid_api_key_domain', 'Parent Domain must be a fully qualified domain name'); }
  const portMin = port(input.portMin, 'portMin');
  const portMax = port(input.portMax, 'portMax');
  if (portMin > portMax) throw new ApiKeyStoreError('invalid_api_key_ports', 'portMin must not exceed portMax');
  return { name, scope: { parentDomain, portMin, portMax } };
}

function publicView(record) {
  return Object.freeze({
    id: record.id, name: record.name, scope: Object.freeze({ ...record.scope }), createdBy: record.createdBy ?? null,
    createdAt: record.createdAt, lastUsedAt: record.lastUsedAt ?? null, revokedAt: record.revokedAt ?? null,
  });
}

export function createApiKeyStore({ filePath = null, now = () => Date.now() } = {}) {
  let state = { version: 1, keys: [] };
  let loaded = !filePath;
  let lastPersistedUse = 0;

  async function load() {
    if (loaded) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.keys)) throw new Error('invalid');
      state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new ApiKeyStoreError('api_key_store_invalid', 'API key store is unreadable', 500);
    }
    loaded = true;
  }

  async function persist() {
    if (!filePath) return;
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
  }

  async function create(input) {
    await load();
    const { name, scope } = definition(input);
    if (state.keys.filter((key) => !key.revokedAt).length >= MAX_KEYS) {
      throw new ApiKeyStoreError('api_key_limit', `At most ${MAX_KEYS} active keys are allowed`, 409);
    }
    const id = randomBytes(6).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const record = { id, name, scope, hash: digest(secret).toString('hex'), createdBy: input.createdBy ?? null,
      createdAt: new Date(now()).toISOString(), lastUsedAt: null, revokedAt: null };
    state.keys.push(record);
    await persist();
    return { key: publicView(record), token: `ypk_${id}_${secret}` };
  }

  async function list() {
    await load();
    return state.keys.map(publicView);
  }

  async function revoke(id) {
    await load();
    const record = state.keys.find((key) => key.id === id);
    if (!record) throw new ApiKeyStoreError('api_key_not_found', 'API key was not found', 404);
    if (!record.revokedAt) {
      record.revokedAt = new Date(now()).toISOString();
      await persist();
    }
    return publicView(record);
  }

  // Returns the key's public view, or null for anything that is not an exact active key.
  async function authenticate(token) {
    await load();
    const match = typeof token === 'string' ? TOKEN.exec(token) : null;
    if (!match) return null;
    const record = state.keys.find((key) => key.id === match[1]);
    const expected = record ? Buffer.from(record.hash, 'hex') : digest('');
    const valid = timingSafeEqual(expected, digest(match[2]));
    if (!record || !valid || record.revokedAt) return null;
    record.lastUsedAt = new Date(now()).toISOString();
    if (now() - lastPersistedUse >= USE_PERSIST_INTERVAL_MS) {
      lastPersistedUse = now();
      await persist();
    }
    return publicView(record);
  }

  return Object.freeze({ create, list, revoke, authenticate });
}
