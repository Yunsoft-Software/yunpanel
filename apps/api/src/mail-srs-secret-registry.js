import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class MailSrsSecretRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailSrsSecretRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value) {
  try { return assertUuid(value, 'serverId'); }
  catch { throw new MailSrsSecretRegistryError('invalid_mail_srs_server_id', 'SRS server ID is invalid'); }
}

function encryptionKey(value) {
  try { return normalizeEnvironmentMasterKey(value); }
  catch { throw new MailSrsSecretRegistryError('invalid_secret_master_key', 'Secret master key is invalid', 500); }
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MailSrsSecretRegistryError('mail_srs_secret_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function aad(record) {
  return Buffer.from(`mail-srs:${record.serverId}:${record.revision}`, 'utf8');
}

function secret(value) {
  if (typeof value !== 'string' || !SECRET_PATTERN.test(value)) {
    throw new MailSrsSecretRegistryError('mail_srs_secret_invalid', 'SRS secret is invalid', 409);
  }
  return value;
}

function encryptSecret(key, record, value, randomBytesFn) {
  if (!key) throw new MailSrsSecretRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  const iv = randomBytesFn(12);
  if (!Buffer.isBuffer(iv) || iv.length !== 12) {
    throw new MailSrsSecretRegistryError('mail_srs_secret_generation_failed', 'SRS secret envelope could not be generated safely', 503);
  }
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(record));
  const ciphertext = Buffer.concat([cipher.update(secret(value), 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

function decryptSecret(key, record) {
  if (!key) throw new MailSrsSecretRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  try {
    const iv = Buffer.from(record.iv, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || typeof record.ciphertext !== 'string') throw new Error('invalid envelope');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad(record));
    decipher.setAuthTag(tag);
    return secret(Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8'));
  } catch (error) {
    if (error instanceof MailSrsSecretRegistryError) throw error;
    throw new MailSrsSecretRegistryError('mail_srs_secret_decryption_failed', 'Stored SRS secret could not be decrypted', 500);
  }
}

function publicRecord(record) {
  return record ? Object.freeze({
    serverId: record.serverId,
    revision: record.revision,
    configured: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }) : null;
}

function validatePersisted(record) {
  const fields = new Set(['serverId', 'revision', 'ciphertext', 'iv', 'tag', 'createdAt', 'updatedAt']);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || typeof record.ciphertext !== 'string' || record.ciphertext.length < 1 || record.ciphertext.length > 256) {
    throw new MailSrsSecretRegistryError('mail_srs_secret_state_invalid', 'Persisted SRS secret state is invalid', 409);
  }
  const normalized = {
    serverId: uuid(record.serverId),
    revision: record.revision,
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
      throw new MailSrsSecretRegistryError('mail_srs_secret_state_invalid', 'Persisted SRS secret envelope is invalid', 409);
    }
  }
  return Object.freeze(normalized);
}

export function createMailSrsSecretRegistry({
  filePath = null,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  now = () => Date.now(),
  serverExists = async () => true,
  randomBytesFn = randomBytes,
} = {}) {
  const key = encryptionKey(masterKey);
  if (typeof now !== 'function' || typeof serverExists !== 'function' || typeof randomBytesFn !== 'function') {
    throw new MailSrsSecretRegistryError('mail_srs_secret_dependencies_invalid', 'SRS secret dependencies are unavailable', 503);
  }
  let state = { version: STORE_VERSION, records: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
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
          throw new MailSrsSecretRegistryError('mail_srs_secret_state_invalid', 'SRS secret store is invalid', 409);
        }
        const records = parsed.records.map(validatePersisted);
        if (new Set(records.map((record) => record.serverId)).size !== records.length) {
          throw new MailSrsSecretRegistryError('mail_srs_secret_state_invalid', 'SRS secret records are not unique', 409);
        }
        for (const record of records) {
          if (!(await serverExists(record.serverId))) {
            throw new MailSrsSecretRegistryError('mail_srs_secret_state_invalid', 'SRS secret references a missing server', 409);
          }
          decryptSecret(key, record);
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

  async function requireServer(value) {
    const serverId = uuid(value);
    if (!(await serverExists(serverId))) {
      throw new MailSrsSecretRegistryError('mail_srs_server_not_found', 'SRS server was not found', 404);
    }
    return serverId;
  }

  function generateSecret() {
    const bytes = randomBytesFn(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
      throw new MailSrsSecretRegistryError('mail_srs_secret_generation_failed', 'SRS secret could not be generated safely', 503);
    }
    return secret(bytes.toString('base64url'));
  }

  async function getForServer(value) {
    await ensureInitialized();
    const serverId = uuid(value);
    return publicRecord(state.records.find((record) => record.serverId === serverId) ?? null);
  }

  async function ensureForServer(value) {
    await ensureInitialized();
    const serverId = await requireServer(value);
    const existing = state.records.find((record) => record.serverId === serverId);
    if (existing) return publicRecord(existing);
    const timestampValue = new Date(now()).toISOString();
    const base = {
      serverId,
      revision: 1,
      createdAt: timestampValue,
      updatedAt: timestampValue,
    };
    const envelope = encryptSecret(key, base, generateSecret(), randomBytesFn);
    const record = { ...base, ...envelope };
    state.records.push(record);
    await persist();
    return publicRecord(record);
  }

  async function materializeForServer(value) {
    await ensureInitialized();
    const serverId = uuid(value);
    const record = state.records.find((candidate) => candidate.serverId === serverId);
    if (!record) {
      throw new MailSrsSecretRegistryError('mail_srs_secret_required', 'Private SRS secret is not configured', 409);
    }
    return Object.freeze({
      serverId,
      revision: record.revision,
      secret: decryptSecret(key, record),
    });
  }

  async function rotateForServer(value, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const serverId = await requireServer(value);
    const index = state.records.findIndex((record) => record.serverId === serverId);
    if (index < 0) throw new MailSrsSecretRegistryError('mail_srs_secret_required', 'Private SRS secret is not configured', 409);
    const current = state.records[index];
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision
      || confirmation !== `rotate-mail-srs-secret:${serverId}:${current.revision}`) {
      throw new MailSrsSecretRegistryError('mail_srs_secret_confirmation_invalid', 'SRS secret rotation confirmation is invalid or stale', 409);
    }
    const base = {
      serverId,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: new Date(now()).toISOString(),
    };
    const envelope = encryptSecret(key, base, generateSecret(), randomBytesFn);
    const next = { ...base, ...envelope };
    state.records[index] = next;
    await persist();
    return publicRecord(next);
  }

  return Object.freeze({ init, getForServer, ensureForServer, materializeForServer, rotateForServer });
}

export const mailSrsSecretRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  secretPattern: SECRET_PATTERN,
  validatePersisted,
  publicRecord,
});
