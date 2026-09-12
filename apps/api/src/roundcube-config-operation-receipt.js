import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/roundcube-config-operations';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_KEYS = Object.freeze([
  'version', 'recordedAt', 'serverId', 'jobId', 'previewSha256', 'configSha256',
  'fpmSha256', 'databaseCreated', 'applied',
]);

export class RoundcubeConfigOperationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoundcubeConfigOperationReceiptError';
    this.code = code;
  }
}

function identity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new RoundcubeConfigOperationReceiptError('roundcube_receipt_identity_invalid', 'Roundcube receipt identity is invalid');
  }
  return Object.freeze({ serverId, jobId });
}

function checksum(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new RoundcubeConfigOperationReceiptError('roundcube_receipt_checksum_invalid', `Roundcube receipt ${field} is invalid`);
  }
  return value;
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).length !== RECEIPT_KEYS.length
    || Object.keys(value).some((field) => !RECEIPT_KEYS.includes(field))) {
    throw new RoundcubeConfigOperationReceiptError('roundcube_receipt_invalid', 'Roundcube operation receipt is invalid');
  }
  const normalizedIdentity = identity(value.serverId, value.jobId);
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.databaseCreated !== 'boolean' || value.applied !== true) {
    throw new RoundcubeConfigOperationReceiptError('roundcube_receipt_invalid', 'Roundcube operation receipt state is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: new Date(value.recordedAt).toISOString(),
    ...normalizedIdentity,
    previewSha256: checksum(value.previewSha256, 'previewSha256'),
    configSha256: checksum(value.configSha256, 'configSha256'),
    fpmSha256: checksum(value.fpmSha256, 'fpmSha256'),
    databaseCreated: value.databaseCreated,
    applied: true,
  });
}

export function createRoundcubeConfigOperationReceiptStore({
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
    throw new RoundcubeConfigOperationReceiptError('roundcube_receipt_root_invalid', 'Roundcube receipt root must be an absolute normalized path');
  }

  function receiptPath(serverId, jobId) {
    const normalized = identity(serverId, jobId);
    return path.join(root, normalized.serverId, `${normalized.jobId}.json`);
  }

  async function write(input) {
    const normalizedIdentity = identity(input?.serverId, input?.jobId);
    const receipt = normalizeReceipt({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      ...normalizedIdentity,
      previewSha256: input?.previewSha256,
      configSha256: input?.configSha256,
      fpmSha256: input?.fpmSha256,
      databaseCreated: input?.databaseCreated,
      applied: input?.applied,
    });
    const directory = path.join(root, normalizedIdentity.serverId);
    const target = receiptPath(normalizedIdentity.serverId, normalizedIdentity.jobId);
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
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o7777) !== 0o600) {
        throw new RoundcubeConfigOperationReceiptError('roundcube_receipt_unsafe', 'Roundcube operation receipt is not a protected regular file');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof RoundcubeConfigOperationReceiptError) throw error;
      throw new RoundcubeConfigOperationReceiptError('roundcube_receipt_read_failed', 'Roundcube operation receipt could not be inspected');
    }
    try { return normalizeReceipt(JSON.parse(await readFileFn(target, 'utf8'))); }
    catch (error) {
      if (error instanceof RoundcubeConfigOperationReceiptError) throw error;
      throw new RoundcubeConfigOperationReceiptError('roundcube_receipt_invalid', 'Roundcube operation receipt is invalid');
    }
  }

  return Object.freeze({ write, read, receiptPath });
}

export const roundcubeConfigOperationReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  identity,
  checksum,
  normalizeReceipt,
});