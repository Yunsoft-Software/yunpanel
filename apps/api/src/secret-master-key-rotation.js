import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';
import { rewrapDnsProviderCredentialSnapshot } from './dns-provider-credential-registry.js';
import { createMfaVault } from './mfa-crypto.js';

const ENV_STORE_VERSIONS = new Set([1, 2]);
const ENV_ALGORITHM = 'aes-256-gcm';
const MANIFEST_VERSION = 2;
const MFA_TABLES = ['auth_mfa', 'auth_mfa_pending'];
const AUTH_BACKUP_NAME = 'auth.sqlite';
const ENVIRONMENT_BACKUP_NAME = 'application-environment-registry.json';
const DNS_PROVIDER_BACKUP_NAME = 'dns-provider-credential-registry.json';

export class SecretMasterKeyRotationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretMasterKeyRotationError';
    this.code = code;
  }
}

function rotationError(code, message) {
  return new SecretMasterKeyRotationError(code, message);
}

function rootKey(value, label) {
  const key = normalizeEnvironmentMasterKey(value);
  if (!key) throw rotationError('secret_master_key_required', `${label} master key is required`);
  // MFA intentionally accepts only the exact 32-byte root key formats too. Constructing
  // the vault here ensures a key rotated for application secrets can also unlock MFA.
  createMfaVault(key);
  return key;
}

function assertDifferentKeys(currentKey, nextKey) {
  if (currentKey.equals(nextKey)) throw rotationError('secret_master_key_unchanged', 'The next master key must differ from the current key');
}

function decryptEnvironmentSecret(masterKey, record) {
  try {
    if (!record || typeof record.applicationId !== 'string' || typeof record.key !== 'string') throw new Error('invalid record');
    const iv = Buffer.from(record.iv ?? '', 'base64');
    const tag = Buffer.from(record.tag ?? '', 'base64');
    if (iv.length !== 12 || tag.length !== 16 || typeof record.ciphertext !== 'string') throw new Error('invalid envelope');
    const decipher = createDecipheriv(ENV_ALGORITHM, masterKey, iv);
    decipher.setAAD(Buffer.from(`${record.applicationId}:${record.key}`, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw rotationError('application_secret_decryption_failed', `Application secret ${record?.applicationId ?? 'unknown'}:${record?.key ?? 'unknown'} cannot be decrypted with the current key`);
  }
}

function encryptEnvironmentSecret(masterKey, record, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENV_ALGORITHM, masterKey, iv);
  cipher.setAAD(Buffer.from(`${record.applicationId}:${record.key}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ...record,
    value: null,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function rewrapApplicationEnvironmentSnapshot(snapshot, { currentMasterKey, nextMasterKey }) {
  const currentKey = rootKey(currentMasterKey, 'Current');
  const nextKey = rootKey(nextMasterKey, 'Next');
  assertDifferentKeys(currentKey, nextKey);
  if (!snapshot || !ENV_STORE_VERSIONS.has(snapshot.version) || !Array.isArray(snapshot.variables)) {
    throw rotationError('invalid_application_environment_store', 'Application environment store is invalid or unsupported');
  }
  return {
    ...snapshot,
    variables: snapshot.variables.map((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw rotationError('invalid_application_environment_store', 'Application environment store contains an invalid record');
      }
      if (record.secret !== true) return { ...record };
      const value = decryptEnvironmentSecret(currentKey, record);
      return encryptEnvironmentSecret(nextKey, record, value);
    }),
  };
}

export function rewrapMfaEnvelope(userId, envelope, { currentMasterKey, nextMasterKey }) {
  if (typeof userId !== 'string' || !userId) throw rotationError('invalid_mfa_record', 'MFA record is missing a user id');
  const currentKey = rootKey(currentMasterKey, 'Current');
  const nextKey = rootKey(nextMasterKey, 'Next');
  assertDifferentKeys(currentKey, nextKey);
  const currentVault = createMfaVault(currentKey);
  const nextVault = createMfaVault(nextKey);
  try {
    return nextVault.encrypt(userId, currentVault.decrypt(userId, envelope));
  } catch (error) {
    if (error instanceof SecretMasterKeyRotationError) throw error;
    throw rotationError('mfa_secret_decryption_failed', `MFA secret for user ${userId} cannot be decrypted with the current key`);
  }
}

async function fileMetadata(filePath, { optional = false } = {}) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile()) throw rotationError('unsafe_rotation_path', `${filePath} must be a regular file`);
    return metadata;
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function privateWrite(filePath, content, { exclusive = false } = {}) {
  const handle = await open(filePath, exclusive ? 'wx' : 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.rotation-${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await privateWrite(temporaryPath, content, { exclusive: true });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function readMfaRows(db, table) {
  if (!MFA_TABLES.includes(table)) throw new Error('Unsupported MFA table');
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT user_id, secret FROM ${table} ORDER BY user_id`).all().map((row) => ({ userId: row.user_id, secret: row.secret }));
}

function sameRows(left, right) {
  return left.length === right.length && left.every((row, index) => row.userId === right[index]?.userId && row.secret === right[index]?.secret);
}

function rewrapMfaRows(rows, currentMasterKey, nextMasterKey) {
  return rows.map((row) => ({
    ...row,
    nextSecret: rewrapMfaEnvelope(row.userId, row.secret, { currentMasterKey, nextMasterKey }),
  }));
}

function updateMfaRows(db, table, rows) {
  if (!rows.length) return;
  const statement = db.prepare(`UPDATE ${table} SET secret = ? WHERE user_id = ? AND secret = ?`);
  for (const row of rows) {
    if (statement.run(row.nextSecret, row.userId, row.secret).changes !== 1) {
      throw rotationError('concurrent_auth_change', `MFA state changed while rotating ${table}`);
    }
  }
}

function safeManifestError(error) {
  return error?.code && typeof error.code === 'string' ? error.code : 'rotation_failed';
}

async function writeManifest(backupDirectory, manifest) {
  await atomicWrite(path.join(backupDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function restoreFileFromBackup(backupPath, targetPath) {
  const temporaryPath = `${targetPath}.rollback-${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await copyFile(backupPath, temporaryPath);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Offline, rollback-capable rotation across every persisted secret surface that consumes
 * YUNPANEL_SECRET_MASTER_KEY. The caller must keep the API stopped for the whole call.
 */
export async function rotateSecretMasterKey({
  authDbPath,
  applicationEnvironmentStorePath,
  dnsProviderCredentialStorePath = null,
  currentMasterKey,
  nextMasterKey,
  backupDirectory,
  now = Date.now,
} = {}) {
  if (![authDbPath, applicationEnvironmentStorePath, backupDirectory].every((value) => typeof value === 'string' && value)) {
    throw rotationError('rotation_paths_required', 'Auth DB, application environment store and backup directory paths are required');
  }
  const authPath = path.resolve(authDbPath);
  const environmentPath = path.resolve(applicationEnvironmentStorePath);
  const dnsProviderPath = typeof dnsProviderCredentialStorePath === 'string' && dnsProviderCredentialStorePath
    ? path.resolve(dnsProviderCredentialStorePath)
    : null;
  const backupPath = path.resolve(backupDirectory);
  const currentKey = rootKey(currentMasterKey, 'Current');
  const nextKey = rootKey(nextMasterKey, 'Next');
  assertDifferentKeys(currentKey, nextKey);

  await fileMetadata(authPath);
  const environmentMetadata = await fileMetadata(environmentPath, { optional: true });
  const dnsProviderMetadata = dnsProviderPath ? await fileMetadata(dnsProviderPath, { optional: true }) : null;
  await mkdir(backupPath, { mode: 0o700 });
  await chmod(backupPath, 0o700);

  const backupAuthPath = path.join(backupPath, AUTH_BACKUP_NAME);
  const backupEnvironmentPath = path.join(backupPath, ENVIRONMENT_BACKUP_NAME);
  const backupDnsProviderPath = path.join(backupPath, DNS_PROVIDER_BACKUP_NAME);
  const db = new DatabaseSync(authPath);
  db.exec('PRAGMA busy_timeout = 1500; PRAGMA foreign_keys = ON;');
  let transactionOpen = false;
  let environmentReplaced = false;
  let dnsProviderReplaced = false;
  let manifest = {
    version: MANIFEST_VERSION,
    status: 'preparing',
    createdAt: new Date(now()).toISOString(),
    sources: {
      authDbPath: authPath,
      applicationEnvironmentStorePath: environmentPath,
      dnsProviderCredentialStorePath: dnsProviderPath,
    },
    backups: {
      authDb: AUTH_BACKUP_NAME,
      applicationEnvironmentStore: environmentMetadata ? ENVIRONMENT_BACKUP_NAME : null,
      dnsProviderCredentialStore: dnsProviderMetadata ? DNS_PROVIDER_BACKUP_NAME : null,
    },
    backupHashes: {},
    counts: { mfa: 0, mfaPending: 0, applicationSecrets: 0, dnsProviderSecrets: 0 },
  };

  try {
    await backup(db, backupAuthPath);
    await chmod(backupAuthPath, 0o600);
    manifest.backupHashes.authDb = await sha256File(backupAuthPath);
    if (environmentMetadata) {
      await copyFile(environmentPath, backupEnvironmentPath);
      await chmod(backupEnvironmentPath, 0o600);
      manifest.backupHashes.applicationEnvironmentStore = await sha256File(backupEnvironmentPath);
    }
    if (dnsProviderMetadata) {
      await copyFile(dnsProviderPath, backupDnsProviderPath);
      await chmod(backupDnsProviderPath, 0o600);
      manifest.backupHashes.dnsProviderCredentialStore = await sha256File(backupDnsProviderPath);
    }

    const environmentText = environmentMetadata ? await readFile(environmentPath, 'utf8') : null;
    let nextEnvironmentText = null;
    if (environmentText !== null) {
      let snapshot;
      try { snapshot = JSON.parse(environmentText); }
      catch { throw rotationError('invalid_application_environment_store', 'Application environment store is not valid JSON'); }
      const nextSnapshot = rewrapApplicationEnvironmentSnapshot(snapshot, { currentMasterKey: currentKey, nextMasterKey: nextKey });
      manifest.counts.applicationSecrets = snapshot.variables.filter((record) => record?.secret === true).length;
      nextEnvironmentText = `${JSON.stringify(nextSnapshot, null, 2)}\n`;
    }
    const dnsProviderText = dnsProviderMetadata ? await readFile(dnsProviderPath, 'utf8') : null;
    let nextDnsProviderText = null;
    if (dnsProviderText !== null) {
      let snapshot;
      try { snapshot = JSON.parse(dnsProviderText); }
      catch { throw rotationError('invalid_dns_provider_credential_store', 'DNS provider credential store is not valid JSON'); }
      let nextSnapshot;
      try {
        nextSnapshot = rewrapDnsProviderCredentialSnapshot(snapshot, {
          currentMasterKey: currentKey,
          nextMasterKey: nextKey,
        });
      } catch {
        throw rotationError('dns_provider_secret_decryption_failed', 'DNS provider credentials cannot be decrypted with the current key');
      }
      manifest.counts.dnsProviderSecrets = snapshot.credentials.length;
      nextDnsProviderText = `${JSON.stringify(nextSnapshot, null, 2)}\n`;
    }

    const activeRows = readMfaRows(db, 'auth_mfa');
    const pendingRows = readMfaRows(db, 'auth_mfa_pending');
    const nextActiveRows = rewrapMfaRows(activeRows, currentKey, nextKey);
    const nextPendingRows = rewrapMfaRows(pendingRows, currentKey, nextKey);
    manifest.counts.mfa = activeRows.length;
    manifest.counts.mfaPending = pendingRows.length;
    manifest.status = 'prepared';
    await writeManifest(backupPath, manifest);

    db.exec('BEGIN EXCLUSIVE');
    transactionOpen = true;
    if (!sameRows(activeRows, readMfaRows(db, 'auth_mfa')) || !sameRows(pendingRows, readMfaRows(db, 'auth_mfa_pending'))) {
      throw rotationError('concurrent_auth_change', 'MFA state changed after rotation preflight');
    }
    if (environmentText !== null && await readFile(environmentPath, 'utf8') !== environmentText) {
      throw rotationError('concurrent_environment_change', 'Application environment state changed after rotation preflight');
    }
    if (dnsProviderText !== null && await readFile(dnsProviderPath, 'utf8') !== dnsProviderText) {
      throw rotationError('concurrent_dns_provider_change', 'DNS provider credential state changed after rotation preflight');
    }

    updateMfaRows(db, 'auth_mfa', nextActiveRows);
    updateMfaRows(db, 'auth_mfa_pending', nextPendingRows);
    if (tableExists(db, 'auth_events')) {
      db.prepare('INSERT INTO auth_events(actor_id, action, created_at) VALUES (NULL, ?, ?)').run('secret_master_key.rotated', now());
    }
    if (nextEnvironmentText !== null) {
      await atomicWrite(environmentPath, nextEnvironmentText);
      environmentReplaced = true;
    }
    if (nextDnsProviderText !== null) {
      await atomicWrite(dnsProviderPath, nextDnsProviderText);
      dnsProviderReplaced = true;
    }
    db.exec('COMMIT');
    transactionOpen = false;
    manifest = { ...manifest, status: 'applied', appliedAt: new Date(now()).toISOString() };
    await writeManifest(backupPath, manifest);
    return manifest;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch {}
      transactionOpen = false;
    }
    if (environmentReplaced && environmentMetadata) {
      try { await restoreFileFromBackup(backupEnvironmentPath, environmentPath); environmentReplaced = false; }
      catch { /* Preserve the original error; manifest and backups remain for explicit rollback. */ }
    }
    if (dnsProviderReplaced && dnsProviderMetadata) {
      try { await restoreFileFromBackup(backupDnsProviderPath, dnsProviderPath); dnsProviderReplaced = false; }
      catch { /* Preserve the original error; manifest and backups remain for explicit rollback. */ }
    }
    manifest = {
      ...manifest,
      status: environmentReplaced || dnsProviderReplaced ? 'rollback_required' : 'failed',
      failedAt: new Date(now()).toISOString(),
      error: safeManifestError(error),
    };
    await writeManifest(backupPath, manifest).catch(() => {});
    throw error;
  } finally {
    db.close();
  }
}

export async function rollbackSecretMasterKey({
  authDbPath,
  applicationEnvironmentStorePath,
  dnsProviderCredentialStorePath = null,
  backupDirectory,
  now = Date.now,
} = {}) {
  if (![authDbPath, applicationEnvironmentStorePath, backupDirectory].every((value) => typeof value === 'string' && value)) {
    throw rotationError('rotation_paths_required', 'Auth DB, application environment store and backup directory paths are required');
  }
  const authPath = path.resolve(authDbPath);
  const environmentPath = path.resolve(applicationEnvironmentStorePath);
  const dnsProviderPath = typeof dnsProviderCredentialStorePath === 'string' && dnsProviderCredentialStorePath
    ? path.resolve(dnsProviderCredentialStorePath)
    : null;
  const backupPath = path.resolve(backupDirectory);
  const manifestPath = path.join(backupPath, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw rotationError('invalid_rotation_manifest', 'Rotation manifest is missing or invalid'); }
  if (![1, MANIFEST_VERSION].includes(manifest?.version) || typeof manifest.sources?.authDbPath !== 'string'
    || typeof manifest.sources?.applicationEnvironmentStorePath !== 'string') {
    throw rotationError('invalid_rotation_manifest', 'Rotation manifest is unsupported');
  }
  if (path.resolve(manifest.sources.authDbPath) !== authPath || path.resolve(manifest.sources.applicationEnvironmentStorePath) !== environmentPath) {
    throw rotationError('rotation_target_mismatch', 'Rotation manifest does not belong to the requested store paths');
  }
  if (manifest.version === MANIFEST_VERSION
    && (manifest.sources.dnsProviderCredentialStorePath === null
      ? dnsProviderPath !== null
      : !dnsProviderPath || path.resolve(manifest.sources.dnsProviderCredentialStorePath) !== dnsProviderPath)) {
    throw rotationError('rotation_target_mismatch', 'Rotation manifest does not belong to the requested DNS provider store path');
  }
  if (manifest.backups?.authDb !== AUTH_BACKUP_NAME || ![null, ENVIRONMENT_BACKUP_NAME].includes(manifest.backups?.applicationEnvironmentStore)) {
    throw rotationError('invalid_rotation_manifest', 'Rotation manifest contains unsupported backup paths');
  }
  if (manifest.version === MANIFEST_VERSION
    && ![null, DNS_PROVIDER_BACKUP_NAME].includes(manifest.backups?.dnsProviderCredentialStore)) {
    throw rotationError('invalid_rotation_manifest', 'Rotation manifest contains an unsupported DNS provider backup path');
  }

  const backupAuthPath = path.join(backupPath, AUTH_BACKUP_NAME);
  if (await sha256File(backupAuthPath) !== manifest.backupHashes?.authDb) {
    throw rotationError('rotation_backup_tampered', 'Auth database backup does not match the rotation manifest');
  }
  await fileMetadata(backupAuthPath);

  let backupDnsProviderPath = null;
  if (manifest.version === MANIFEST_VERSION && manifest.backups.dnsProviderCredentialStore === DNS_PROVIDER_BACKUP_NAME) {
    backupDnsProviderPath = path.join(backupPath, DNS_PROVIDER_BACKUP_NAME);
    if (await sha256File(backupDnsProviderPath) !== manifest.backupHashes?.dnsProviderCredentialStore) {
      throw rotationError('rotation_backup_tampered', 'DNS provider credential backup does not match the rotation manifest');
    }
    await fileMetadata(backupDnsProviderPath);
  }

  if (manifest.backups.applicationEnvironmentStore === ENVIRONMENT_BACKUP_NAME) {
    const backupEnvironmentPath = path.join(backupPath, ENVIRONMENT_BACKUP_NAME);
    if (await sha256File(backupEnvironmentPath) !== manifest.backupHashes?.applicationEnvironmentStore) {
      throw rotationError('rotation_backup_tampered', 'Application environment backup does not match the rotation manifest');
    }
    await fileMetadata(backupEnvironmentPath);
    await restoreFileFromBackup(backupEnvironmentPath, environmentPath);
  } else {
    // If the store did not exist before rotation, remove any post-rotation copy so the
    // restored old root key cannot encounter data created under the new root key.
    await rm(environmentPath, { force: true });
  }

  if (backupDnsProviderPath) {
    await restoreFileFromBackup(backupDnsProviderPath, dnsProviderPath);
  } else if (manifest.version === MANIFEST_VERSION && dnsProviderPath) {
    await rm(dnsProviderPath, { force: true });
  }

  // The service must be stopped. Removing sidecar WAL/SHM files prevents pages from the
  // post-rotation database from being replayed onto the restored snapshot.
  await rm(`${authPath}-wal`, { force: true });
  await rm(`${authPath}-shm`, { force: true });
  await restoreFileFromBackup(backupAuthPath, authPath);
  manifest = { ...manifest, status: 'rolled_back', rolledBackAt: new Date(now()).toISOString() };
  await writeManifest(backupPath, manifest);
  return manifest;
}
