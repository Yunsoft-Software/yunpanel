import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OPERATIONS } from '@yunpanel/protocol';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/mail-data-operations';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const BACKUP_KEYS = Object.freeze([
  'version', 'recordedAt', 'serverId', 'jobId', 'operation', 'mailDomainId', 'scope', 'identity',
  'backupId', 'sourcePresent', 'sourceSnapshotSha256', 'contentSha256', 'bytes', 'files', 'directories',
  'backedUp', 'sideEffects',
]);
const RESTORE_KEYS = Object.freeze([
  'version', 'recordedAt', 'serverId', 'jobId', 'operation', 'mailDomainId', 'scope', 'identity',
  'transactionId', 'backupId', 'preRestoreBackupId', 'contentSha256', 'bytes', 'files', 'directories',
  'restoredPresent', 'applied', 'sideEffects',
]);
const DELETE_KEYS = Object.freeze([
  'version', 'recordedAt', 'serverId', 'jobId', 'operation', 'mailDomainId', 'resourceId', 'scope', 'identity',
  'transactionId', 'backupId', 'sourcePresent', 'contentSha256', 'bytes', 'files', 'directories',
  'deleted', 'sideEffects',
]);

export class MailDataOperationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDataOperationReceiptError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new MailDataOperationReceiptError('mail_data_receipt_identity_invalid', 'Mail data receipt identity is invalid');
  }
  return { serverId, jobId };
}

function checksum(value, field) {
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) {
    throw new MailDataOperationReceiptError('mail_data_receipt_checksum_invalid', `Mail data receipt ${field} is invalid`);
  }
  return value;
}

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MailDataOperationReceiptError('mail_data_receipt_count_invalid', `Mail data receipt ${field} is invalid`);
  }
  return value;
}

function base(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new MailDataOperationReceiptError('mail_data_receipt_invalid', 'Mail data operation receipt is invalid');
  }
  const identity = normalizeIdentity(value.serverId, value.jobId);
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.mailDomainId !== 'string' || !UUID_PATTERN.test(value.mailDomainId)
    || !['mailbox', 'domain'].includes(value.scope)
    || typeof value.identity !== 'string' || !value.identity
    || value.sideEffects !== true) {
    throw new MailDataOperationReceiptError('mail_data_receipt_invalid', 'Mail data operation receipt state is invalid');
  }
  return {
    version: STORE_VERSION,
    recordedAt: new Date(value.recordedAt).toISOString(),
    ...identity,
    operation: value.operation,
    mailDomainId: value.mailDomainId.toLowerCase(),
    scope: value.scope,
    identity: value.identity,
    contentSha256: checksum(value.contentSha256, 'contentSha256'),
    bytes: count(value.bytes, 'bytes'),
    files: count(value.files, 'files'),
    directories: count(value.directories, 'directories'),
    sideEffects: true,
  };
}

function normalizeBackup(value) {
  const normalized = base(value, BACKUP_KEYS);
  if (value.operation !== OPERATIONS.MAIL_DATA_BACKUP
    || value.backupId !== normalized.jobId || !BACKUP_ID_PATTERN.test(value.backupId)
    || typeof value.sourcePresent !== 'boolean'
    || value.backedUp !== true) {
    throw new MailDataOperationReceiptError('mail_data_receipt_invalid', 'Mail data backup receipt is invalid');
  }
  return Object.freeze({
    ...normalized,
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    backupId: value.backupId,
    sourcePresent: value.sourcePresent,
    sourceSnapshotSha256: checksum(value.sourceSnapshotSha256, 'sourceSnapshotSha256'),
    backedUp: true,
  });
}

function normalizeRestore(value) {
  const normalized = base(value, RESTORE_KEYS);
  const expectedPreRestore = `pre-restore:${normalized.jobId}`;
  if (value.operation !== OPERATIONS.MAIL_DATA_RESTORE
    || value.transactionId !== normalized.jobId || !BACKUP_ID_PATTERN.test(value.transactionId)
    || typeof value.backupId !== 'string' || !BACKUP_ID_PATTERN.test(value.backupId)
    || value.preRestoreBackupId !== expectedPreRestore || !BACKUP_ID_PATTERN.test(value.preRestoreBackupId)
    || value.restoredPresent !== true || value.applied !== true) {
    throw new MailDataOperationReceiptError('mail_data_receipt_invalid', 'Mail data restore receipt is invalid');
  }
  return Object.freeze({
    ...normalized,
    operation: OPERATIONS.MAIL_DATA_RESTORE,
    transactionId: value.transactionId,
    backupId: value.backupId,
    preRestoreBackupId: value.preRestoreBackupId,
    restoredPresent: true,
    applied: true,
  });
}

function normalizeDelete(value) {
  const normalized = base(value, DELETE_KEYS);
  if (value.operation !== OPERATIONS.MAIL_DATA_DELETE
    || value.transactionId !== normalized.jobId || !BACKUP_ID_PATTERN.test(value.transactionId)
    || typeof value.backupId !== 'string' || !BACKUP_ID_PATTERN.test(value.backupId)
    || typeof value.resourceId !== 'string' || !UUID_PATTERN.test(value.resourceId)
    || (value.scope === 'domain' && value.resourceId !== normalized.mailDomainId)
    || typeof value.sourcePresent !== 'boolean' || value.deleted !== true) {
    throw new MailDataOperationReceiptError('mail_data_receipt_invalid', 'Mail data delete receipt is invalid');
  }
  return Object.freeze({
    ...normalized,
    operation: OPERATIONS.MAIL_DATA_DELETE,
    transactionId: value.transactionId,
    backupId: value.backupId,
    resourceId: value.resourceId.toLowerCase(),
    sourcePresent: value.sourcePresent,
    deleted: true,
  });
}

function normalizeReceipt(value) {
  if (value?.operation === OPERATIONS.MAIL_DATA_BACKUP) return normalizeBackup(value);
  if (value?.operation === OPERATIONS.MAIL_DATA_RESTORE) return normalizeRestore(value);
  if (value?.operation === OPERATIONS.MAIL_DATA_DELETE) return normalizeDelete(value);
  throw new MailDataOperationReceiptError('mail_data_receipt_invalid', 'Mail data receipt operation is invalid');
}

export function createMailDataOperationReceiptStore({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new MailDataOperationReceiptError('mail_data_receipt_root_invalid', 'Mail data receipt root must be an absolute normalized path');
  }

  function receiptPath(serverId, jobId) {
    const identity = normalizeIdentity(serverId, jobId);
    return path.join(root, identity.serverId, `${identity.jobId}.json`);
  }

  async function write({ serverId, jobId, operation, result } = {}) {
    const identity = normalizeIdentity(serverId, jobId);
    const receipt = normalizeReceipt({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      ...identity,
      operation,
      ...result,
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
    try {
      const metadata = await lstatFn(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
        throw new MailDataOperationReceiptError('mail_data_receipt_unsafe', 'Mail data receipt is not a protected regular file');
      }
      return normalizeReceipt(JSON.parse(await readFileFn(target, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof MailDataOperationReceiptError) throw error;
      throw new MailDataOperationReceiptError('mail_data_receipt_read_failed', 'Mail data receipt could not be read');
    }
  }

  return Object.freeze({ write, read, receiptPath });
}

export const mailDataOperationReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeIdentity,
  normalizeReceipt,
});