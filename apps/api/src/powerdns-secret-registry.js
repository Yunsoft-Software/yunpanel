import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class PowerDnsSecretRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PowerDnsSecretRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value) {
  try { return assertUuid(value, 'serverId'); }
  catch { throw new PowerDnsSecretRegistryError('invalid_powerdns_server_id', 'PowerDNS server ID is invalid'); }
}

function masterKey(value) {
  try {
    const key = normalizeEnvironmentMasterKey(value);
    if (!key) throw new Error('missing');
    return key;
  } catch {
    throw new PowerDnsSecretRegistryError('powerdns_secret_store_unavailable', 'PowerDNS secret master key is unavailable', 503);
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new PowerDnsSecretRegistryError('powerdns_secret_state_invalid', 'Persisted PowerDNS secret timestamp is invalid', 409);
  }
  return value;
}

function apiKey(value) {
  if (typeof value !== 'string' || !API_KEY_PATTERN.test(value)) {
    throw new PowerDnsSecretRegistryError('powerdns_secret_state_invalid', 'PowerDNS API key state is invalid', 409);
  }
  return value;
}

function aad(serverId) {
  return Buffer.from(`powerdns-api-key:${serverId}`, 'utf8');
}

function encrypt(key, serverId, value) {
  const normalized = apiKey(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(serverId));
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

function decrypt(key, record) {
  try {
    const iv = Buffer.from(record.iv, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    const ciphertext = Buffer.from(record.ciphertext, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 32 || ciphertext.length > 128) throw new Error('invalid envelope');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad(record.serverId));
    decipher.setAuthTag(tag);
    return apiKey(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch (error) {
    if (error instanceof PowerDnsSecretRegistryError) throw error;
    throw new PowerDnsSecretRegistryError('powerdns_secret_decryption_failed', 'PowerDNS API key could not be decrypted', 500);
  }
}

function envelopeField(value, bytes, field) {
  if (typeof value !== 'string') throw new PowerDnsSecretRegistryError('powerdns_secret_state_invalid', `PowerDNS ${field} is invalid`, 409);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) {
    throw new PowerDnsSecretRegistryError('powerdns_secret_state_invalid', `PowerDNS ${field} is invalid`, 409);
  }
  return value;
}

function persistedRecord(value) {
  const fields = new Set(['serverId', 'revision', 'ciphertext', 'iv', 'tag', 'createdAt', 'updatedAt']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.ciphertext !== 'string' || value.ciphertext.length < 32 || value.ciphertext.length > 256) {
    throw new PowerDnsSecretRegistryError('powerdns_secret_state_invalid', 'Persisted PowerDNS secret state is invalid', 409);
  }
  return Object.freeze({
    serverId: uuid(value.serverId),
    revision: value.revision,
    ciphertext: value.ciphertext,
    iv: envelopeField(value.iv, 12, 'secret IV'),
    tag: envelopeField(value.tag, 16, 'secret tag'),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

function publicRecord(record) {
  if (!record) return null;
  return Object.freeze({
    serverId: record.serverId,
    revision: record.revision,
    configured: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function createPowerDnsSecretRegistry({
  filePath = null,
  masterKey: rawMasterKey = process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  now = () => Date.now(),
  serverExists = async () => true,
  generateApiKey = () => randomBytes(32).toString('base64url'),
} = {}) {
  const key = masterKey(rawMasterKey);
  if (typeof now !== 'function' || typeof serverExists !== 'function' || typeof generateApiKey !== 'function') {
    throw new PowerDnsSecretRegistryError('powerdns_secret_dependencies_invalid', 'PowerDNS secret dependencies are unavailable', 503);
  }
  let state = { version: STORE_VERSION, records: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.records)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'records'].includes(field))) {
          throw new PowerDnsSecretRegistryError('powerdns_secret_state_invalid', 'PowerDNS secret store is invalid', 409);
        }
        const records = parsed.records.map(persistedRecord);
        if (new Set(records.map((record) => record.serverId)).size !== records.length) {
          throw new PowerDnsSecretRegistryError('powerdns_secret_state_invalid', 'PowerDNS secret records are not unique', 409);
        }
        for (const record of records) {
          if (!(await serverExists(record.serverId))) {
            throw new PowerDnsSecretRegistryError('powerdns_secret_state_invalid', 'PowerDNS secret references a missing server', 409);
          }
          decrypt(key, record);
        }
        state = { version: STORE_VERSION, records };
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

  async function requireServer(serverId) {
    const id = uuid(serverId);
    if (!(await serverExists(id))) throw new PowerDnsSecretRegistryError('powerdns_server_not_found', 'Server was not found', 404);
    return id;
  }

  async function getForServer(serverId) {
    await ensureInitialized();
    const id = uuid(serverId);
    return publicRecord(state.records.find((record) => record.serverId === id) ?? null);
  }

  async function ensureForServer(serverId) {
    await ensureInitialized();
    const id = await requireServer(serverId);
    const existing = state.records.find((record) => record.serverId === id);
    if (existing) return publicRecord(existing);
    const value = apiKey(generateApiKey());
    const timestampValue = new Date(now()).toISOString();
    const sealed = encrypt(key, id, value);
    const record = {
      serverId: id,
      revision: 1,
      ...sealed,
      createdAt: timestampValue,
      updatedAt: timestampValue,
    };
    state.records.push(record);
    await persist();
    return publicRecord(record);
  }

  async function materializeForServer(serverId) {
    await ensureInitialized();
    const id = uuid(serverId);
    const record = state.records.find((candidate) => candidate.serverId === id);
    if (!record) throw new PowerDnsSecretRegistryError('powerdns_secret_required', 'PowerDNS API key is not configured', 409);
    return Object.freeze({ serverId: id, revision: record.revision, apiKey: decrypt(key, record) });
  }

  async function rotateForServer(serverId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const id = await requireServer(serverId);
    const index = state.records.findIndex((record) => record.serverId === id);
    if (index < 0) throw new PowerDnsSecretRegistryError('powerdns_secret_required', 'PowerDNS API key is not configured', 409);
    const current = state.records[index];
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision
      || confirmation !== `rotate-powerdns-api-key:${id}:${current.revision}`) {
      throw new PowerDnsSecretRegistryError('powerdns_secret_confirmation_invalid', 'PowerDNS API key rotation confirmation is invalid or stale', 409);
    }
    const sealed = encrypt(key, id, apiKey(generateApiKey()));
    const next = {
      ...current,
      ...sealed,
      revision: current.revision + 1,
      updatedAt: new Date(now()).toISOString(),
    };
    state.records[index] = next;
    await persist();
    return publicRecord(next);
  }

  return Object.freeze({ init, getForServer, ensureForServer, materializeForServer, rotateForServer });
}

export const powerDnsSecretRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  apiKeyPattern: API_KEY_PATTERN,
  persistedRecord,
  publicRecord,
});
