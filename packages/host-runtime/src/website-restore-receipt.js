import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/backups/websites/.restore-receipts';
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['pre_restore_created', 'succeeded', 'rolled_back']);

const RECEIPT_FIELDS = new Set([
  'version',
  'transactionId',
  'websiteId',
  'websiteRevision',
  'repositoryId',
  'snapshotId',
  'preRestoreSnapshotId',
  'status',
  'rollbackReason',
  'healthCheck',
  'previewDigest',
  'committedAt',
]);

export class WebsiteRestoreReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteRestoreReceiptError';
    this.code = code;
  }
}

function transactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_ID_PATTERN.test(value)) {
    throw new WebsiteRestoreReceiptError('website_restore_receipt_transaction_invalid', 'Website restore receipt transaction identity is invalid');
  }
  return value;
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== RECEIPT_FIELDS.size
    || Object.keys(value).some((field) => !RECEIPT_FIELDS.has(field))
    || value.version !== STORE_VERSION
    || transactionId(value.transactionId) !== value.transactionId
    || typeof value.websiteRevision !== 'number' || !Number.isSafeInteger(value.websiteRevision) || value.websiteRevision < 1
    || typeof value.snapshotId !== 'string' || !SNAPSHOT_ID_PATTERN.test(value.snapshotId)
    || typeof value.preRestoreSnapshotId !== 'string' || !SNAPSHOT_ID_PATTERN.test(value.preRestoreSnapshotId)
    || !STATUSES.has(value.status)
    || typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.committedAt !== 'string' || !Number.isFinite(Date.parse(value.committedAt))) {
    throw new WebsiteRestoreReceiptError('website_restore_receipt_invalid', 'Website restore receipt is invalid');
  }
  try {
    assertUuid(value.websiteId, 'websiteId');
    assertUuid(value.repositoryId, 'repositoryId');
  } catch {
    throw new WebsiteRestoreReceiptError('website_restore_receipt_invalid', 'Website restore receipt contains invalid UUIDs');
  }
  if (value.status === 'rolled_back' && typeof value.rollbackReason !== 'string') {
    throw new WebsiteRestoreReceiptError('website_restore_receipt_invalid', 'Website restore receipt rolled_back status requires rollbackReason');
  }
  return Object.freeze({
    ...value,
    healthCheck: value.healthCheck ? Object.freeze({ ...value.healthCheck }) : null,
    committedAt: new Date(value.committedAt).toISOString(),
  });
}

function receiptInput(value, committedAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteRestoreReceiptError('website_restore_receipt_input_invalid', 'Website restore receipt input is invalid');
  }
  return normalizeReceipt({
    version: STORE_VERSION,
    transactionId: value.transactionId,
    websiteId: value.websiteId,
    websiteRevision: value.websiteRevision ?? 1,
    repositoryId: value.repositoryId,
    snapshotId: value.snapshotId,
    preRestoreSnapshotId: value.preRestoreSnapshotId,
    status: value.status,
    rollbackReason: value.rollbackReason ?? null,
    healthCheck: value.healthCheck ?? null,
    previewDigest: value.previewDigest,
    committedAt,
  });
}

function equivalentReceipt(existing, candidate) {
  return [...RECEIPT_FIELDS]
    .filter((field) => field !== 'committedAt')
    .every((field) => {
      if (field === 'healthCheck') {
        return JSON.stringify(existing.healthCheck) === JSON.stringify(candidate.healthCheck);
      }
      return existing[field] === candidate[field];
    });
}

export function createWebsiteRestoreReceiptStore({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  randomSuffix = () => randomBytes(8).toString('hex'),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)
    || typeof now !== 'function' || typeof randomSuffix !== 'function') {
    throw new WebsiteRestoreReceiptError('website_restore_receipt_dependencies_invalid', 'Website restore receipt dependencies are invalid');
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
      throw new WebsiteRestoreReceiptError('website_restore_receipt_read_failed', 'Website restore receipt could not be read');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      throw new WebsiteRestoreReceiptError('website_restore_receipt_file_invalid', 'Website restore receipt file is invalid');
    }
    try { return normalizeReceipt(JSON.parse(await readFile(filePath, 'utf8'))); }
    catch (error) {
      if (error instanceof WebsiteRestoreReceiptError) throw error;
      throw new WebsiteRestoreReceiptError('website_restore_receipt_invalid', 'Website restore receipt is invalid');
    }
  }

  async function write(value) {
    const id = transactionId(value?.transactionId);
    const existing = await read(id);
    const candidate = receiptInput(value, new Date(now()).toISOString());
    if (existing) {
      // If updating from pre_restore_created to terminal (succeeded or rolled_back), allow progress
      if (existing.status === 'pre_restore_created' && (candidate.status === 'succeeded' || candidate.status === 'rolled_back')) {
        // proceed with overwriting the receipt
      } else if (!equivalentReceipt(existing, candidate)) {
        throw new WebsiteRestoreReceiptError('website_restore_receipt_conflict', 'Website restore receipt conflicts with existing evidence');
      } else {
        return existing;
      }
    }

    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const temporaryPath = path.join(root, `.${id}.${process.pid}.${randomSuffix()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, receiptPath(id));
    } catch (error) {
      if (error instanceof WebsiteRestoreReceiptError) throw error;
      throw new WebsiteRestoreReceiptError('website_restore_receipt_write_failed', 'Website restore receipt could not be committed');
    } finally {
      await rm(temporaryPath, { force: true });
    }
    const committed = await read(id);
    if (!committed || !equivalentReceipt(committed, candidate)) {
      throw new WebsiteRestoreReceiptError('website_restore_receipt_commit_failed', 'Website restore receipt could not be verified after commit');
    }
    return committed;
  }

  return Object.freeze({ read, write, receiptPath });
}

export const websiteRestoreReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeReceipt,
  receiptInput,
  equivalentReceipt,
});
