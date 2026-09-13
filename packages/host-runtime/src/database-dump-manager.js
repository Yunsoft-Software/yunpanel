import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDatabaseManager } from './database-manager.js';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/backups/databases';
const DUMP_PROGRAMS = Object.freeze(['/usr/bin/mariadb-dump', '/usr/bin/mysqldump']);
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_STDERR = 64 * 1024;

export class DatabaseDumpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseDumpError';
    this.code = code;
  }
}

function backupId(value) {
  if (typeof value !== 'string' || !BACKUP_ID_PATTERN.test(value)) {
    throw new DatabaseDumpError('database_backup_id_invalid', 'Database backup identity is invalid');
  }
  return value;
}

function databaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value)
    || ['information_schema', 'mysql', 'performance_schema', 'sys'].includes(value.toLowerCase())) {
    throw new DatabaseDumpError('database_backup_name_invalid', 'Database backup schema name is invalid');
  }
  return value;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function dumpArgs(name) {
  return [
    '--protocol=socket',
    '--single-transaction',
    '--quick',
    '--skip-lock-tables',
    '--routines',
    '--events',
    '--triggers',
    '--hex-blob',
    '--default-character-set=utf8mb4',
    '--databases',
    name,
  ];
}

async function spawnDump(program, args, outputPath) {
  const handle = await open(outputPath, 'wx', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        stdio: ['ignore', handle.fd, 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
        windowsHide: true,
      });
      let stderrBytes = 0;
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR) {
          child.kill('SIGKILL');
          finish(new DatabaseDumpError('database_dump_output_limit', 'Database dump process exceeded the safe diagnostic limit'));
        }
      });
      child.once('error', () => finish(new DatabaseDumpError('database_dump_program_unavailable', 'Database dump program could not be started')));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new DatabaseDumpError('database_dump_failed', 'Database dump process failed'));
          return;
        }
        finish();
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new DatabaseDumpError('database_dump_timeout', 'Database dump process timed out'));
      }, 60 * 60 * 1000);
    });
  } finally {
    await handle.close();
  }
}

async function defaultDumpToFile({ databaseName: name, outputPath, programs = DUMP_PROGRAMS }) {
  let lastError = null;
  for (const program of programs) {
    try {
      await spawnDump(program, dumpArgs(name), outputPath);
      return program;
    } catch (error) {
      lastError = error;
      await rm(outputPath, { force: true });
      if (error?.code !== 'database_dump_program_unavailable') throw error;
    }
  }
  throw lastError ?? new DatabaseDumpError('database_dump_program_unavailable', 'No supported database dump program is available');
}

function publicManifest(value) {
  return Object.freeze({
    version: STORE_VERSION,
    backupId: value.backupId,
    databaseName: value.databaseName,
    engine: value.engine,
    databaseVersion: value.databaseVersion,
    dumpSha256: value.dumpSha256,
    dumpBytes: value.dumpBytes,
    createdAt: value.createdAt,
    backedUp: true,
    sideEffects: true,
  });
}

function normalizeManifest(value) {
  const fields = new Set([
    'version', 'backupId', 'databaseName', 'engine', 'databaseVersion',
    'dumpFile', 'dumpSha256', 'dumpBytes', 'createdAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.version !== STORE_VERSION || backupId(value.backupId) !== value.backupId
    || databaseName(value.databaseName) !== value.databaseName
    || !['mariadb', 'mysql'].includes(value.engine)
    || typeof value.databaseVersion !== 'string' || value.databaseVersion.length < 1 || value.databaseVersion.length > 120
    || value.dumpFile !== 'dump.sql'
    || typeof value.dumpSha256 !== 'string' || !SHA256_PATTERN.test(value.dumpSha256)
    || !Number.isSafeInteger(value.dumpBytes) || value.dumpBytes < 1
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new DatabaseDumpError('database_backup_manifest_invalid', 'Database backup manifest is invalid');
  }
  return Object.freeze({ ...value, createdAt: new Date(value.createdAt).toISOString() });
}

async function assertRegularPrivate(filePath, mode) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DatabaseDumpError('database_backup_artifact_invalid', 'Database backup artifact is not a regular file');
  }
  if ((metadata.mode & 0o777) !== mode) {
    throw new DatabaseDumpError('database_backup_permissions_invalid', 'Database backup artifact permissions are invalid');
  }
  return metadata;
}

export function createDatabaseDumpManager({
  root = DEFAULT_ROOT,
  databaseManager = createDatabaseManager(),
  dumpToFile = defaultDumpToFile,
  now = () => Date.now(),
  randomSuffix = () => randomBytes(8).toString('hex'),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)
    || !databaseManager || typeof databaseManager.inspect !== 'function'
    || typeof dumpToFile !== 'function' || typeof now !== 'function' || typeof randomSuffix !== 'function') {
    throw new DatabaseDumpError('database_backup_dependencies_invalid', 'Database backup dependencies are invalid');
  }

  function directoryFor(id) {
    return path.join(root, backupId(id));
  }

  async function verifyBackup(id) {
    const normalizedId = backupId(id);
    const directory = directoryFor(normalizedId);
    let directoryMeta;
    try { directoryMeta = await lstat(directory); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new DatabaseDumpError('database_backup_read_failed', 'Database backup could not be read');
    }
    if (!directoryMeta.isDirectory() || directoryMeta.isSymbolicLink() || (directoryMeta.mode & 0o777) !== 0o700) {
      throw new DatabaseDumpError('database_backup_directory_invalid', 'Database backup directory is invalid');
    }
    const manifestPath = path.join(directory, 'manifest.json');
    const dumpPath = path.join(directory, 'dump.sql');
    await assertRegularPrivate(manifestPath, 0o600);
    const dumpMeta = await assertRegularPrivate(dumpPath, 0o600);
    let manifest;
    try { manifest = normalizeManifest(JSON.parse(await readFile(manifestPath, 'utf8'))); }
    catch (error) {
      if (error instanceof DatabaseDumpError) throw error;
      throw new DatabaseDumpError('database_backup_manifest_invalid', 'Database backup manifest is invalid');
    }
    if (manifest.backupId !== normalizedId || dumpMeta.size !== manifest.dumpBytes
      || await sha256File(dumpPath) !== manifest.dumpSha256) {
      throw new DatabaseDumpError('database_backup_integrity_failed', 'Database backup checksum verification failed');
    }
    return Object.freeze({ manifest, dumpPath });
  }

  async function inspectBackup(id) {
    const verified = await verifyBackup(id);
    return verified ? publicManifest(verified.manifest) : null;
  }

  async function materializeBackup(id) {
    const verified = await verifyBackup(id);
    if (!verified) throw new DatabaseDumpError('database_backup_not_found', 'Database backup was not found');
    return Object.freeze({ ...publicManifest(verified.manifest), dumpPath: verified.dumpPath });
  }

  async function backup({ backupId: requestedId, databaseName: requestedName } = {}) {
    const id = backupId(requestedId);
    const name = databaseName(requestedName);
    const existing = await verifyBackup(id);
    if (existing) {
      if (existing.manifest.databaseName !== name) {
        throw new DatabaseDumpError('database_backup_identity_conflict', 'Database backup identity is already used for another schema');
      }
      return publicManifest(existing.manifest);
    }

    const inventory = await databaseManager.inspect();
    if (!inventory || !['mariadb', 'mysql'].includes(inventory.engine)
      || typeof inventory.version !== 'string' || !Array.isArray(inventory.databases)) {
      throw new DatabaseDumpError('database_backup_inventory_invalid', 'Database inventory is invalid');
    }
    if (!inventory.databases.some((database) => database?.name === name)) {
      throw new DatabaseDumpError('database_backup_database_not_found', 'Database was not found in the live inventory');
    }

    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const pending = path.join(root, `.pending-${id}-${randomSuffix()}`);
    const target = directoryFor(id);
    await mkdir(pending, { mode: 0o700 });
    await chmod(pending, 0o700);
    try {
      const dumpPath = path.join(pending, 'dump.sql');
      await dumpToFile({ databaseName: name, outputPath: dumpPath, engine: inventory.engine, programs: DUMP_PROGRAMS });
      await chmod(dumpPath, 0o600);
      const dumpMeta = await assertRegularPrivate(dumpPath, 0o600);
      if (dumpMeta.size < 1) throw new DatabaseDumpError('database_backup_empty', 'Database dump is empty');
      const manifest = normalizeManifest({
        version: STORE_VERSION,
        backupId: id,
        databaseName: name,
        engine: inventory.engine,
        databaseVersion: inventory.version,
        dumpFile: 'dump.sql',
        dumpSha256: await sha256File(dumpPath),
        dumpBytes: dumpMeta.size,
        createdAt: new Date(now()).toISOString(),
      });
      const manifestPath = path.join(pending, 'manifest.json');
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(manifestPath, 0o600);
      await rename(pending, target);
      const verified = await verifyBackup(id);
      if (!verified) throw new DatabaseDumpError('database_backup_commit_failed', 'Database backup could not be verified after commit');
      return publicManifest(verified.manifest);
    } catch (error) {
      await rm(pending, { recursive: true, force: true });
      if (error instanceof DatabaseDumpError) throw error;
      throw new DatabaseDumpError('database_backup_failed', 'Database backup could not be completed');
    }
  }

  return Object.freeze({ backup, inspectBackup, materializeBackup, directoryFor });
}

export const databaseDumpManagerInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  dumpPrograms: DUMP_PROGRAMS,
  dumpArgs,
  spawnDump,
  defaultDumpToFile,
  normalizeManifest,
  sha256File,
});
