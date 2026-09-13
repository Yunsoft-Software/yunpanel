import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/backups/databases/.restore-receipts';
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_FIELDS = new Set([
  'version',
  'transactionId',
  'backupId',
  'preRestoreBackupId',
  'databaseName',
  'engine',
  'dumpSha256',
  'preRestoreDumpSha256',
  'restored',
  'verified',
  'sideEffects',
  'committedAt',
]);

export class DatabaseRestoreReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseRestoreReceiptError';
    this.code = code;
  }
}

function transactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_ID_PATTERN.test(value)) {
    throw new DatabaseRestoreReceiptError('database_restore_receipt_transaction_invalid', 'Database restore receipt transaction identity is invalid');
  }
  return value;
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== RECEIPT_FIELDS.size
    || Object.keys(value).some((field) => !RECEIPT_FIELDS.has(field))
    || value.version !== STORE_VERSION
    || transactionId(value.transactionId) !== value.transactionId
    || typeof value.backupId !== 'string' || !BACKUP_ID_PATTERN.test(value.backupId)
    || value.preRestoreBackupId !== `pre-restore:${value.transactionId}`
    || typeof value.databaseName !== 'string' || !DATABASE_NAME_PATTERN.test(value.databaseName)
    || !['mariadb', 'mysql'].includes(value.engine)
    || typeof value.dumpSha256 !== 'string' || !SHA256_PATTERN.test(value.dumpSha256)
    || typeof value.preRestoreDumpSha256 !== 'string' || !SHA256_PATTERN.test(value.preRestoreDumpSha256)
    || value.restored !== true || value.verified !== true || value.sideEffects !== true
    || typeof value.committedAt !== 'string' || !Number.isFinite(Date.parse(value.committedAt))) {
    throw new DatabaseRestoreReceiptError('database_restore_receipt_invalid', 'Database restore receipt is invalid');
  }
  return Object.freeze({ ...value, committedAt: new Date(value.committedAt).toISOString() });
}

function receiptInput(value, committedAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatabaseRestoreReceiptError('database_restore_receipt_input_invalid', 'Database restore receipt input is invalid');
  }
  return normalizeReceipt({
    version: value.version,
    transactionId: value.transactionId,
    backupId: value.backupId,
    preRestoreBackupId: value.preRestoreBackupId,
    databaseName: value.databaseName,
    engine: value.engine,
    dumpSha256: value.dumpSha256,
    preRestoreDumpSha256: value.preRestoreDumpSha256,
    restored: value.restored,
    verified: value.verified,
    sideEffects: value.sideEffects,
    committedAt,
  });
}

function equivalentReceipt(existing, candidate) {
  return [...RECEIPT_FIELDS]
    .filter((field) => field !== 'committedAt')
    .every((field) => existing[field] === candidate[field]);
}

export function createDatabaseRestoreReceiptStore({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  randomSuffix = () => randomBytes(8).toString('hex'),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)
    || typeof now !== 'function' || typeof randomSuffix !== 'function') {
    throw new DatabaseRestoreReceiptError('database_restore_receipt_dependencies_invalid', 'Database restore receipt dependencies are invalid');
  }

  function receiptPath(id) {
    return path.join(root, `${transactionId(id)}.json`);
  }

  async function read(id) {
    const filePath = receiptPath(id);
    let metadata;
    try { metadata = await lstat(filePath); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new DatabaseRestoreReceiptError('database_restore_receipt_read_failed', 'Database restore receipt could not be read');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      throw new DatabaseRestoreReceiptError('database_restore_receipt_file_invalid', 'Database restore receipt file is invalid');
    }
    try { return normalizeReceipt(JSON.parse(await readFile(filePath, 'utf8'))); }
    catch (error) {
      if (error instanceof DatabaseRestoreReceiptError) throw error;
      throw new DatabaseRestoreReceiptError('database_restore_receipt_invalid', 'Database restore receipt is invalid');
    }
  }

  async function write(value) {
    const id = transactionId(value?.transactionId);
    const existing = await read(id);
    const candidate = receiptInput(value, new Date(now()).toISOString());
    if (existing) {
      if (!equivalentReceipt(existing, candidate)) {
        throw new DatabaseRestoreReceiptError('database_restore_receipt_conflict', 'Database restore receipt conflicts with existing evidence');
      }
      return existing;
    }

    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const temporaryPath = path.join(root, `.${id}.${process.pid}.${randomSuffix()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, receiptPath(id));
    } catch (error) {
      if (error instanceof DatabaseRestoreReceiptError) throw error;
      throw new DatabaseRestoreReceiptError('database_restore_receipt_write_failed', 'Database restore receipt could not be committed');
    } finally {
      await rm(temporaryPath, { force: true });
    }
    const committed = await read(id);
    if (!committed || !equivalentReceipt(committed, candidate)) {
      throw new DatabaseRestoreReceiptError('database_restore_receipt_commit_failed', 'Database restore receipt could not be verified after commit');
    }
    return committed;
  }

  return Object.freeze({ read, write, receiptPath });
}

export const databaseRestoreReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeReceipt,
  receiptInput,
  equivalentReceipt,
});
