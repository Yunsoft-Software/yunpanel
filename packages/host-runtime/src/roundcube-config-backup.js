import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { roundcubeFpmTemplatePolicy, roundcubeTemplatePolicy } from '@yunpanel/config-templates';

const TRANSACTION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKUP_ROOT_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 1024 * 1024;

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
  databasePath = roundcubeTemplatePolicy.databasePath,
  chmodFn = chmod,
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
      if (error?.code === 'ENOENT') {
        return Object.freeze({ targetPath, exists: false, backupName: null });
      }
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
      const [config, fpm, databaseExisted] = await Promise.all([
        inspectTarget(configPath, 'config.inc.php'),
        inspectTarget(fpmPoolPath, 'yunpanel-roundcube-fpm.conf'),
        inspectDatabasePresence(),
      ]);
      for (const record of [config, fpm]) {
        if (!record.exists) continue;
        await writeFileFn(path.join(directory, record.backupName), record.content, { mode: BACKUP_FILE_MODE, flag: 'wx' });
        await chmodFn(path.join(directory, record.backupName), BACKUP_FILE_MODE);
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
        version: 1,
        transactionId: normalizedId,
        databaseExisted,
        files: Object.freeze([publicRecord(config), publicRecord(fpm)]),
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

  return Object.freeze({ backupConfiguration, transactionDirectory });
}

export const roundcubeConfigBackupInternals = Object.freeze({
  sha256,
  transactionId,
  backupRootMode: BACKUP_ROOT_MODE,
  backupFileMode: BACKUP_FILE_MODE,
});