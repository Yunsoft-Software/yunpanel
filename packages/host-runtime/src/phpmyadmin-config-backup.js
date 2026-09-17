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
  phpMyAdminFpmTemplatePolicy,
  phpMyAdminNginxTemplatePolicy,
  phpMyAdminSignonTemplatePolicy,
} from '@yunpanel/config-templates';

const TRANSACTION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MANIFEST_VERSION = 2;
const BACKUP_ROOT_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MANIFEST_KEYS = new Set(['version', 'transactionId', 'files']);
const ABSENT_RECORD_KEYS = new Set(['targetPath', 'exists', 'backupName']);
const PRESENT_RECORD_KEYS = new Set([
  'targetPath', 'exists', 'backupName', 'sha256', 'bytes', 'mode', 'uid', 'gid',
]);

export class PhpMyAdminConfigBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpMyAdminConfigBackupError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function transactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_PATTERN.test(value)) {
    throw new PhpMyAdminConfigBackupError(
      'phpmyadmin_backup_transaction_invalid',
      'phpMyAdmin backup transaction ID is invalid',
    );
  }
  return value.toLowerCase();
}

export function createPhpMyAdminConfigBackupManager({
  backupRoot = '/var/lib/yunpanel/backups/phpmyadmin',
  fpmPoolPath = phpMyAdminFpmTemplatePolicy.poolPath,
  nginxConfigPath = phpMyAdminNginxTemplatePolicy.configPath,
  signonConfigPath = phpMyAdminSignonTemplatePolicy.configPath,
  signonBridgePath = phpMyAdminSignonTemplatePolicy.bridgePath,
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (typeof backupRoot !== 'string' || !path.isAbsolute(backupRoot)
    || backupRoot === path.parse(backupRoot).root) {
    throw new PhpMyAdminConfigBackupError(
      'phpmyadmin_backup_root_invalid',
      'phpMyAdmin backup root is invalid',
    );
  }
  const resolvedRoot = path.resolve(backupRoot);
  const targets = Object.freeze([
    Object.freeze({ targetPath: fpmPoolPath, backupName: 'yunpanel-phpmyadmin-fpm.conf' }),
    Object.freeze({ targetPath: nginxConfigPath, backupName: 'yunpanel-phpmyadmin-nginx.conf' }),
    Object.freeze({ targetPath: signonConfigPath, backupName: 'zz-yunpanel.php' }),
    Object.freeze({ targetPath: signonBridgePath, backupName: 'yunpanel-phpmyadmin-signon.php' }),
  ]);

  function transactionDirectory(id) {
    return path.join(resolvedRoot, transactionId(id));
  }

  async function ensurePrivateDirectory(directory) {
    try {
      const metadata = await lstatFn(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new PhpMyAdminConfigBackupError(
          'phpmyadmin_backup_directory_unsafe',
          'phpMyAdmin backup directory is unsafe',
        );
      }
      await mkdirFn(directory, { recursive: true, mode: BACKUP_ROOT_MODE });
      const created = await lstatFn(directory);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new PhpMyAdminConfigBackupError(
          'phpmyadmin_backup_directory_unsafe',
          'phpMyAdmin backup directory is unsafe',
        );
      }
    }
    await chmodFn(directory, BACKUP_ROOT_MODE);
  }

  async function inspectTarget({ targetPath, backupName }) {
    let metadata;
    try { metadata = await lstatFn(targetPath); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return Object.freeze({ targetPath, exists: false, backupName: null });
      }
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_inspection_failed',
        'phpMyAdmin live configuration could not be inspected',
      );
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 1 || metadata.size > MAX_CONFIG_BYTES) {
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_target_unsafe',
        'phpMyAdmin live configuration target is unsafe',
      );
    }
    const content = await readFileFn(targetPath);
    if (content.length !== metadata.size) {
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_target_changed',
        'phpMyAdmin live configuration changed during backup',
      );
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

  function publicRecord(record) {
    if (!record.exists) return record;
    return Object.freeze({
      targetPath: record.targetPath,
      exists: true,
      backupName: record.backupName,
      sha256: record.sha256,
      bytes: record.bytes,
      mode: record.mode,
      uid: record.uid,
      gid: record.gid,
    });
  }

  async function backupConfiguration(id) {
    const normalizedId = transactionId(id);
    await ensurePrivateDirectory(resolvedRoot);
    const directory = transactionDirectory(normalizedId);
    try {
      await lstatFn(directory);
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_exists',
        'phpMyAdmin backup transaction already exists',
      );
    } catch (error) {
      if (error instanceof PhpMyAdminConfigBackupError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new PhpMyAdminConfigBackupError(
          'phpmyadmin_backup_directory_unsafe',
          'phpMyAdmin backup transaction path is unsafe',
        );
      }
    }
    await mkdirFn(directory, { mode: BACKUP_ROOT_MODE });
    await chmodFn(directory, BACKUP_ROOT_MODE);
    try {
      const records = await Promise.all(targets.map(inspectTarget));
      for (const record of records) {
        if (!record.exists) continue;
        const backupPath = path.join(directory, record.backupName);
        await writeFileFn(backupPath, record.content, { mode: BACKUP_FILE_MODE, flag: 'wx' });
        await chmodFn(backupPath, BACKUP_FILE_MODE);
      }
      const manifest = Object.freeze({
        version: MANIFEST_VERSION,
        transactionId: normalizedId,
        files: Object.freeze(records.map(publicRecord)),
      });
      const manifestPath = path.join(directory, 'manifest.json');
      await writeFileFn(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8', mode: BACKUP_FILE_MODE, flag: 'wx',
      });
      await chmodFn(manifestPath, BACKUP_FILE_MODE);
      return manifest;
    } catch (error) {
      try { await rmFn(directory, { recursive: true, force: true }); } catch {}
      if (error instanceof PhpMyAdminConfigBackupError) throw error;
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_failed',
        'phpMyAdmin configuration backup failed',
      );
    }
  }

  function validateManifest(value, id) {
    if (!exactKeys(value, MANIFEST_KEYS) || value.version !== MANIFEST_VERSION
      || value.transactionId !== id || !Array.isArray(value.files) || value.files.length !== targets.length) {
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_manifest_invalid',
        'phpMyAdmin backup manifest is invalid',
      );
    }
    const records = value.files.map((record, index) => {
      const expected = targets[index];
      if (!record || record.targetPath !== expected.targetPath || typeof record.exists !== 'boolean') {
        throw new PhpMyAdminConfigBackupError(
          'phpmyadmin_backup_manifest_invalid',
          'phpMyAdmin backup manifest is invalid',
        );
      }
      if (!record.exists) {
        if (!exactKeys(record, ABSENT_RECORD_KEYS) || record.backupName !== null) {
          throw new PhpMyAdminConfigBackupError(
            'phpmyadmin_backup_manifest_invalid',
            'phpMyAdmin backup manifest is invalid',
          );
        }
        return Object.freeze({ targetPath: record.targetPath, exists: false, backupName: null });
      }
      if (!exactKeys(record, PRESENT_RECORD_KEYS) || record.backupName !== expected.backupName
        || typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)
        || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > MAX_CONFIG_BYTES
        || !Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o7777
        || !Number.isSafeInteger(record.uid) || record.uid < 0
        || !Number.isSafeInteger(record.gid) || record.gid < 0) {
        throw new PhpMyAdminConfigBackupError(
          'phpmyadmin_backup_manifest_invalid',
          'phpMyAdmin backup manifest is invalid',
        );
      }
      return Object.freeze({ ...record });
    });
    return Object.freeze({
      version: MANIFEST_VERSION,
      transactionId: id,
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
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.size < 2 || metadata.size > MAX_MANIFEST_BYTES
        || (metadata.mode & 0o7777) !== BACKUP_FILE_MODE) {
        throw new PhpMyAdminConfigBackupError(
          'phpmyadmin_backup_manifest_invalid',
          'phpMyAdmin backup manifest is invalid',
        );
      }
      manifestBuffer = await readFileFn(manifestPath);
    } catch (error) {
      if (error instanceof PhpMyAdminConfigBackupError) throw error;
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_manifest_unavailable',
        'phpMyAdmin backup manifest is unavailable',
      );
    }
    let parsed;
    try { parsed = JSON.parse(manifestBuffer.toString('utf8')); }
    catch {
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_manifest_invalid',
        'phpMyAdmin backup manifest is invalid',
      );
    }
    return validateManifest(parsed, normalizedId);
  }

  async function atomicRestore(record, directory) {
    if (!record.exists) {
      await rmFn(record.targetPath, { force: true });
      return;
    }
    const backupPath = path.join(directory, record.backupName);
    const metadata = await lstatFn(backupPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || (metadata.mode & 0o7777) !== BACKUP_FILE_MODE) {
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_file_invalid',
        'phpMyAdmin backup file is invalid',
      );
    }
    const content = await readFileFn(backupPath);
    if (content.length !== record.bytes || sha256(content) !== record.sha256) {
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_backup_file_invalid',
        'phpMyAdmin backup file is invalid',
      );
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
    } catch (error) {
      if (error instanceof PhpMyAdminConfigBackupError) throw error;
      throw new PhpMyAdminConfigBackupError(
        'phpmyadmin_restore_failed',
        'phpMyAdmin configuration rollback failed',
      );
    }
    return Object.freeze({
      version: MANIFEST_VERSION,
      transactionId: manifest.transactionId,
      restored: true,
    });
  }

  return Object.freeze({ backupConfiguration, restoreConfiguration, loadManifest, transactionDirectory });
}

export const phpMyAdminConfigBackupInternals = Object.freeze({
  manifestVersion: MANIFEST_VERSION,
  sha256,
  transactionId,
  backupRootMode: BACKUP_ROOT_MODE,
  backupFileMode: BACKUP_FILE_MODE,
});
