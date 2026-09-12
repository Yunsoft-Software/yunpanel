import { createHash, randomBytes } from 'node:crypto';
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
import {
  roundcubeFpmTemplatePolicy,
  roundcubeNginxTemplatePolicy,
  roundcubeTemplatePolicy,
} from '@yunpanel/config-templates';

const TRANSACTION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MANIFEST_VERSION = 2;
const BACKUP_ROOT_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;

export class RoundcubeConfigBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoundcubeConfigBackupError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function transactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_PATTERN.test(value)) {
    throw new RoundcubeConfigBackupError('roundcube_backup_transaction_invalid', 'Roundcube backup transaction ID is invalid');
  }
  return value.toLowerCase();
}

export function createRoundcubeConfigBackupManager({
  backupRoot = '/var/lib/yunpanel/backups/roundcube',
  configPath = roundcubeTemplatePolicy.configPath,
  fpmPoolPath = roundcubeFpmTemplatePolicy.poolPath,
  nginxConfigPath = roundcubeNginxTemplatePolicy.configPath,
  databasePath = roundcubeTemplatePolicy.databasePath,
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (typeof backupRoot !== 'string' || !path.isAbsolute(backupRoot) || backupRoot === path.parse(backupRoot).root) {
    throw new RoundcubeConfigBackupError('roundcube_backup_root_invalid', 'Roundcube backup root is invalid');
  }
  const resolvedRoot = path.resolve(backupRoot);

  function transactionDirectory(id) {
    return path.join(resolvedRoot, transactionId(id));
  }

  async function ensurePrivateDirectory(directory) {
    try {
      const metadata = await lstatFn(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new RoundcubeConfigBackupError('roundcube_backup_directory_unsafe', 'Roundcube backup directory is unsafe');
      }
      await mkdirFn(directory, { recursive: true, mode: BACKUP_ROOT_MODE });
      const created = await lstatFn(directory);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new RoundcubeConfigBackupError('roundcube_backup_directory_unsafe', 'Roundcube backup directory is unsafe');
      }
    }
    await chmodFn(directory, BACKUP_ROOT_MODE);
  }

  async function inspectTarget(targetPath, backupName) {
    let metadata;
    try { metadata = await lstatFn(targetPath); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ targetPath, exists: false, backupName: null });
      throw new RoundcubeConfigBackupError('roundcube_backup_inspection_failed', 'Roundcube live configuration could not be inspected');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CONFIG_BYTES) {
      throw new RoundcubeConfigBackupError('roundcube_backup_target_unsafe', 'Roundcube live configuration target is unsafe');
    }
    const content = await readFileFn(targetPath);
    if (content.length !== metadata.size) {
      throw new RoundcubeConfigBackupError('roundcube_backup_target_changed', 'Roundcube live configuration changed during backup');
    }
    return Object.freeze({
      targetPath,
      exists: true,
      backupName,
      sha256: sha256(content),
      bytes: content.length,
      mode: metadata.mode & 0o7777,
      uid: metadata.uid,
      gid: metadata.gid,
      content,
    });
  }

  async function inspectDatabasePresence() {
    try {
      const metadata = await lstatFn(databasePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new RoundcubeConfigBackupError('roundcube_database_unsafe', 'Roundcube database path is unsafe');
      }
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      if (error instanceof RoundcubeConfigBackupError) throw error;
      throw new RoundcubeConfigBackupError('roundcube_database_inspection_failed', 'Roundcube database could not be inspected');
    }
  }

  async function backupConfiguration(id) {
    const normalizedId = transactionId(id);
    await ensurePrivateDirectory(resolvedRoot);
    const directory = transactionDirectory(normalizedId);
    try {
      await lstatFn(directory);
      throw new RoundcubeConfigBackupError('roundcube_backup_exists', 'Roundcube backup transaction already exists');
    } catch (error) {
      if (error instanceof RoundcubeConfigBackupError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new RoundcubeConfigBackupError('roundcube_backup_directory_unsafe', 'Roundcube backup transaction path is unsafe');
      }
    }
    await mkdirFn(directory, { mode: BACKUP_ROOT_MODE });
    await chmodFn(directory, BACKUP_ROOT_MODE);
    try {
      const [config, fpm, nginx, databaseExisted] = await Promise.all([
        inspectTarget(configPath, 'config.inc.php'),
        inspectTarget(fpmPoolPath, 'yunpanel-roundcube-fpm.conf'),
        inspectTarget(nginxConfigPath, 'yunpanel-roundcube-nginx.conf'),
        inspectDatabasePresence(),
      ]);
      for (const record of [config, fpm, nginx]) {
        if (!record.exists) continue;
        const backupPath = path.join(directory, record.backupName);
        await writeFileFn(backupPath, record.content, { mode: BACKUP_FILE_MODE, flag: 'wx' });
        await chmodFn(backupPath, BACKUP_FILE_MODE);
      }
      const publicRecord = (record) => record.exists ? Object.freeze({
        targetPath: record.targetPath,
        exists: true,
        backupName: record.backupName,
        sha256: record.sha256,
        bytes: record.bytes,
        mode: record.mode,
        uid: record.uid,
        gid: record.gid,
      }) : record;
      const manifest = Object.freeze({
        version: MANIFEST_VERSION,
        transactionId: normalizedId,
        databaseExisted,
        files: Object.freeze([publicRecord(config), publicRecord(fpm), publicRecord(nginx)]),
      });
      const manifestPath = path.join(directory, 'manifest.json');
      await writeFileFn(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: BACKUP_FILE_MODE, flag: 'wx' });
      await chmodFn(manifestPath, BACKUP_FILE_MODE);
      return manifest;
    } catch (error) {
      try { await rmFn(directory, { recursive: true, force: true }); } catch {}
      if (error instanceof RoundcubeConfigBackupError) throw error;
      throw new RoundcubeConfigBackupError('roundcube_backup_failed', 'Roundcube configuration backup failed');
    }
  }

  function validateManifest(value, id) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== MANIFEST_VERSION || value.transactionId !== id || typeof value.databaseExisted !== 'boolean'
      || !Array.isArray(value.files) || value.files.length !== 3) {
      throw new RoundcubeConfigBackupError('roundcube_backup_manifest_invalid', 'Roundcube backup manifest is invalid');
    }
    const expectedTargets = [configPath, fpmPoolPath, nginxConfigPath];
    const expectedBackupNames = ['config.inc.php', 'yunpanel-roundcube-fpm.conf', 'yunpanel-roundcube-nginx.conf'];
    const records = value.files.map((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || record.targetPath !== expectedTargets[index] || typeof record.exists !== 'boolean') {
        throw new RoundcubeConfigBackupError('roundcube_backup_manifest_invalid', 'Roundcube backup manifest is invalid');
      }
      if (!record.exists) {
        if (record.backupName !== null) throw new RoundcubeConfigBackupError('roundcube_backup_manifest_invalid', 'Roundcube backup manifest is invalid');
        return Object.freeze({ targetPath: record.targetPath, exists: false, backupName: null });
      }
      if (record.backupName !== expectedBackupNames[index]
        || typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)
        || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > MAX_CONFIG_BYTES
        || !Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o7777
        || !Number.isSafeInteger(record.uid) || record.uid < 0
        || !Number.isSafeInteger(record.gid) || record.gid < 0) {
        throw new RoundcubeConfigBackupError('roundcube_backup_manifest_invalid', 'Roundcube backup manifest is invalid');
      }
      return Object.freeze({ ...record });
    });
    return Object.freeze({
      version: MANIFEST_VERSION,
      transactionId: id,
      databaseExisted: value.databaseExisted,
      files: Object.freeze(records),
    });
  }

  async function loadManifest(id) {
    const normalizedId = transactionId(id);
    const directory = transactionDirectory(normalizedId);
    let manifestBuffer;
    try {
      const manifestPath = path.join(directory, 'manifest.json');
      const metadata = await lstatFn(manifestPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_MANIFEST_BYTES
        || (metadata.mode & 0o7777) !== BACKUP_FILE_MODE) {
        throw new RoundcubeConfigBackupError('roundcube_backup_manifest_invalid', 'Roundcube backup manifest is invalid');
      }
      manifestBuffer = await readFileFn(manifestPath);
    } catch (error) {
      if (error instanceof RoundcubeConfigBackupError) throw error;
      throw new RoundcubeConfigBackupError('roundcube_backup_manifest_unavailable', 'Roundcube backup manifest is unavailable');
    }
    let parsed;
    try { parsed = JSON.parse(manifestBuffer.toString('utf8')); }
    catch { throw new RoundcubeConfigBackupError('roundcube_backup_manifest_invalid', 'Roundcube backup manifest is invalid'); }
    return validateManifest(parsed, normalizedId);
  }

  async function atomicRestore(record, directory) {
    if (!record.exists) {
      await rmFn(record.targetPath, { force: true });
      return;
    }
    const backupPath = path.join(directory, record.backupName);
    const metadata = await lstatFn(backupPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o7777) !== BACKUP_FILE_MODE) {
      throw new RoundcubeConfigBackupError('roundcube_backup_file_invalid', 'Roundcube backup file is invalid');
    }
    const content = await readFileFn(backupPath);
    if (content.length !== record.bytes || sha256(content) !== record.sha256) {
      throw new RoundcubeConfigBackupError('roundcube_backup_file_invalid', 'Roundcube backup file is invalid');
    }
    const temporaryPath = `${record.targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.restore`;
    try {
      await writeFileFn(temporaryPath, content, { mode: record.mode, flag: 'wx' });
      await chownFn(temporaryPath, record.uid, record.gid);
      await chmodFn(temporaryPath, record.mode);
      await renameFn(temporaryPath, record.targetPath);
    } catch (error) {
      try { await rmFn(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function restoreConfiguration(id) {
    const manifest = await loadManifest(id);
    const directory = transactionDirectory(manifest.transactionId);
    try {
      for (const record of manifest.files) await atomicRestore(record, directory);
      if (!manifest.databaseExisted) {
        try {
          const metadata = await lstatFn(databasePath);
          if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new RoundcubeConfigBackupError('roundcube_database_unsafe', 'Roundcube database path is unsafe');
          }
          await rmFn(databasePath, { force: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      if (error instanceof RoundcubeConfigBackupError) throw error;
      throw new RoundcubeConfigBackupError('roundcube_restore_failed', 'Roundcube configuration rollback failed');
    }
    return Object.freeze({
      version: MANIFEST_VERSION,
      transactionId: manifest.transactionId,
      restored: true,
      databaseRemoved: manifest.databaseExisted === false,
    });
  }

  return Object.freeze({ backupConfiguration, restoreConfiguration, loadManifest, transactionDirectory });
}

export const roundcubeConfigBackupInternals = Object.freeze({
  manifestVersion: MANIFEST_VERSION,
  sha256,
  transactionId,
  backupRootMode: BACKUP_ROOT_MODE,
  backupFileMode: BACKUP_FILE_MODE,
});