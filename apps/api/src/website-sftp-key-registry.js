import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const HOSTED_RUNTIME_TYPES = new Set(['static', 'node', 'php']);
const KEY_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa']);
const MAX_KEYS_PER_WEBSITE = 50;

export class WebsiteSftpKeyRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteSftpKeyRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new WebsiteSftpKeyRegistryError(
      `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      `${field} is invalid`,
    );
  }
}

function label(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WebsiteSftpKeyRegistryError('sftp_key_label_invalid', 'SFTP key label must be a printable string up to 80 characters');
  }
  return value.trim();
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WebsiteSftpKeyRegistryError('sftp_key_revision_invalid', 'A positive expectedRevision is required');
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new WebsiteSftpKeyRegistryError('sftp_key_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function readSshString(buffer, offset, field) {
  if (!Buffer.isBuffer(buffer) || offset < 0 || offset + 4 > buffer.length) {
    throw new WebsiteSftpKeyRegistryError('sftp_public_key_invalid', `${field} is truncated`);
  }
  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (length > 8192 || end > buffer.length) {
    throw new WebsiteSftpKeyRegistryError('sftp_public_key_invalid', `${field} is invalid`);
  }
  return Object.freeze({ value: buffer.subarray(start, end), offset: end });
}

function canonicalBase64(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 8192
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new WebsiteSftpKeyRegistryError('sftp_public_key_invalid', 'SFTP public key payload is invalid');
  }
  const decoded = Buffer.from(value, 'base64');
  const canonical = decoded.toString('base64');
  if (decoded.length < 16 || canonical.replace(/=+$/u, '') !== value.replace(/=+$/u, '')) {
    throw new WebsiteSftpKeyRegistryError('sftp_public_key_invalid', 'SFTP public key payload is invalid');
  }
  return Object.freeze({ decoded, canonical });
}

function normalizedRsaModulus(value) {
  if (value.length > 1 && value[0] === 0) return value.subarray(1);
  return value;
}

function validateKeyBlob(type, blob) {
  let cursor = readSshString(blob, 0, 'SFTP key type');
  if (cursor.value.toString('utf8') !== type) {
    throw new WebsiteSftpKeyRegistryError('sftp_public_key_type_mismatch', 'SFTP public key type does not match its payload');
  }

  if (type === 'ssh-ed25519') {
    cursor = readSshString(blob, cursor.offset, 'Ed25519 public key');
    if (cursor.value.length !== 32 || cursor.offset !== blob.length) {
      throw new WebsiteSftpKeyRegistryError('sftp_public_key_invalid', 'Ed25519 public key payload is invalid');
    }
    return;
  }

  if (type === 'ecdsa-sha2-nistp256') {
    const curve = readSshString(blob, cursor.offset, 'ECDSA curve');
    const point = readSshString(blob, curve.offset, 'ECDSA public point');
    if (curve.value.toString('utf8') !== 'nistp256' || point.value.length !== 65
      || point.value[0] !== 0x04 || point.offset !== blob.length) {
      throw new WebsiteSftpKeyRegistryError('sftp_public_key_invalid', 'ECDSA P-256 public key payload is invalid');
    }
    return;
  }

  const exponent = readSshString(blob, cursor.offset, 'RSA exponent');
  const modulus = readSshString(blob, exponent.offset, 'RSA modulus');
  const normalizedModulus = normalizedRsaModulus(modulus.value);
  if (exponent.value.length < 1 || exponent.value.length > 8 || normalizedModulus.length < 256
    || modulus.offset !== blob.length) {
    throw new WebsiteSftpKeyRegistryError('sftp_public_key_weak', 'RSA SFTP keys must be at least 2048 bits');
  }
}

function parsePublicKey(value) {
  if (typeof value === 'string' && /PRIVATE KEY/i.test(value)) {
    throw new WebsiteSftpKeyRegistryError('sftp_private_key_rejected', 'Private keys must never be submitted to YunPanel');
  }
  if (typeof value !== 'string' || value.length < 32 || value.length > 12_000 || /[\r\n\u0000]/.test(value)) {
    throw new WebsiteSftpKeyRegistryError('sftp_public_key_invalid', 'SFTP public key must be one OpenSSH public-key line');
  }
  const fields = value.trim().split(/[ \t]+/u);
  if (fields.length < 2 || !KEY_TYPES.has(fields[0])) {
    throw new WebsiteSftpKeyRegistryError('sftp_public_key_type_unsupported', 'SFTP public key type is not supported');
  }
  const type = fields[0];
  const { decoded, canonical } = canonicalBase64(fields[1]);
  validateKeyBlob(type, decoded);
  const fingerprint = `SHA256:${createHash('sha256').update(decoded).digest('base64').replace(/=+$/u, '')}`;
  return Object.freeze({
    type,
    keyData: canonical,
    publicKey: `${type} ${canonical}`,
    fingerprint,
  });
}

function publicRecord(record) {
  return Object.freeze({
    id: record.id,
    websiteId: record.websiteId,
    label: record.label,
    keyType: record.keyType,
    fingerprint: record.fingerprint,
    status: record.status,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt,
  });
}

function materialRecord(record) {
  return Object.freeze({
    id: record.id,
    websiteId: record.websiteId,
    applicationId: record.applicationId,
    unixUser: record.unixUser,
    label: record.label,
    keyType: record.keyType,
    publicKey: `${record.keyType} ${record.keyData}`,
    fingerprint: record.fingerprint,
    revision: record.revision,
  });
}

function normalizePersisted(record) {
  const fields = new Set([
    'id', 'websiteId', 'applicationId', 'unixUser', 'label', 'keyType', 'keyData', 'fingerprint',
    'status', 'revision', 'createdAt', 'updatedAt', 'revokedAt',
  ]);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || !KEY_TYPES.has(record.keyType) || typeof record.keyData !== 'string'
    || !['active', 'revoked'].includes(record.status)
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || typeof record.unixUser !== 'string' || !/^yunapp-[a-f0-9]{12}$/.test(record.unixUser)) {
    throw new WebsiteSftpKeyRegistryError('sftp_key_state_invalid', 'Persisted SFTP key state is invalid', 409);
  }
  const parsed = parsePublicKey(`${record.keyType} ${record.keyData}`);
  if (parsed.fingerprint !== record.fingerprint) {
    throw new WebsiteSftpKeyRegistryError('sftp_key_state_invalid', 'Persisted SFTP key fingerprint is invalid', 409);
  }
  let normalizedLabel;
  try { normalizedLabel = label(record.label); }
  catch { throw new WebsiteSftpKeyRegistryError('sftp_key_state_invalid', 'Persisted SFTP key label is invalid', 409); }
  const normalized = {
    id: uuid(record.id, 'sftpKeyId'),
    websiteId: uuid(record.websiteId, 'websiteId'),
    applicationId: uuid(record.applicationId, 'applicationId'),
    unixUser: record.unixUser,
    label: normalizedLabel,
    keyType: parsed.type,
    keyData: parsed.keyData,
    fingerprint: parsed.fingerprint,
    status: record.status,
    revision: record.revision,
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
    revokedAt: record.revokedAt === null ? null : timestamp(record.revokedAt, 'revokedAt'),
  };
  if ((normalized.status === 'active' && normalized.revokedAt !== null)
    || (normalized.status === 'revoked' && normalized.revokedAt === null)) {
    throw new WebsiteSftpKeyRegistryError('sftp_key_state_invalid', 'Persisted SFTP key revocation state is invalid', 409);
  }
  return normalized;
}

export function createWebsiteSftpKeyRegistry({
  filePath = null,
  now = () => Date.now(),
  getWebsite,
} = {}) {
  if (typeof now !== 'function' || typeof getWebsite !== 'function') {
    throw new WebsiteSftpKeyRegistryError('sftp_key_dependencies_invalid', 'SFTP key registry dependencies are unavailable', 503);
  }
  let state = { version: STORE_VERSION, keys: [] };
  let initialized = filePath === null;
  let writeChain = Promise.resolve();

  function nowIso() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WebsiteSftpKeyRegistryError('sftp_key_clock_invalid', 'SFTP key registry clock is invalid', 503);
    }
    return new Date(value).toISOString();
  }

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await rm(temporary, { force: true }).catch(() => {});
      try {
        await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, filePath);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.keys)) throw new Error('invalid SFTP key registry state');
      const keys = parsed.keys.map(normalizePersisted);
      if (new Set(keys.map((entry) => entry.id)).size !== keys.length) throw new Error('duplicate SFTP key identity');
      const fingerprints = new Set();
      for (const entry of keys) {
        const identity = `${entry.websiteId}:${entry.fingerprint}`;
        if (fingerprints.has(identity)) throw new Error('duplicate SFTP key fingerprint');
        fingerprints.add(identity);
      }
      state = { version: STORE_VERSION, keys };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof WebsiteSftpKeyRegistryError) throw error;
        throw new WebsiteSftpKeyRegistryError('sftp_key_state_invalid', 'SFTP key registry state is invalid', 409);
      }
      await persist();
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function requireWebsite(websiteId) {
    const id = uuid(websiteId, 'websiteId');
    const website = await getWebsite(id);
    if (!website) throw new WebsiteSftpKeyRegistryError('website_not_found', 'Website not found', 404);
    if (!HOSTED_RUNTIME_TYPES.has(website.runtimeType) || typeof website.applicationId !== 'string'
      || typeof website.unixUser !== 'string' || !/^yunapp-[a-f0-9]{12}$/.test(website.unixUser)) {
      throw new WebsiteSftpKeyRegistryError('sftp_key_website_unsupported', 'Website does not have a managed SFTP Unix identity', 409);
    }
    return Object.freeze({
      id,
      applicationId: uuid(website.applicationId, 'applicationId'),
      unixUser: website.unixUser,
    });
  }

  function requireRecord(keyId, websiteId) {
    const id = uuid(keyId, 'sftpKeyId');
    const record = state.keys.find((entry) => entry.id === id && entry.websiteId === websiteId) ?? null;
    if (!record) throw new WebsiteSftpKeyRegistryError('sftp_key_not_found', 'SFTP key not found', 404);
    return record;
  }

  function assertWebsiteBinding(record, website) {
    if (record.applicationId !== website.applicationId || record.unixUser !== website.unixUser) {
      throw new WebsiteSftpKeyRegistryError('sftp_key_website_drift', 'SFTP key Website identity no longer matches managed state', 409);
    }
  }

  function assertUniqueFingerprint(websiteId, fingerprint, excludedId = null) {
    if (state.keys.some((entry) => entry.websiteId === websiteId && entry.id !== excludedId && entry.fingerprint === fingerprint)) {
      throw new WebsiteSftpKeyRegistryError('sftp_key_duplicate', 'This SFTP public key is already registered for the Website', 409);
    }
  }

  function createRecord(website, input, time, { replacingId = null } = {}) {
    const parsed = parsePublicKey(input.publicKey);
    assertUniqueFingerprint(website.id, parsed.fingerprint, replacingId);
    const activeCount = state.keys.filter((entry) => entry.websiteId === website.id
      && entry.status === 'active' && entry.id !== replacingId).length;
    if (activeCount >= MAX_KEYS_PER_WEBSITE) {
      throw new WebsiteSftpKeyRegistryError('sftp_key_limit_reached', 'Website SFTP key limit has been reached', 409);
    }
    return {
      id: randomUUID(),
      websiteId: website.id,
      applicationId: website.applicationId,
      unixUser: website.unixUser,
      label: label(input.label),
      keyType: parsed.type,
      keyData: parsed.keyData,
      fingerprint: parsed.fingerprint,
      status: 'active',
      revision: 1,
      createdAt: time,
      updatedAt: time,
      revokedAt: null,
    };
  }

  async function addKey({ websiteId, label: keyLabel, publicKey } = {}) {
    await ensureInitialized();
    const website = await requireWebsite(websiteId);
    const record = createRecord(website, { label: keyLabel, publicKey }, nowIso());
    state.keys.push(record);
    await persist();
    return publicRecord(record);
  }

  async function listKeys(target = {}) {
    await ensureInitialized();
    const websiteId = typeof target === 'string' ? target : target?.websiteId;
    const website = await requireWebsite(websiteId);
    return Object.freeze(state.keys
      .filter((entry) => entry.websiteId === website.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(publicRecord));
  }

  async function revokeKey({ websiteId, keyId, expectedRevision } = {}) {
    await ensureInitialized();
    const website = await requireWebsite(websiteId);
    const record = requireRecord(keyId, website.id);
    assertWebsiteBinding(record, website);
    const expected = revision(expectedRevision);
    if (record.revision !== expected) {
      throw new WebsiteSftpKeyRegistryError('sftp_key_revision_conflict', 'SFTP key changed after it was loaded', 409);
    }
    if (record.status === 'revoked') return publicRecord(record);
    const time = nowIso();
    record.status = 'revoked';
    record.revision += 1;
    record.revokedAt = time;
    record.updatedAt = time;
    await persist();
    return publicRecord(record);
  }

  async function rotateKey({ websiteId, keyId, expectedRevision, label: keyLabel, publicKey } = {}) {
    await ensureInitialized();
    const website = await requireWebsite(websiteId);
    const current = requireRecord(keyId, website.id);
    assertWebsiteBinding(current, website);
    const expected = revision(expectedRevision);
    if (current.revision !== expected) {
      throw new WebsiteSftpKeyRegistryError('sftp_key_revision_conflict', 'SFTP key changed after it was loaded', 409);
    }
    if (current.status !== 'active') {
      throw new WebsiteSftpKeyRegistryError('sftp_key_rotation_revoked', 'Revoked SFTP keys cannot be rotated', 409);
    }
    const parsed = parsePublicKey(publicKey);
    if (parsed.fingerprint === current.fingerprint) {
      throw new WebsiteSftpKeyRegistryError('sftp_key_rotation_no_change', 'Rotation requires a different SFTP public key', 409);
    }
    const time = nowIso();
    const replacement = createRecord(website, { label: keyLabel, publicKey }, time, { replacingId: current.id });
    current.status = 'revoked';
    current.revision += 1;
    current.revokedAt = time;
    current.updatedAt = time;
    state.keys.push(replacement);
    await persist();
    return Object.freeze({ revoked: publicRecord(current), created: publicRecord(replacement) });
  }

  async function listActiveMaterial(websiteId) {
    await ensureInitialized();
    const website = await requireWebsite(websiteId);
    return Object.freeze(state.keys
      .filter((entry) => entry.websiteId === website.id && entry.status === 'active')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((entry) => {
        assertWebsiteBinding(entry, website);
        return materialRecord(entry);
      }));
  }

  return Object.freeze({
    init,
    addKey,
    listKeys,
    revokeKey,
    rotateKey,
    listActiveMaterial,
  });
}

export const websiteSftpKeyRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  hostedRuntimeTypes: Object.freeze([...HOSTED_RUNTIME_TYPES]),
  keyTypes: Object.freeze([...KEY_TYPES]),
  maxKeysPerWebsite: MAX_KEYS_PER_WEBSITE,
  parsePublicKey,
  readSshString,
  validateKeyBlob,
  publicRecord,
  materialRecord,
});
