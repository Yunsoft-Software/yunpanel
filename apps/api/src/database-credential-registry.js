import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const DATABASE_USER_HOST = 'localhost';
const USERNAME_PATTERN = /^ydb_[a-f0-9]{24}$/;
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ALLOWED_PRIVILEGES = Object.freeze([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'INDEX',
  'DROP',
  'REFERENCES',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
  'EXECUTE',
]);
const ALLOWED_PRIVILEGE_SET = new Set(ALLOWED_PRIVILEGES);
const DEFAULT_PRIVILEGES = Object.freeze([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'INDEX',
  'DROP',
  'REFERENCES',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
]);

export class DatabaseCredentialRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DatabaseCredentialRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new DatabaseCredentialRegistryError(
      `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      `${field} is invalid`,
    );
  }
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DatabaseCredentialRegistryError('invalid_database_credential_revision', 'A positive expectedRevision is required');
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new DatabaseCredentialRegistryError('database_credential_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function encryptionKey(value) {
  try { return normalizeEnvironmentMasterKey(value); }
  catch { throw new DatabaseCredentialRegistryError('invalid_secret_master_key', 'Secret master key is invalid', 500); }
}

function usernameFor(bindingId) {
  const normalized = uuid(bindingId, 'databaseBindingId');
  return `ydb_${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

function privileges(value = DEFAULT_PRIVILEGES) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ALLOWED_PRIVILEGES.length
    || value.some((entry) => typeof entry !== 'string' || !ALLOWED_PRIVILEGE_SET.has(entry))) {
    throw new DatabaseCredentialRegistryError(
      'invalid_database_privileges',
      'Database privileges must be a non-empty supported privilege list',
    );
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) {
    throw new DatabaseCredentialRegistryError('invalid_database_privileges', 'Database privileges must not contain duplicates');
  }
  return Object.freeze(ALLOWED_PRIVILEGES.filter((entry) => unique.includes(entry)));
}

function password(value) {
  if (typeof value !== 'string' || !PASSWORD_PATTERN.test(value)) {
    throw new DatabaseCredentialRegistryError('database_credential_state_invalid', 'Database credential secret is invalid', 409);
  }
  return value;
}

function aad(record) {
  return Buffer.from([
    'database-credential',
    record.id,
    record.databaseBindingId,
    record.username,
    record.host,
  ].join(':'), 'utf8');
}

function encryptPassword(key, record, value) {
  if (!key) throw new DatabaseCredentialRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  const normalized = password(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(record));
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

function decryptPassword(key, record) {
  if (!key) throw new DatabaseCredentialRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  try {
    const iv = Buffer.from(record.iv, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    const ciphertext = Buffer.from(record.ciphertext, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 24 || ciphertext.length > 128) {
      throw new Error('invalid envelope');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad(record));
    decipher.setAuthTag(tag);
    return password(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch (error) {
    if (error instanceof DatabaseCredentialRegistryError) throw error;
    throw new DatabaseCredentialRegistryError(
      'secret_decryption_failed',
      'Stored database credential could not be decrypted',
      500,
    );
  }
}

function publicCredential(record) {
  return Object.freeze({
    id: record.id,
    databaseBindingId: record.databaseBindingId,
    serverId: record.serverId,
    databaseName: record.databaseName,
    websiteId: record.websiteId,
    applicationId: record.applicationId,
    siteUnixUser: record.siteUnixUser,
    username: record.username,
    host: record.host,
    privileges: Object.freeze([...record.privileges]),
    revision: record.revision,
    passwordConfigured: true,
    passwordUpdatedAt: record.passwordUpdatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function validateEnvelope(record) {
  for (const [field, expectedBytes] of [['iv', 12], ['tag', 16]]) {
    if (typeof record[field] !== 'string') {
      throw new DatabaseCredentialRegistryError('database_credential_state_invalid', 'Database credential envelope is invalid', 409);
    }
    const decoded = Buffer.from(record[field], 'base64');
    if (decoded.length !== expectedBytes || decoded.toString('base64') !== record[field]) {
      throw new DatabaseCredentialRegistryError('database_credential_state_invalid', 'Database credential envelope is invalid', 409);
    }
  }
  if (typeof record.ciphertext !== 'string' || record.ciphertext.length < 32 || record.ciphertext.length > 256) {
    throw new DatabaseCredentialRegistryError('database_credential_state_invalid', 'Database credential envelope is invalid', 409);
  }
}

function normalizePersisted(record) {
  const fields = new Set([
    'id', 'databaseBindingId', 'serverId', 'databaseName', 'websiteId', 'applicationId', 'siteUnixUser',
    'username', 'host', 'privileges', 'revision', 'ciphertext', 'iv', 'tag', 'passwordUpdatedAt', 'createdAt', 'updatedAt',
  ]);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || typeof record.databaseName !== 'string' || !record.databaseName
    || typeof record.siteUnixUser !== 'string' || !/^yunapp-[a-f0-9]{12}$/.test(record.siteUnixUser)
    || typeof record.username !== 'string' || !USERNAME_PATTERN.test(record.username)
    || record.host !== DATABASE_USER_HOST || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new DatabaseCredentialRegistryError('database_credential_state_invalid', 'Database credential state is invalid', 409);
  }
  const normalized = {
    id: uuid(record.id, 'databaseCredentialId'),
    databaseBindingId: uuid(record.databaseBindingId, 'databaseBindingId'),
    serverId: uuid(record.serverId, 'serverId'),
    databaseName: record.databaseName,
    websiteId: uuid(record.websiteId, 'websiteId'),
    applicationId: uuid(record.applicationId, 'applicationId'),
    siteUnixUser: record.siteUnixUser,
    username: record.username,
    host: record.host,
    privileges: privileges(record.privileges),
    revision: record.revision,
    ciphertext: record.ciphertext,
    iv: record.iv,
    tag: record.tag,
    passwordUpdatedAt: timestamp(record.passwordUpdatedAt, 'passwordUpdatedAt'),
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
  validateEnvelope(normalized);
  if (normalized.username !== usernameFor(normalized.databaseBindingId)) {
    throw new DatabaseCredentialRegistryError('database_credential_state_invalid', 'Database username does not match binding identity', 409);
  }
  return normalized;
}

export function createDatabaseCredentialRegistry({
  filePath = null,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  now = () => Date.now(),
  getDatabaseBinding,
  generatePassword = () => randomBytes(32).toString('base64url'),
} = {}) {
  const key = encryptionKey(masterKey);
  if (typeof now !== 'function' || typeof getDatabaseBinding !== 'function' || typeof generatePassword !== 'function') {
    throw new DatabaseCredentialRegistryError(
      'database_credential_dependencies_invalid',
      'Database credential registry dependencies are unavailable',
      503,
    );
  }
  let state = { version: STORE_VERSION, credentials: [] };
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

  async function requireBinding(bindingId, { persisted = false } = {}) {
    const normalizedId = uuid(bindingId, 'databaseBindingId');
    let binding;
    try { binding = await getDatabaseBinding(normalizedId); }
    catch {
      throw new DatabaseCredentialRegistryError('database_binding_unavailable', 'Database binding could not be verified', 503);
    }
    if (!binding) {
      throw new DatabaseCredentialRegistryError(
        persisted ? 'database_credential_state_invalid' : 'database_binding_not_found',
        persisted ? 'Persisted database credential references a missing binding' : 'Database binding not found',
        persisted ? 409 : 404,
      );
    }
    return binding;
  }

  function assertBindingMatches(record, binding) {
    if (record.databaseBindingId !== binding.id || record.serverId !== binding.serverId
      || record.databaseName !== binding.databaseName || record.websiteId !== binding.websiteId
      || record.applicationId !== binding.applicationId || record.siteUnixUser !== binding.unixUser) {
      throw new DatabaseCredentialRegistryError(
        'database_credential_binding_drift',
        'Database credential ownership no longer matches the database binding',
        409,
      );
    }
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.credentials)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'credentials'].includes(field))) {
          throw new DatabaseCredentialRegistryError('database_credential_state_invalid', 'Database credential store is invalid', 409);
        }
        const credentials = parsed.credentials.map(normalizePersisted);
        if (new Set(credentials.map((record) => record.id)).size !== credentials.length
          || new Set(credentials.map((record) => record.databaseBindingId)).size !== credentials.length
          || new Set(credentials.map((record) => `${record.username}@${record.host}`)).size !== credentials.length) {
          throw new DatabaseCredentialRegistryError('database_credential_state_invalid', 'Database credential identities must be unique', 409);
        }
        for (const record of credentials) {
          const binding = await requireBinding(record.databaseBindingId, { persisted: true });
          assertBindingMatches(record, binding);
          decryptPassword(key, record);
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

  async function createCredential({ databaseBindingId, privileges: requestedPrivileges = DEFAULT_PRIVILEGES, confirmation } = {}) {
    await ensureInitialized();
    const binding = await requireBinding(databaseBindingId);
    if (state.credentials.some((record) => record.databaseBindingId === binding.id)) {
      throw new DatabaseCredentialRegistryError('database_credential_exists', 'Database binding already has a credential', 409);
    }
    const normalizedPrivileges = privileges(requestedPrivileges);
    const username = usernameFor(binding.id);
    const expectedConfirmation = `create-database-credential:${binding.id}:${username}`;
    if (confirmation !== expectedConfirmation) {
      throw new DatabaseCredentialRegistryError('database_credential_confirmation_mismatch', 'Database credential creation confirmation does not match', 409);
    }
    const generated = password(generatePassword());
    const current = new Date(now()).toISOString();
    const record = {
      id: randomUUID(),
      databaseBindingId: binding.id,
      serverId: binding.serverId,
      databaseName: binding.databaseName,
      websiteId: binding.websiteId,
      applicationId: binding.applicationId,
      siteUnixUser: binding.unixUser,
      username,
      host: DATABASE_USER_HOST,
      privileges: [...normalizedPrivileges],
      revision: 1,
      ciphertext: null,
      iv: null,
      tag: null,
      passwordUpdatedAt: current,
      createdAt: current,
      updatedAt: current,
    };
    Object.assign(record, encryptPassword(key, record, generated));
    state.credentials.push(record);
    await persist();
    return publicCredential(record);
  }

  async function getCredential(credentialId) {
    await ensureInitialized();
    const normalizedId = uuid(credentialId, 'databaseCredentialId');
    const record = state.credentials.find((candidate) => candidate.id === normalizedId);
    return record ? publicCredential(record) : null;
  }

  async function getForBinding(databaseBindingId) {
    await ensureInitialized();
    const normalizedId = uuid(databaseBindingId, 'databaseBindingId');
    const record = state.credentials.find((candidate) => candidate.databaseBindingId === normalizedId) ?? null;
    return record ? publicCredential(record) : null;
  }

  async function listCredentials({ serverId = null, websiteId = null, applicationId = null } = {}) {
    await ensureInitialized();
    const normalizedServerId = serverId === null ? null : uuid(serverId, 'serverId');
    const normalizedWebsiteId = websiteId === null ? null : uuid(websiteId, 'websiteId');
    const normalizedApplicationId = applicationId === null ? null : uuid(applicationId, 'applicationId');
    return state.credentials
      .filter((record) => normalizedServerId === null || record.serverId === normalizedServerId)
      .filter((record) => normalizedWebsiteId === null || record.websiteId === normalizedWebsiteId)
      .filter((record) => normalizedApplicationId === null || record.applicationId === normalizedApplicationId)
      .map(publicCredential);
  }

  async function setPrivileges(credentialId, { expectedRevision, privileges: requestedPrivileges, confirmation } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(credentialId, 'databaseCredentialId');
    const expected = revision(expectedRevision);
    const normalizedPrivileges = privileges(requestedPrivileges);
    const record = state.credentials.find((candidate) => candidate.id === normalizedId);
    if (!record) throw new DatabaseCredentialRegistryError('database_credential_not_found', 'Database credential not found', 404);
    if (record.revision !== expected) {
      throw new DatabaseCredentialRegistryError('database_credential_revision_conflict', 'Database credential changed; refresh and retry', 409);
    }
    const nextKey = normalizedPrivileges.join(',');
    const currentKey = record.privileges.join(',');
    if (nextKey === currentKey) {
      throw new DatabaseCredentialRegistryError('database_credential_no_change', 'Database privileges are unchanged', 409);
    }
    const expectedConfirmation = `update-database-grants:${record.id}:${record.revision}`;
    if (confirmation !== expectedConfirmation) {
      throw new DatabaseCredentialRegistryError('database_credential_confirmation_mismatch', 'Database grant update confirmation does not match', 409);
    }
    const binding = await requireBinding(record.databaseBindingId);
    assertBindingMatches(record, binding);
    record.privileges = [...normalizedPrivileges];
    record.revision += 1;
    record.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicCredential(record);
  }

  async function rotatePassword(credentialId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(credentialId, 'databaseCredentialId');
    const expected = revision(expectedRevision);
    const record = state.credentials.find((candidate) => candidate.id === normalizedId);
    if (!record) throw new DatabaseCredentialRegistryError('database_credential_not_found', 'Database credential not found', 404);
    if (record.revision !== expected) {
      throw new DatabaseCredentialRegistryError('database_credential_revision_conflict', 'Database credential changed; refresh and retry', 409);
    }
    const expectedConfirmation = `rotate-database-password:${record.id}:${record.revision}`;
    if (confirmation !== expectedConfirmation) {
      throw new DatabaseCredentialRegistryError('database_credential_confirmation_mismatch', 'Database password rotation confirmation does not match', 409);
    }
    const binding = await requireBinding(record.databaseBindingId);
    assertBindingMatches(record, binding);
    const generated = password(generatePassword());
    Object.assign(record, encryptPassword(key, record, generated));
    const current = new Date(now()).toISOString();
    record.revision += 1;
    record.passwordUpdatedAt = current;
    record.updatedAt = current;
    await persist();
    return publicCredential(record);
  }

  async function deleteCredential(credentialId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(credentialId, 'databaseCredentialId');
    const expected = revision(expectedRevision);
    const index = state.credentials.findIndex((candidate) => candidate.id === normalizedId);
    if (index < 0) throw new DatabaseCredentialRegistryError('database_credential_not_found', 'Database credential not found', 404);
    const record = state.credentials[index];
    if (record.revision !== expected) {
      throw new DatabaseCredentialRegistryError('database_credential_revision_conflict', 'Database credential changed; refresh and retry', 409);
    }
    const expectedConfirmation = `delete-database-credential:${record.id}:${record.revision}`;
    if (confirmation !== expectedConfirmation) {
      throw new DatabaseCredentialRegistryError('database_credential_confirmation_mismatch', 'Database credential deletion confirmation does not match', 409);
    }
    const binding = await requireBinding(record.databaseBindingId);
    assertBindingMatches(record, binding);
    state.credentials.splice(index, 1);
    await persist();
    return Object.freeze({ id: record.id, databaseBindingId: record.databaseBindingId, deleted: true });
  }

  async function materializeCredential(credentialId, { expectedRevision = null } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(credentialId, 'databaseCredentialId');
    const record = state.credentials.find((candidate) => candidate.id === normalizedId);
    if (!record) throw new DatabaseCredentialRegistryError('database_credential_not_found', 'Database credential not found', 404);
    if (expectedRevision !== null && record.revision !== revision(expectedRevision)) {
      throw new DatabaseCredentialRegistryError('database_credential_revision_conflict', 'Database credential changed; refresh and retry', 409);
    }
    const binding = await requireBinding(record.databaseBindingId);
    assertBindingMatches(record, binding);
    return Object.freeze({
      ...publicCredential(record),
      password: decryptPassword(key, record),
    });
  }

  return Object.freeze({
    init,
    createCredential,
    getCredential,
    getForBinding,
    listCredentials,
    setPrivileges,
    rotatePassword,
    deleteCredential,
    materializeCredential,
  });
}

export const databaseCredentialRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  allowedPrivileges: ALLOWED_PRIVILEGES,
  defaultPrivileges: DEFAULT_PRIVILEGES,
  databaseUserHost: DATABASE_USER_HOST,
  usernameFor,
  privileges,
  normalizePersisted,
  encryptPassword,
  decryptPassword,
});
