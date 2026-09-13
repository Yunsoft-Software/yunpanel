import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createDatabaseManager } from './database-manager.js';
import { databaseDumpManagerInternals } from './database-dump-manager.js';

const DEFAULT_ROOT = '/var/lib/yunpanel/backups/databases/.restore-recovery';
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const ENGINES = new Set(['mariadb', 'mysql']);

export class DatabaseRestoreEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseRestoreEvidenceError';
    this.code = code;
  }
}

function databaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value)) {
    throw new DatabaseRestoreEvidenceError('database_restore_evidence_database_invalid', 'Database restore evidence schema name is invalid');
  }
  return value;
}

function engine(value) {
  if (typeof value !== 'string' || !ENGINES.has(value)) {
    throw new DatabaseRestoreEvidenceError('database_restore_evidence_engine_invalid', 'Database restore evidence engine is invalid');
  }
  return value;
}

export function createDatabaseRestoreEvidenceInspector({
  root = DEFAULT_ROOT,
  databaseManager = createDatabaseManager(),
  dumpToFile = databaseDumpManagerInternals.defaultDumpToFile,
  randomSuffix = () => randomBytes(8).toString('hex'),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)
    || !databaseManager || typeof databaseManager.inspect !== 'function'
    || typeof dumpToFile !== 'function' || typeof randomSuffix !== 'function') {
    throw new DatabaseRestoreEvidenceError('database_restore_evidence_dependencies_invalid', 'Database restore evidence dependencies are invalid');
  }

  async function inspectLive({ databaseName: requestedName, engine: requestedEngine } = {}) {
    const name = databaseName(requestedName);
    const expectedEngine = engine(requestedEngine);
    let inventory;
    try { inventory = await databaseManager.inspect(); }
    catch {
      throw new DatabaseRestoreEvidenceError('database_restore_evidence_inventory_failed', 'Live database inventory could not be read');
    }
    if (!inventory || inventory.engine !== expectedEngine || typeof inventory.version !== 'string' || !inventory.version
      || !Array.isArray(inventory.databases) || !inventory.databases.some((entry) => entry?.name === name)) {
      throw new DatabaseRestoreEvidenceError('database_restore_evidence_target_mismatch', 'Live database target does not match the expected restore schema and engine');
    }

    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const directory = path.join(root, `${name}-${randomSuffix()}`);
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    const dumpPath = path.join(directory, 'live.sql');
    try {
      await dumpToFile({
        databaseName: name,
        outputPath: dumpPath,
        engine: expectedEngine,
        programs: databaseDumpManagerInternals.dumpPrograms,
      });
      await chmod(dumpPath, 0o600);
      const metadata = await lstat(dumpPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 || metadata.size < 1) {
        throw new DatabaseRestoreEvidenceError('database_restore_evidence_dump_invalid', 'Live database evidence dump is invalid');
      }
      return Object.freeze({
        databaseName: name,
        engine: expectedEngine,
        databaseVersion: inventory.version,
        dumpSha256: await databaseDumpManagerInternals.sha256File(dumpPath),
        dumpBytes: metadata.size,
      });
    } catch (error) {
      if (error instanceof DatabaseRestoreEvidenceError) throw error;
      throw new DatabaseRestoreEvidenceError('database_restore_evidence_dump_failed', 'Live database restore evidence could not be generated');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return Object.freeze({ inspectLive });
}

export const databaseRestoreEvidenceInternals = Object.freeze({
  defaultRoot: DEFAULT_ROOT,
  databaseName,
  engine,
});
