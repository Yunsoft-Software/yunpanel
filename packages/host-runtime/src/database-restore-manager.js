import { createReadStream } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDatabaseManager } from './database-manager.js';
import { createDatabaseDumpManager, databaseDumpManagerInternals } from './database-dump-manager.js';
import { createDatabaseRestoreReceiptStore } from './database-restore-receipt.js';

const DEFAULT_TRANSACTION_ROOT = '/var/lib/yunpanel/backups/databases/.transactions';
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RESTORE_PROGRAMS = Object.freeze(['/usr/bin/mariadb', '/usr/bin/mysql']);
const MAX_STDERR = 64 * 1024;

export class DatabaseRestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseRestoreError';
    this.code = code;
  }
}

function transactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_ID_PATTERN.test(value)) {
    throw new DatabaseRestoreError('database_restore_transaction_invalid', 'Database restore transaction identity is invalid');
  }
  return value;
}

function expectedBackupSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DatabaseRestoreError('database_restore_backup_digest_invalid', 'Database restore backup digest is invalid');
  }
  return value;
}

async function spawnRestore(program, args, dumpPath) {
  await new Promise((resolve, reject) => {
    const input = createReadStream(dumpPath);
    const child = spawn(program, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      windowsHide: true,
    });
    let stderrBytes = 0;
    let settled = false;
    let timer = null;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.destroy();
      if (error) reject(error); else resolve();
    };
    input.once('error', () => {
      child.kill('SIGKILL');
      finish(new DatabaseRestoreError('database_restore_source_unreadable', 'Database restore source could not be read'));
    });
    child.stdin.once('error', () => {});
    input.pipe(child.stdin);
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR) {
        child.kill('SIGKILL');
        finish(new DatabaseRestoreError('database_restore_output_limit', 'Database restore process exceeded the safe diagnostic limit'));
      }
    });
    child.once('error', () => finish(new DatabaseRestoreError('database_restore_program_unavailable', 'Database restore program could not be started')));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new DatabaseRestoreError('database_restore_failed', 'Database restore process failed'));
        return;
      }
      finish();
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new DatabaseRestoreError('database_restore_timeout', 'Database restore process timed out'));
    }, 60 * 60 * 1000);
  });
}

async function defaultRestoreFromFile({ dumpPath, engine, programs = RESTORE_PROGRAMS }) {
  const ordered = engine === 'mysql' ? [...programs].reverse() : programs;
  let lastError = null;
  for (const program of ordered) {
    try {
      await spawnRestore(program, [
        '--protocol=socket',
        '--binary-mode=1',
        '--default-character-set=utf8mb4',
      ], dumpPath);
      return program;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'database_restore_program_unavailable') throw error;
    }
  }
  throw lastError ?? new DatabaseRestoreError('database_restore_program_unavailable', 'No supported database restore program is available');
}

export function createDatabaseRestoreManager({
  transactionRoot = DEFAULT_TRANSACTION_ROOT,
  databaseManager = createDatabaseManager(),
  backupManager = createDatabaseDumpManager({ databaseManager }),
  receiptStore = createDatabaseRestoreReceiptStore(),
  restoreFromFile = defaultRestoreFromFile,
  dumpToFile = databaseDumpManagerInternals.defaultDumpToFile,
} = {}) {
  if (typeof transactionRoot !== 'string' || !path.isAbsolute(transactionRoot)
    || !databaseManager || typeof databaseManager.inspect !== 'function' || typeof databaseManager.dropDatabase !== 'function'
    || !backupManager || typeof backupManager.backup !== 'function' || typeof backupManager.materializeBackup !== 'function'
    || !receiptStore || typeof receiptStore.write !== 'function'
    || typeof restoreFromFile !== 'function' || typeof dumpToFile !== 'function') {
    throw new DatabaseRestoreError('database_restore_dependencies_invalid', 'Database restore dependencies are invalid');
  }

  async function requireLiveDatabase(name, engine) {
    const inventory = await databaseManager.inspect();
    if (!inventory || inventory.engine !== engine || !Array.isArray(inventory.databases)
      || !inventory.databases.some((entry) => entry?.name === name)) {
      throw new DatabaseRestoreError('database_restore_target_invalid', 'Database restore target does not match the backup engine and schema');
    }
    return inventory;
  }

  async function resetDatabase(name) {
    const inventory = await databaseManager.inspect();
    if (inventory?.databases?.some((entry) => entry?.name === name)) {
      await databaseManager.dropDatabase(name);
    }
  }

  async function verifyLiveDump({ databaseName, expectedSha256, engine, directory, filename }) {
    const verificationPath = path.join(directory, filename);
    await dumpToFile({
      databaseName,
      outputPath: verificationPath,
      engine,
      programs: databaseDumpManagerInternals.dumpPrograms,
    });
    await chmod(verificationPath, 0o600);
    const digest = await databaseDumpManagerInternals.sha256File(verificationPath);
    if (digest !== expectedSha256) {
      throw new DatabaseRestoreError('database_restore_verification_failed', 'Database restore verification did not match the selected backup');
    }
    return digest;
  }

  async function applyBackup(materialized, directory, verificationFile) {
    await resetDatabase(materialized.databaseName);
    await restoreFromFile({
      dumpPath: materialized.dumpPath,
      engine: materialized.engine,
      programs: RESTORE_PROGRAMS,
    });
    await requireLiveDatabase(materialized.databaseName, materialized.engine);
    return verifyLiveDump({
      databaseName: materialized.databaseName,
      expectedSha256: materialized.dumpSha256,
      engine: materialized.engine,
      directory,
      filename: verificationFile,
    });
  }

  async function restore({
    transactionId: requestedTransactionId,
    backupId,
    databaseName,
    expectedBackupSha256: requestedBackupSha256,
  } = {}) {
    const id = transactionId(requestedTransactionId);
    const expectedSha = expectedBackupSha256(requestedBackupSha256);
    const selected = await backupManager.materializeBackup(backupId);
    if (!selected || selected.databaseName !== databaseName) {
      throw new DatabaseRestoreError('database_restore_backup_mismatch', 'Selected database backup does not match the restore target');
    }
    if (selected.dumpSha256 !== expectedSha) {
      throw new DatabaseRestoreError('database_restore_backup_stale', 'Selected database backup changed after restore preview');
    }
    await requireLiveDatabase(databaseName, selected.engine);

    const preRestoreBackupId = `pre-restore:${id}`;
    const preRestore = await backupManager.backup({ backupId: preRestoreBackupId, databaseName });
    const rollbackSource = await backupManager.materializeBackup(preRestoreBackupId);

    await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
    await chmod(transactionRoot, 0o700);
    const directory = path.join(transactionRoot, id);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);

    try {
      await applyBackup(selected, directory, 'restore-verification.sql');
      const result = Object.freeze({
        version: 1,
        transactionId: id,
        backupId: selected.backupId,
        preRestoreBackupId,
        databaseName,
        engine: selected.engine,
        dumpSha256: selected.dumpSha256,
        preRestoreDumpSha256: preRestore.dumpSha256,
        restored: true,
        verified: true,
        sideEffects: true,
      });
      try { await receiptStore.write(result); }
      catch {
        throw new DatabaseRestoreError(
          'database_restore_receipt_failed',
          'Database restore succeeded but its private completion receipt could not be committed',
        );
      }
      return result;
    } catch (error) {
      try {
        await rm(path.join(directory, 'restore-verification.sql'), { force: true });
        await applyBackup(rollbackSource, directory, 'rollback-verification.sql');
      } catch {
        throw new DatabaseRestoreError(
          'database_restore_rollback_failed',
          'Database restore failed and the pre-restore backup could not be verified after rollback',
        );
      }
      if (error instanceof DatabaseRestoreError) throw error;
      throw new DatabaseRestoreError('database_restore_failed', 'Database restore failed and was rolled back');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return Object.freeze({ restore });
}

export const databaseRestoreManagerInternals = Object.freeze({
  defaultTransactionRoot: DEFAULT_TRANSACTION_ROOT,
  restorePrograms: RESTORE_PROGRAMS,
  spawnRestore,
  defaultRestoreFromFile,
  transactionId,
  expectedBackupSha256,
});
