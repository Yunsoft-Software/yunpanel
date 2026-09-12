import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const DES_KEY_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export class RoundcubeSecretRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RoundcubeSecretRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field = 'serverId') {
  try { return assertUuid(value, field); }
  catch { throw new RoundcubeSecretRegistryError('invalid_roundcube_server_id', 'Roundcube server ID is invalid'); }
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length === 24
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateRecord(value) {
  const fields = new Set(['serverId', 'desKey', 'revision', 'createdAt', 'updatedAt']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !DES_KEY_PATTERN.test(value.desKey ?? '')
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) {
    throw new RoundcubeSecretRegistryError('roundcube_secret_state_invalid', 'Persisted Roundcube secret state is invalid', 409);
  }
  return Object.freeze({
    serverId: uuid(value.serverId),
    desKey: value.desKey,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
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

export function createRoundcubeSecretRegistry({
  filePath = null,
  now = () => Date.now(),
  serverExists = async () => true,
  randomBytesFn = randomBytes,
} = {}) {
  if (typeof now !== 'function' || typeof serverExists !== 'function' || typeof randomBytesFn !== 'function') {
    throw new RoundcubeSecretRegistryError('roundcube_secret_dependencies_invalid', 'Roundcube secret dependencies are unavailable', 503);
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
          throw new RoundcubeSecretRegistryError('roundcube_secret_state_invalid', 'Roundcube secret store is invalid', 409);
        }
        const records = parsed.records.map(validateRecord);
        if (new Set(records.map((record) => record.serverId)).size !== records.length) {
          throw new RoundcubeSecretRegistryError('roundcube_secret_state_invalid', 'Roundcube secret records are not unique', 409);
        }
        for (const record of records) {
          if (!(await serverExists(record.serverId))) {
            throw new RoundcubeSecretRegistryError('roundcube_secret_state_invalid', 'Roundcube secret references a missing server', 409);
          }
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
    if (!(await serverExists(id))) {
      throw new RoundcubeSecretRegistryError('roundcube_server_not_found', 'Roundcube server was not found', 404);
    }
    return id;
  }

  function generateDesKey() {
    const value = randomBytesFn(18).toString('base64url');
    if (!DES_KEY_PATTERN.test(value)) {
      throw new RoundcubeSecretRegistryError('roundcube_secret_generation_failed', 'Roundcube secret could not be generated safely', 503);
    }
    return value;
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
    const timestamp = new Date(now()).toISOString();
    const record = {
      serverId: id,
      desKey: generateDesKey(),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.records.push(record);
    await persist();
    return publicRecord(record);
  }

  async function materializeForServer(serverId) {
    await ensureInitialized();
    const id = uuid(serverId);
    const record = state.records.find((candidate) => candidate.serverId === id);
    if (!record) {
      throw new RoundcubeSecretRegistryError('roundcube_secret_required', 'Roundcube private secret is not configured', 409);
    }
    return Object.freeze({
      serverId: record.serverId,
      desKey: record.desKey,
      revision: record.revision,
    });
  }

  async function rotateForServer(serverId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const id = await requireServer(serverId);
    const index = state.records.findIndex((record) => record.serverId === id);
    if (index < 0) throw new RoundcubeSecretRegistryError('roundcube_secret_required', 'Roundcube private secret is not configured', 409);
    const current = state.records[index];
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision
      || confirmation !== `rotate-roundcube-secret:${id}:${current.revision}`) {
      throw new RoundcubeSecretRegistryError(
        'roundcube_secret_confirmation_invalid',
        'Roundcube secret rotation confirmation is invalid or stale',
        409,
      );
    }
    const next = {
      ...current,
      desKey: generateDesKey(),
      revision: current.revision + 1,
      updatedAt: new Date(now()).toISOString(),
    };
    state.records[index] = next;
    await persist();
    return publicRecord(next);
  }

  return Object.freeze({
    init,
    getForServer,
    ensureForServer,
    materializeForServer,
    rotateForServer,
  });
}

export const roundcubeSecretRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  desKeyPattern: DES_KEY_PATTERN,
  validateRecord,
  publicRecord,
});