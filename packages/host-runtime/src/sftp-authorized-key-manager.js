import { createHash } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { sftpTemplatePolicy } from '@yunpanel/config-templates/sftp';
import { createApplicationIdentity } from './application-identity.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa']);
const MANAGED_HEADER = '# Managed by YunPanel SFTP public keys v1\n';
const DIRECTORY_MODE = 0o755;
const FILE_MODE = 0o644;

export class SftpAuthorizedKeyManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SftpAuthorizedKeyManagerError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function modeOf(value) {
  return Number(value?.mode ?? 0) & 0o777;
}

function normalizeRoot(value) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value)) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_root_invalid', 'SFTP authorized-keys root is invalid');
  }
  const normalized = path.posix.resolve(value);
  if (normalized === '/') {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_root_invalid', 'SFTP authorized-keys root cannot be filesystem root');
  }
  return normalized;
}

function canonicalPublicKey(value) {
  if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_key_invalid', 'Managed SFTP public key is invalid');
  }
  const fields = value.trim().split(/[ \t]+/u);
  if (fields.length !== 2 || !KEY_TYPES.has(fields[0])
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[1])) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_key_invalid', 'Managed SFTP public key is invalid');
  }
  const blob = Buffer.from(fields[1], 'base64');
  if (blob.length < 16 || blob.toString('base64').replace(/=+$/u, '') !== fields[1].replace(/=+$/u, '')) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_key_invalid', 'Managed SFTP public key payload is invalid');
  }
  return Object.freeze({
    keyType: fields[0],
    publicKey: `${fields[0]} ${blob.toString('base64')}`,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`,
  });
}

function normalizeKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !['id', 'publicKey', 'fingerprint', 'revision'].includes(field))
    || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id)
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_key_invalid', 'Managed SFTP key metadata is invalid');
  }
  const parsed = canonicalPublicKey(value.publicKey);
  if (value.fingerprint !== parsed.fingerprint) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_key_fingerprint_mismatch', 'Managed SFTP key fingerprint does not match its public key');
  }
  return Object.freeze({
    id: value.id.toLowerCase(),
    publicKey: parsed.publicKey,
    fingerprint: parsed.fingerprint,
    revision: value.revision,
  });
}

function normalizeIntent(value, authorizedKeysRoot) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !['websiteId', 'applicationId', 'unixUser', 'keys'].includes(field))
    || typeof value.websiteId !== 'string' || !UUID_PATTERN.test(value.websiteId)
    || !Array.isArray(value.keys)) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_intent_invalid', 'SFTP authorized-keys intent is invalid');
  }
  let identity;
  try { identity = createApplicationIdentity(value.applicationId); }
  catch { throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_application_invalid', 'SFTP authorized-keys Application identity is invalid'); }
  if (value.unixUser !== identity.unixUser) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_identity_mismatch', 'SFTP authorized-keys Unix identity does not match the Application');
  }
  const keys = value.keys.map(normalizeKey)
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint) || left.id.localeCompare(right.id));
  if (new Set(keys.map((entry) => entry.id)).size !== keys.length
    || new Set(keys.map((entry) => entry.fingerprint)).size !== keys.length) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_duplicate', 'SFTP authorized-keys intent contains duplicate keys');
  }
  const root = normalizeRoot(authorizedKeysRoot);
  const target = path.posix.join(root, identity.unixUser);
  if (path.posix.dirname(target) !== root) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_path_escape', 'SFTP authorized-keys path escaped its managed root');
  }
  const content = `${MANAGED_HEADER}${keys.map((entry) => entry.publicKey).join('\n')}${keys.length > 0 ? '\n' : ''}`;
  return Object.freeze({
    websiteId: value.websiteId.toLowerCase(),
    applicationId: identity.applicationId,
    unixUser: identity.unixUser,
    keys: Object.freeze(keys),
    root,
    target,
    content,
    checksum: sha256(content),
  });
}

function missing(error) {
  return error?.code === 'ENOENT';
}

function evidence(spec) {
  return Object.freeze({
    satisfied: true,
    adapter: 'openssh-authorized-keys',
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    unixUser: spec.unixUser,
    authorizedKeysPath: spec.target,
    keyCount: spec.keys.length,
    sha256: spec.checksum,
  });
}

export function createSftpAuthorizedKeyManager({
  authorizedKeysRoot = sftpTemplatePolicy.authorizedKeysRoot,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
  chownFn = chown,
  chmodFn = chmod,
} = {}) {
  if ([lstatFn, mkdirFn, readFileFn, renameFn, rmFn, writeFileFn, chownFn, chmodFn]
    .some((entry) => typeof entry !== 'function')) {
    throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_dependencies_invalid', 'SFTP authorized-keys manager dependencies are invalid');
  }
  const managedRoot = normalizeRoot(authorizedKeysRoot);

  async function optionalStat(target) {
    try { return await lstatFn(target); }
    catch (error) {
      if (missing(error)) return null;
      throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_inspection_failed', 'SFTP authorized-keys metadata could not be inspected');
    }
  }

  async function optionalRead(target) {
    try { return await readFileFn(target, 'utf8'); }
    catch (error) {
      if (missing(error)) return null;
      throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_read_failed', 'SFTP authorized-keys file could not be read');
    }
  }

  function assertRootDirectory(info) {
    if (!info?.isDirectory?.() || info.isSymbolicLink?.() || info.uid !== 0 || info.gid !== 0 || modeOf(info) !== DIRECTORY_MODE) {
      throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_root_drift', 'SFTP authorized-keys root ownership or mode drifted');
    }
  }

  function assertManagedFile(info) {
    if (!info?.isFile?.() || info.isSymbolicLink?.() || info.uid !== 0 || info.gid !== 0 || modeOf(info) !== FILE_MODE) {
      throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_file_drift', 'SFTP authorized-keys file ownership or mode drifted');
    }
  }

  async function inspect(rawIntent) {
    const spec = normalizeIntent(rawIntent, managedRoot);
    const rootInfo = await optionalStat(spec.root);
    if (!rootInfo) return Object.freeze({ satisfied: false, reason: 'sftp_authorized_keys_root_missing' });
    assertRootDirectory(rootInfo);

    const fileInfo = await optionalStat(spec.target);
    if (!fileInfo) return Object.freeze({ satisfied: false, reason: 'sftp_authorized_keys_file_missing' });
    assertManagedFile(fileInfo);
    const current = await optionalRead(spec.target);
    if (current === null) return Object.freeze({ satisfied: false, reason: 'sftp_authorized_keys_file_missing' });
    if (!current.startsWith(MANAGED_HEADER)) {
      throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_unmanaged_conflict', 'Existing authorized-keys file is not owned by YunPanel');
    }
    if (current !== spec.content) {
      return Object.freeze({
        satisfied: false,
        reason: 'sftp_authorized_keys_outdated',
        currentSha256: sha256(current),
        desiredSha256: spec.checksum,
      });
    }
    return evidence(spec);
  }

  async function ensureRoot(spec) {
    const existing = await optionalStat(spec.root);
    if (existing) {
      assertRootDirectory(existing);
      return;
    }
    try {
      await mkdirFn(spec.root, { recursive: true, mode: DIRECTORY_MODE });
      await chownFn(spec.root, 0, 0);
      await chmodFn(spec.root, DIRECTORY_MODE);
    } catch {
      throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_root_prepare_failed', 'SFTP authorized-keys root could not be prepared');
    }
    const verified = await optionalStat(spec.root);
    if (!verified) throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_root_prepare_failed', 'SFTP authorized-keys root was not created');
    assertRootDirectory(verified);
  }

  async function atomicWrite(spec) {
    const temporary = path.posix.join(spec.root, `.${spec.unixUser}.${process.pid}.tmp`);
    await rmFn(temporary, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporary, spec.content, { encoding: 'utf8', mode: 0o600 });
      await chownFn(temporary, 0, 0);
      await chmodFn(temporary, FILE_MODE);
      await renameFn(temporary, spec.target);
    } catch {
      throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_write_failed', 'SFTP authorized-keys file could not be materialized');
    } finally {
      await rmFn(temporary, { force: true }).catch(() => {});
    }
  }

  async function apply(rawIntent) {
    const spec = normalizeIntent(rawIntent, managedRoot);
    await ensureRoot(spec);
    const existingInfo = await optionalStat(spec.target);
    if (existingInfo) {
      assertManagedFile(existingInfo);
      const current = await optionalRead(spec.target);
      if (current === null) {
        throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_read_failed', 'SFTP authorized-keys file could not be read');
      }
      if (!current.startsWith(MANAGED_HEADER)) {
        throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_unmanaged_conflict', 'Existing authorized-keys file is not owned by YunPanel');
      }
      if (current === spec.content) return evidence(spec);
    }

    await atomicWrite(spec);
    const verified = await inspect(rawIntent);
    if (!verified?.satisfied) {
      throw new SftpAuthorizedKeyManagerError('sftp_authorized_keys_unverified', 'SFTP authorized-keys file could not be verified after materialization');
    }
    return verified;
  }

  return Object.freeze({ inspect, apply });
}

export const sftpAuthorizedKeyManagerInternals = Object.freeze({
  keyTypes: Object.freeze([...KEY_TYPES]),
  managedHeader: MANAGED_HEADER,
  directoryMode: DIRECTORY_MODE,
  fileMode: FILE_MODE,
  normalizeRoot,
  canonicalPublicKey,
  normalizeIntent,
  evidence,
});
