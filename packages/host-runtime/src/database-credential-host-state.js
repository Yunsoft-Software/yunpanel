import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/control-plane/database-credential-host-state';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const USERNAME_PATTERN = /^ydb_[a-f0-9]{24}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DatabaseCredentialHostStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseCredentialHostStateError';
    this.code = code;
  }
}

function normalize(value) {
  const keys = [
    'version', 'databaseCredentialId', 'databaseBindingId', 'databaseName', 'username', 'host',
    'credentialRevision', 'bindingRevision', 'desiredStateSha256', 'appliedAt',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || value.version !== STORE_VERSION
    || typeof value.databaseCredentialId !== 'string' || !UUID_PATTERN.test(value.databaseCredentialId)
    || typeof value.databaseBindingId !== 'string' || !UUID_PATTERN.test(value.databaseBindingId)
    || typeof value.databaseName !== 'string' || !DATABASE_NAME_PATTERN.test(value.databaseName)
    || typeof value.username !== 'string' || !USERNAME_PATTERN.test(value.username)
    || value.host !== 'localhost'
    || !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1
    || !Number.isSafeInteger(value.bindingRevision) || value.bindingRevision < 1
    || typeof value.desiredStateSha256 !== 'string' || !SHA256_PATTERN.test(value.desiredStateSha256)
    || typeof value.appliedAt !== 'string' || !Number.isFinite(Date.parse(value.appliedAt))) {
    throw new DatabaseCredentialHostStateError('database_credential_host_state_invalid', 'Database credential host state is invalid');
  }
  return Object.freeze({
    ...value,
    databaseCredentialId: value.databaseCredentialId.toLowerCase(),
    databaseBindingId: value.databaseBindingId.toLowerCase(),
    appliedAt: new Date(value.appliedAt).toISOString(),
  });
}

export function createDatabaseCredentialHostStateStore({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || typeof now !== 'function') {
    throw new DatabaseCredentialHostStateError('database_credential_host_state_root_invalid', 'Database credential host-state root is invalid');
  }

  function markerPath(databaseCredentialId) {
    if (typeof databaseCredentialId !== 'string' || !UUID_PATTERN.test(databaseCredentialId)) {
      throw new DatabaseCredentialHostStateError('database_credential_host_state_identity_invalid', 'Database credential identity is invalid');
    }
    return path.join(root, `${databaseCredentialId.toLowerCase()}.json`);
  }

  async function read(databaseCredentialId) {
    const target = markerPath(databaseCredentialId);
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
        throw new DatabaseCredentialHostStateError('database_credential_host_state_unsafe', 'Database credential host-state marker is unsafe');
      }
      return normalize(JSON.parse(await readFile(target, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof DatabaseCredentialHostStateError) throw error;
      throw new DatabaseCredentialHostStateError('database_credential_host_state_read_failed', 'Database credential host-state marker could not be read');
    }
  }

  async function write(input) {
    const value = normalize({ ...input, version: STORE_VERSION, appliedAt: new Date(now()).toISOString() });
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const target = markerPath(value.databaseCredentialId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
    return value;
  }

  async function remove(databaseCredentialId) {
    const target = markerPath(databaseCredentialId);
    await rm(target, { force: true });
    return Object.freeze({ databaseCredentialId: databaseCredentialId.toLowerCase(), removed: true });
  }

  return Object.freeze({ read, write, remove, markerPath });
}

export const databaseCredentialHostStateInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalize,
});
