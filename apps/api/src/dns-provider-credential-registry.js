import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const PROVIDERS = new Set(['cloudflare']);
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,256}$/;

export class DnsProviderCredentialRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsProviderCredentialRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    const code = field.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
    throw new DnsProviderCredentialRegistryError('invalid_' + code, field + ' is invalid');
  }
}

function provider(value) {
  if (typeof value !== 'string' || !PROVIDERS.has(value)) {
    throw new DnsProviderCredentialRegistryError('dns_provider_unsupported', 'DNS provider is not supported', 409);
  }
  return value;
}

function token(value) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new DnsProviderCredentialRegistryError('invalid_dns_provider_token', 'DNS provider token is invalid');
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new DnsProviderCredentialRegistryError('dns_provider_credential_state_invalid', field + ' is invalid', 409);
  }
  return value;
}

function encryptionKey(value) {
  try {
    return normalizeEnvironmentMasterKey(value);
  } catch {
    throw new DnsProviderCredentialRegistryError('invalid_secret_master_key', 'Secret master key is invalid', 500);
  }
}

function aad(record) {
  return Buffer.from(['dns-provider', record.id, record.dnsZoneId, record.provider].join(':'), 'utf8');
}

function encryptToken(key, record, value) {
  if (!key) throw new DnsProviderCredentialRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(record));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptToken(key, record) {
  if (!key) throw new DnsProviderCredentialRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  try {
    const iv = Buffer.from(record.iv, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || typeof record.ciphertext !== 'string') throw new Error('invalid envelope');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad(record));
    decipher.setAuthTag(tag);
    return token(Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8'));
  } catch (error) {
    if (error instanceof DnsProviderCredentialRegistryError) throw error;
    throw new DnsProviderCredentialRegistryError('secret_decryption_failed', 'Stored DNS provider credential could not be decrypted', 500);
  }
}

function publicCredential(record) {
  return Object.freeze({
    id: record.id,
    dnsZoneId: record.dnsZoneId,
    provider: record.provider,
    configured: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function validatePersisted(record) {
  const fields = new Set(['id', 'dnsZoneId', 'provider', 'ciphertext', 'iv', 'tag', 'createdAt', 'updatedAt']);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((key) => !fields.has(key))) {
    throw new DnsProviderCredentialRegistryError('dns_provider_credential_state_invalid', 'DNS provider credential state is invalid', 409);
  }
  const normalized = {
    id: uuid(record.id, 'credentialId'),
    dnsZoneId: uuid(record.dnsZoneId, 'dnsZoneId'),
    provider: provider(record.provider),
    ciphertext: record.ciphertext,
    iv: record.iv,
    tag: record.tag,
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
  for (const [field, length] of [['iv', 12], ['tag', 16]]) {
    let decoded;
    try { decoded = Buffer.from(normalized[field], 'base64'); } catch { decoded = null; }
    if (!decoded || decoded.length !== length) {
      throw new DnsProviderCredentialRegistryError('dns_provider_credential_state_invalid', 'DNS provider credential envelope is invalid', 409);
    }
  }
  if (typeof normalized.ciphertext !== 'string' || normalized.ciphertext.length < 1 || normalized.ciphertext.length > 512) {
    throw new DnsProviderCredentialRegistryError('dns_provider_credential_state_invalid', 'DNS provider credential envelope is invalid', 409);
  }
  return normalized;
}

export function createDnsProviderCredentialRegistry({
  filePath = null,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  now = () => Date.now(),
  getDnsZone = async () => null,
} = {}) {
  const key = encryptionKey(masterKey);
  if (typeof getDnsZone !== 'function' || typeof now !== 'function') {
    throw new DnsProviderCredentialRegistryError('dns_provider_credential_dependencies_invalid', 'DNS provider credential dependencies are invalid', 503);
  }
  let state = { version: STORE_VERSION, credentials: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2) + '\n';
    const directory = path.dirname(filePath);
    const temporaryPath = filePath + '.' + process.pid + '.tmp';
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function requireZone(dnsZoneId) {
    let zone;
    try { zone = await getDnsZone(dnsZoneId); }
    catch { throw new DnsProviderCredentialRegistryError('dns_zone_unavailable', 'DNS zone could not be verified', 503); }
    if (!zone) throw new DnsProviderCredentialRegistryError('dns_zone_not_found', 'DNS zone was not found', 404);
    return zone;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.credentials)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'credentials'].includes(field))) {
          throw new DnsProviderCredentialRegistryError('dns_provider_credential_state_invalid', 'DNS provider credential store is invalid', 409);
        }
        const credentials = parsed.credentials.map(validatePersisted);
        if (new Set(credentials.map((record) => record.id)).size !== credentials.length
          || new Set(credentials.map((record) => record.dnsZoneId)).size !== credentials.length) {
          throw new DnsProviderCredentialRegistryError('dns_provider_credential_state_invalid', 'DNS provider credential identities are not unique', 409);
        }
        for (const record of credentials) {
          await requireZone(record.dnsZoneId);
          decryptToken(key, record);
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

  async function setCredential({ dnsZoneId, provider: requestedProvider, token: requestedToken } = {}) {
    await ensureInitialized();
    const normalizedZoneId = uuid(dnsZoneId, 'dnsZoneId');
    await requireZone(normalizedZoneId);
    const normalizedProvider = provider(requestedProvider);
    const normalizedToken = token(requestedToken);
    const current = new Date(now()).toISOString();
    let record = state.credentials.find((candidate) => candidate.dnsZoneId === normalizedZoneId);
    if (!record) {
      record = {
        id: randomUUID(),
        dnsZoneId: normalizedZoneId,
        provider: normalizedProvider,
        ciphertext: null,
        iv: null,
        tag: null,
        createdAt: current,
        updatedAt: current,
      };
      state.credentials.push(record);
    }
    record.provider = normalizedProvider;
    record.updatedAt = current;
    Object.assign(record, encryptToken(key, record, normalizedToken));
    await persist();
    return publicCredential(record);
  }

  async function getForZone(dnsZoneId) {
    await ensureInitialized();
    const normalizedZoneId = uuid(dnsZoneId, 'dnsZoneId');
    const record = state.credentials.find((candidate) => candidate.dnsZoneId === normalizedZoneId) ?? null;
    return record ? publicCredential(record) : Object.freeze({
      id: null, dnsZoneId: normalizedZoneId, provider: null, configured: false, createdAt: null, updatedAt: null,
    });
  }

  async function materialize(credentialId) {
    await ensureInitialized();
    const normalizedId = uuid(credentialId, 'credentialId');
    const record = state.credentials.find((candidate) => candidate.id === normalizedId);
    if (!record) throw new DnsProviderCredentialRegistryError('dns_provider_credential_not_found', 'DNS provider credential was not found', 404);
    await requireZone(record.dnsZoneId);
    return Object.freeze({
      id: record.id,
      dnsZoneId: record.dnsZoneId,
      provider: record.provider,
      token: decryptToken(key, record),
    });
  }

  async function deleteForZone(dnsZoneId) {
    await ensureInitialized();
    const normalizedZoneId = uuid(dnsZoneId, 'dnsZoneId');
    const index = state.credentials.findIndex((candidate) => candidate.dnsZoneId === normalizedZoneId);
    if (index < 0) throw new DnsProviderCredentialRegistryError('dns_provider_credential_not_found', 'DNS provider credential was not found', 404);
    state.credentials.splice(index, 1);
    await persist();
  }

  return Object.freeze({ init, setCredential, getForZone, materialize, deleteForZone });
}

export function rewrapDnsProviderCredentialSnapshot(snapshot, { currentMasterKey, nextMasterKey } = {}) {
  const currentKey = encryptionKey(currentMasterKey);
  const nextKey = encryptionKey(nextMasterKey);
  if (!currentKey || !nextKey) {
    throw new DnsProviderCredentialRegistryError('secret_store_unavailable', 'Current and next master keys are required', 503);
  }
  if (!snapshot || snapshot.version !== STORE_VERSION || !Array.isArray(snapshot.credentials)
    || Object.keys(snapshot).length !== 2 || Object.keys(snapshot).some((field) => !['version', 'credentials'].includes(field))) {
    throw new DnsProviderCredentialRegistryError('dns_provider_credential_state_invalid', 'DNS provider credential store is invalid', 409);
  }
  return {
    version: STORE_VERSION,
    credentials: snapshot.credentials.map((value) => {
      const record = validatePersisted(value);
      const valueToken = decryptToken(currentKey, record);
      return { ...record, ...encryptToken(nextKey, record, valueToken) };
    }),
  };
}

export const dnsProviderCredentialInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  providers: Object.freeze([...PROVIDERS]),
  validatePersisted,
  encryptToken,
  decryptToken,
});
