import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/database-deletions';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const RECEIPT_KEYS = Object.freeze(['version', 'recordedAt', 'serverId', 'jobId', 'databaseName', 'result']);
const RESULT_KEYS = Object.freeze(['engine', 'version', 'database', 'deleted']);
const DATABASE_KEYS = Object.freeze(['name', 'sizeBytes']);

export class DatabaseDeletionReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseDeletionReceiptError';
    this.code = code;
  }
}

function normalizeDatabaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value) || RESERVED_DATABASES.has(value.toLowerCase())) {
    throw new DatabaseDeletionReceiptError('database_deletion_receipt_name_invalid', 'Database deletion receipt name is invalid');
  }
  return value;
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new DatabaseDeletionReceiptError('database_deletion_receipt_identity_invalid', 'Database deletion receipt identity is invalid');
  }
  return { serverId, jobId };
}

function normalizeResult(value, databaseName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !RESULT_KEYS.includes(key))
    || !['mariadb', 'mysql'].includes(value.engine)
    || typeof value.version !== 'string' || !value.version || value.version.length > 120
    || value.deleted !== true
    || !value.database || typeof value.database !== 'object' || Array.isArray(value.database)
    || Object.keys(value.database).some((key) => !DATABASE_KEYS.includes(key))) {
    throw new DatabaseDeletionReceiptError('database_deletion_receipt_result_invalid', 'Database deletion receipt result is invalid');
  }
  const name = normalizeDatabaseName(value.database.name);
  if (name !== databaseName || !Number.isSafeInteger(value.database.sizeBytes) || value.database.sizeBytes < 0) {
    throw new DatabaseDeletionReceiptError('database_deletion_receipt_result_invalid', 'Database deletion receipt result is inconsistent');
  }
  return {
    engine: value.engine,
    version: value.version,
    database: { name, sizeBytes: value.database.sizeBytes },
    deleted: true,
  };
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key))) {
    throw new DatabaseDeletionReceiptError('database_deletion_receipt_invalid', 'Database deletion receipt is invalid');
  }
  const { serverId, jobId } = normalizeIdentity(value.serverId, value.jobId);
  const databaseName = normalizeDatabaseName(value.databaseName);
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))) {
    throw new DatabaseDeletionReceiptError('database_deletion_receipt_invalid', 'Database deletion receipt timestamp is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: value.recordedAt,
    serverId,
    jobId,
    databaseName,
    result: normalizeResult(value.result, databaseName),
  });
}

export function createDatabaseDeletionReceiptStore({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  chmodFn = chmod,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new DatabaseDeletionReceiptError('database_deletion_receipt_root_invalid', 'Database deletion receipt root must be absolute');
  }

  function receiptPath(serverId, jobId) {
    const identity = normalizeIdentity(serverId, jobId);
    return path.join(root, identity.serverId, `${identity.jobId}.json`);
  }

  async function write({ serverId, jobId, databaseName, result }) {
    const identity = normalizeIdentity(serverId, jobId);
    const name = normalizeDatabaseName(databaseName);
    const receipt = normalizeReceipt({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      ...identity,
      databaseName: name,
      result,
    });
    const directory = path.join(root, identity.serverId);
    const target = receiptPath(identity.serverId, identity.jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdirFn(root, { recursive: true, mode: 0o700 });
    await chmodFn(root, 0o700);
    await mkdirFn(directory, { recursive: true, mode: 0o700 });
    await chmodFn(directory, 0o700);
    await writeFileFn(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameFn(temporary, target);
    await chmodFn(target, 0o600);
    return structuredClone(receipt);
  }

  async function read(serverId, jobId) {
    const target = receiptPath(serverId, jobId);
    let raw;
    try {
      raw = await readFileFn(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new DatabaseDeletionReceiptError('database_deletion_receipt_read_failed', 'Database deletion receipt could not be read');
    }
    try {
      return normalizeReceipt(JSON.parse(raw));
    } catch (error) {
      if (error instanceof DatabaseDeletionReceiptError) throw error;
      throw new DatabaseDeletionReceiptError('database_deletion_receipt_invalid', 'Database deletion receipt is invalid');
    }
  }

  return Object.freeze({ write, read, receiptPath });
}

export const databaseDeletionReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeDatabaseName,
  normalizeIdentity,
  normalizeResult,
  normalizeReceipt,
});
