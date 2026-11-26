import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/backups/yunpanel';
const TAR_PATH = '/usr/bin/tar';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REQUIRED_ENTRIES = Object.freeze([
  Object.freeze({ path: '/etc/yunpanel', type: 'directory', required: true }),
  Object.freeze({ path: '/var/lib/yunpanel', type: 'directory', required: true }),
  Object.freeze({ path: '/etc/passwd', type: 'file', required: true }),
  Object.freeze({ path: '/etc/group', type: 'file', required: true }),
  Object.freeze({ path: '/etc/nginx', type: 'directory', required: false }),
  Object.freeze({ path: '/etc/letsencrypt', type: 'directory', required: false }),
  Object.freeze({ path: '/etc/systemd/system/yunpanel-api.service', type: 'file', required: false }),
  Object.freeze({ path: '/etc/systemd/system/yunpanel-web.service', type: 'file', required: false }),
  Object.freeze({ path: '/etc/systemd/system/yun-agent.service', type: 'file', required: false }),
]);

const MANIFEST_KEYS = new Set(['version', 'createdAt', 'archive', 'sha256', 'entries']);
const ENTRY_KEYS = new Set(['path', 'type', 'present']);

export class LocalMigrationBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalMigrationBackupError';
    this.code = code;
  }
}

function normalizeRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000\r\n]/.test(value)) {
    throw new LocalMigrationBackupError('migration_backup_root_invalid', 'Migration backup root must be an absolute path');
  }
  return path.resolve(value);
}

export function resolveLocalMigrationBackupDirectory(backupDirectory, root = DEFAULT_ROOT) {
  const safeRoot = normalizeRoot(root);
  if (typeof backupDirectory !== 'string' || !path.isAbsolute(backupDirectory) || /[\u0000\r\n]/.test(backupDirectory)) {
    throw new LocalMigrationBackupError('migration_backup_directory_invalid', 'Migration backup directory must be an absolute snapshot path');
  }
  const resolved = path.resolve(backupDirectory);
  if (resolved === safeRoot || !resolved.startsWith(`${safeRoot}${path.sep}`)) {
    throw new LocalMigrationBackupError('migration_backup_directory_outside_root', `Migration backup directory must be a snapshot below ${safeRoot}`);
  }
  return resolved;
}

function relativeArchivePath(value) {
  const relative = value.replace(/^\/+/, '');
  if (!relative || relative.startsWith('../') || relative.includes('/../') || relative.includes('\0')) {
    throw new LocalMigrationBackupError('migration_backup_source_invalid', 'Migration backup source path is invalid');
  }
  return relative;
}

function validateSourceEntries(entries = REQUIRED_ENTRIES) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32) {
    throw new LocalMigrationBackupError('migration_backup_sources_invalid', 'Migration backup source list is invalid');
  }
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)
      || !['file', 'directory'].includes(entry.type) || typeof entry.required !== 'boolean') {
      throw new LocalMigrationBackupError('migration_backup_sources_invalid', 'Migration backup source entry is invalid');
    }
    const resolved = path.resolve(entry.path);
    if (resolved === '/' || seen.has(resolved)) {
      throw new LocalMigrationBackupError('migration_backup_sources_invalid', 'Migration backup source entry is duplicated or too broad');
    }
    seen.add(resolved);
    return Object.freeze({ path: resolved, type: entry.type, required: entry.required });
  });
}

function timestampDirectoryName(now) {
  const iso = new Date(now()).toISOString();
  return `migration-${iso.replace(/[:.]/g, '-')}`;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function validateMetadata(info, expectedType, label) {
  if (!info || typeof info.isSymbolicLink !== 'function' || info.isSymbolicLink()) {
    throw new LocalMigrationBackupError('migration_backup_source_unsafe', `${label} must not be a symbolic link`);
  }
  const valid = expectedType === 'directory' ? info.isDirectory() : info.isFile();
  if (!valid) throw new LocalMigrationBackupError('migration_backup_source_type_invalid', `${label} has an unexpected filesystem type`);
}

async function inspectSources(entries, lstatFn) {
  const inspected = [];
  for (const entry of entries) {
    let metadata;
    try {
      metadata = await lstatFn(entry.path);
    } catch (error) {
      if (error?.code === 'ENOENT' && !entry.required) {
        inspected.push(Object.freeze({ path: entry.path, type: entry.type, present: false }));
        continue;
      }
      if (error?.code === 'ENOENT') {
        throw new LocalMigrationBackupError('migration_backup_required_path_missing', `Required migration backup source is missing: ${entry.path}`);
      }
      throw new LocalMigrationBackupError('migration_backup_source_unreadable', `Migration backup source could not be inspected: ${entry.path}`);
    }
    validateMetadata(metadata, entry.type, entry.path);
    inspected.push(Object.freeze({ path: entry.path, type: entry.type, present: true }));
  }
  return inspected;
}

function normalizeManifest(value, entries) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))
    || value.version !== STORE_VERSION
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || value.archive !== 'state.tar'
    || typeof value.sha256 !== 'string' || !HASH_PATTERN.test(value.sha256)
    || !Array.isArray(value.entries) || value.entries.length !== entries.length) {
    throw new LocalMigrationBackupError('migration_backup_manifest_invalid', 'Migration backup manifest is invalid');
  }
  const expected = new Map(entries.map((entry) => [entry.path, entry]));
  const normalized = value.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))
      || typeof entry.path !== 'string' || typeof entry.type !== 'string' || typeof entry.present !== 'boolean') {
      throw new LocalMigrationBackupError('migration_backup_manifest_invalid', 'Migration backup manifest entry is invalid');
    }
    const source = expected.get(entry.path);
    if (!source || source.type !== entry.type || (source.required && entry.present !== true)) {
      throw new LocalMigrationBackupError('migration_backup_manifest_invalid', 'Migration backup manifest does not match required sources');
    }
    return Object.freeze({ path: entry.path, type: entry.type, present: entry.present });
  });
  if (new Set(normalized.map((entry) => entry.path)).size !== entries.length) {
    throw new LocalMigrationBackupError('migration_backup_manifest_invalid', 'Migration backup manifest contains duplicate source entries');
  }
  return Object.freeze({
    version: STORE_VERSION,
    createdAt: new Date(value.createdAt).toISOString(),
    archive: 'state.tar',
    sha256: value.sha256,
    entries: Object.freeze(normalized),
  });
}

function validateArchiveListing(stdout, presentEntries) {
  const prefixes = presentEntries.map((entry) => relativeArchivePath(entry.path));
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new LocalMigrationBackupError('migration_backup_archive_invalid', 'Migration backup archive is empty');
  for (const raw of lines) {
    const name = raw.replace(/^\.\//, '').replace(/\/$/, '');
    if (!name || name.startsWith('/') || name === '..' || name.startsWith('../') || name.includes('/../')) {
      throw new LocalMigrationBackupError('migration_backup_archive_invalid', 'Migration backup archive contains an unsafe path');
    }
    if (!prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}/`))) {
      throw new LocalMigrationBackupError('migration_backup_archive_invalid', 'Migration backup archive contains an unexpected path');
    }
  }
}

export async function createLocalMigrationBackup({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  sourceEntries = REQUIRED_ENTRIES,
  lstatFn = lstat,
  mkdirFn = mkdir,
  chmodFn = chmod,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
  hashFileFn = hashFile,
  runTar = (args) => execFileAsync(TAR_PATH, args, { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }),
} = {}) {
  if (typeof now !== 'function' || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function'
    || typeof chmodFn !== 'function' || typeof renameFn !== 'function' || typeof rmFn !== 'function'
    || typeof writeFileFn !== 'function' || typeof hashFileFn !== 'function' || typeof runTar !== 'function') {
    throw new LocalMigrationBackupError('migration_backup_dependencies_invalid', 'Migration backup dependencies are invalid');
  }
  const safeRoot = normalizeRoot(root);
  const entries = validateSourceEntries(sourceEntries);
  const inspected = await inspectSources(entries, lstatFn);
  const present = inspected.filter((entry) => entry.present);
  const backupDirectory = path.join(safeRoot, timestampDirectoryName(now));
  const archivePath = path.join(backupDirectory, 'state.tar');
  const archiveTemporary = `${archivePath}.${process.pid}.tmp`;
  const manifestPath = path.join(backupDirectory, 'manifest.json');
  const manifestTemporary = `${manifestPath}.${process.pid}.tmp`;

  await mkdirFn(safeRoot, { recursive: true, mode: 0o700 });
  await chmodFn(safeRoot, 0o700);
  await mkdirFn(backupDirectory, { recursive: false, mode: 0o700 });
  await chmodFn(backupDirectory, 0o700);

  try {
    await runTar([
      '--create', '--file', archiveTemporary,
      '--numeric-owner', '--acls', '--xattrs',
      '--directory=/', '--',
      ...present.map((entry) => relativeArchivePath(entry.path)),
    ]);
  } catch {
    await rmFn(archiveTemporary, { force: true }).catch(() => {});
    throw new LocalMigrationBackupError('migration_backup_archive_failed', 'Migration backup archive could not be created');
  }

  await chmodFn(archiveTemporary, 0o600);
  await renameFn(archiveTemporary, archivePath);
  await chmodFn(archivePath, 0o600);

  let sha256;
  try {
    sha256 = await hashFileFn(archivePath);
  } catch {
    throw new LocalMigrationBackupError('migration_backup_hash_failed', 'Migration backup archive checksum could not be calculated');
  }
  if (typeof sha256 !== 'string' || !HASH_PATTERN.test(sha256)) {
    throw new LocalMigrationBackupError('migration_backup_hash_invalid', 'Migration backup archive checksum is invalid');
  }

  const manifest = normalizeManifest({
    version: STORE_VERSION,
    createdAt: new Date(now()).toISOString(),
    archive: 'state.tar',
    sha256,
    entries: inspected,
  }, entries);
  await writeFileFn(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmodFn(manifestTemporary, 0o600);
  await renameFn(manifestTemporary, manifestPath);
  await chmodFn(manifestPath, 0o600);

  return Object.freeze({ backupDirectory, archivePath, manifestPath, sha256, entries: manifest.entries });
}

export async function verifyLocalMigrationBackup({
  backupDirectory,
  sourceEntries = REQUIRED_ENTRIES,
  lstatFn = lstat,
  readFileFn = readFile,
  hashFileFn = hashFile,
  runTar = (args) => execFileAsync(TAR_PATH, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }),
} = {}) {
  if (typeof backupDirectory !== 'string' || !path.isAbsolute(backupDirectory)
    || typeof lstatFn !== 'function' || typeof readFileFn !== 'function'
    || typeof hashFileFn !== 'function' || typeof runTar !== 'function') {
    throw new LocalMigrationBackupError('migration_backup_verify_dependencies_invalid', 'Migration backup verification dependencies are invalid');
  }
  const entries = validateSourceEntries(sourceEntries);
  const directory = path.resolve(backupDirectory);
  const archivePath = path.join(directory, 'state.tar');
  const manifestPath = path.join(directory, 'manifest.json');

  let directoryInfo;
  let archiveInfo;
  let manifestInfo;
  try {
    [directoryInfo, archiveInfo, manifestInfo] = await Promise.all([
      lstatFn(directory), lstatFn(archivePath), lstatFn(manifestPath),
    ]);
  } catch {
    throw new LocalMigrationBackupError('migration_backup_files_missing', 'Migration backup directory, archive or manifest is missing');
  }
  validateMetadata(directoryInfo, 'directory', directory);
  validateMetadata(archiveInfo, 'file', archivePath);
  validateMetadata(manifestInfo, 'file', manifestPath);
  if ((directoryInfo.mode & 0o077) !== 0 || (archiveInfo.mode & 0o077) !== 0 || (manifestInfo.mode & 0o077) !== 0) {
    throw new LocalMigrationBackupError('migration_backup_permissions_unsafe', 'Migration backup files must not grant group or other permissions');
  }
  if (manifestInfo.size > 128 * 1024) {
    throw new LocalMigrationBackupError('migration_backup_manifest_invalid', 'Migration backup manifest is unexpectedly large');
  }

  let manifest;
  try {
    manifest = normalizeManifest(JSON.parse(await readFileFn(manifestPath, 'utf8')), entries);
  } catch (error) {
    if (error instanceof LocalMigrationBackupError) throw error;
    throw new LocalMigrationBackupError('migration_backup_manifest_invalid', 'Migration backup manifest could not be parsed');
  }

  let actualHash;
  try {
    actualHash = await hashFileFn(archivePath);
  } catch {
    throw new LocalMigrationBackupError('migration_backup_hash_failed', 'Migration backup archive checksum could not be calculated');
  }
  if (actualHash !== manifest.sha256) {
    throw new LocalMigrationBackupError('migration_backup_checksum_mismatch', 'Migration backup archive checksum does not match the manifest');
  }

  let listing;
  try {
    listing = await runTar(['--list', '--file', archivePath]);
  } catch {
    throw new LocalMigrationBackupError('migration_backup_archive_invalid', 'Migration backup archive could not be inspected');
  }
  validateArchiveListing(listing?.stdout, manifest.entries.filter((entry) => entry.present));

  return Object.freeze({ verified: true, backupDirectory: directory, archivePath, manifestPath, sha256: actualHash, entries: manifest.entries });
}

export const localMigrationBackupInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  tarPath: TAR_PATH,
  requiredEntries: REQUIRED_ENTRIES,
  validateSourceEntries,
  relativeArchivePath,
  normalizeManifest,
  validateArchiveListing,
});
