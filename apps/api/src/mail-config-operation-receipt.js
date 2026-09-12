import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/mail-config-operations';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const STATUS_SET = new Set(['disabled', 'enabled']);
const RECEIPT_KEYS = Object.freeze([
  'version', 'recordedAt', 'serverId', 'jobId', 'mailDomainId', 'desiredStatus',
  'previewDigest', 'configurationSha256', 'planSha256', 'readinessSha256', 'applied',
]);

export class MailConfigOperationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailConfigOperationReceiptError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new MailConfigOperationReceiptError('mail_config_receipt_identity_invalid', 'Managed mail receipt identity is invalid');
  }
  return { serverId, jobId };
}

function normalizeMailDomainId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new MailConfigOperationReceiptError('mail_config_receipt_domain_invalid', 'Managed mail receipt domain identity is invalid');
  }
  return value.toLowerCase();
}

function normalizeChecksum(value, field) {
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) {
    throw new MailConfigOperationReceiptError('mail_config_receipt_checksum_invalid', `Managed mail receipt ${field} is invalid`);
  }
  return value;
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).length !== RECEIPT_KEYS.length
    || Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key))) {
    throw new MailConfigOperationReceiptError('mail_config_receipt_invalid', 'Managed mail operation receipt is invalid');
  }
  const identity = normalizeIdentity(value.serverId, value.jobId);
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || !STATUS_SET.has(value.desiredStatus) || value.applied !== true) {
    throw new MailConfigOperationReceiptError('mail_config_receipt_invalid', 'Managed mail operation receipt state is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: new Date(value.recordedAt).toISOString(),
    ...identity,
    mailDomainId: normalizeMailDomainId(value.mailDomainId),
    desiredStatus: value.desiredStatus,
    previewDigest: normalizeChecksum(value.previewDigest, 'previewDigest'),
    configurationSha256: normalizeChecksum(value.configurationSha256, 'configurationSha256'),
    planSha256: normalizeChecksum(value.planSha256, 'planSha256'),
    readinessSha256: normalizeChecksum(value.readinessSha256, 'readinessSha256'),
    applied: true,
  });
}

export function createMailConfigOperationReceiptStore({
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
    throw new MailConfigOperationReceiptError('mail_config_receipt_root_invalid', 'Managed mail receipt root must be an absolute normalized path');
  }

  function receiptPath(serverId, jobId) {
    const identity = normalizeIdentity(serverId, jobId);
    return path.join(root, identity.serverId, `${identity.jobId}.json`);
  }

  async function write(input) {
    const identity = normalizeIdentity(input?.serverId, input?.jobId);
    const receipt = normalizeReceipt({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      ...identity,
      mailDomainId: input?.mailDomainId,
      desiredStatus: input?.desiredStatus,
      previewDigest: input?.previewDigest,
      configurationSha256: input?.configurationSha256,
      planSha256: input?.planSha256,
      readinessSha256: input?.readinessSha256,
      applied: input?.applied,
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
    let metadata;
    try {
      metadata = await lstatFn(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
        throw new MailConfigOperationReceiptError('mail_config_receipt_unsafe', 'Managed mail operation receipt is not a protected regular file');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof MailConfigOperationReceiptError) throw error;
      throw new MailConfigOperationReceiptError('mail_config_receipt_read_failed', 'Managed mail operation receipt could not be inspected');
    }
    let raw;
    try { raw = await readFileFn(target, 'utf8'); }
    catch { throw new MailConfigOperationReceiptError('mail_config_receipt_read_failed', 'Managed mail operation receipt could not be read'); }
    try { return normalizeReceipt(JSON.parse(raw)); }
    catch (error) {
      if (error instanceof MailConfigOperationReceiptError) throw error;
      throw new MailConfigOperationReceiptError('mail_config_receipt_invalid', 'Managed mail operation receipt is invalid');
    }
  }

  return Object.freeze({ write, read, receiptPath });
}

export const mailConfigOperationReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeIdentity,
  normalizeMailDomainId,
  normalizeChecksum,
  normalizeReceipt,
});
