import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/mail-config-rollbacks';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const STATUS_SET = new Set(['disabled', 'enabled']);
const RECEIPT_KEYS = Object.freeze([
  'version', 'recordedAt', 'serverId', 'jobId', 'mailDomainId', 'sourceApplyJobId',
  'previousRevision', 'expectedCurrentRevision', 'currentStatus', 'targetStatus', 'previewDigest',
  'currentConfigurationSha256', 'sourcePlanSha256', 'backupSha256',
  'compensationBackupSha256', 'restored',
]);
const WRITE_KEYS = Object.freeze(RECEIPT_KEYS.filter((key) => !['version', 'recordedAt'].includes(key)));

export class MailConfigRollbackReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailConfigRollbackReceiptError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_identity_invalid', 'Managed mail rollback receipt identity is invalid');
  }
  return { serverId, jobId };
}

function normalizeJobId(value, field) {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_job_invalid', `Managed mail rollback receipt ${field} is invalid`);
  }
  return value;
}

function normalizeChecksum(value, field) {
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) {
    throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_checksum_invalid', `Managed mail rollback receipt ${field} is invalid`);
  }
  return value;
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).length !== RECEIPT_KEYS.length
    || Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key))) {
    throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_invalid', 'Managed mail rollback receipt is invalid');
  }
  const identity = normalizeIdentity(value.serverId, value.jobId);
  const statusesValid = STATUS_SET.has(value.currentStatus) && STATUS_SET.has(value.targetStatus);
  const statusChanged = statusesValid && value.currentStatus !== value.targetStatus;
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.mailDomainId !== 'string' || !UUID_PATTERN.test(value.mailDomainId)
    || !Number.isSafeInteger(value.previousRevision) || value.previousRevision < 1
    || !Number.isSafeInteger(value.expectedCurrentRevision) || value.expectedCurrentRevision < 1
    || value.expectedCurrentRevision !== value.previousRevision + (statusChanged ? 1 : 0)
    || !statusesValid || value.restored !== true) {
    throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_invalid', 'Managed mail rollback receipt state is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: new Date(value.recordedAt).toISOString(),
    ...identity,
    mailDomainId: value.mailDomainId.toLowerCase(),
    sourceApplyJobId: normalizeJobId(value.sourceApplyJobId, 'sourceApplyJobId'),
    previousRevision: value.previousRevision,
    expectedCurrentRevision: value.expectedCurrentRevision,
    currentStatus: value.currentStatus,
    targetStatus: value.targetStatus,
    previewDigest: normalizeChecksum(value.previewDigest, 'previewDigest'),
    currentConfigurationSha256: normalizeChecksum(value.currentConfigurationSha256, 'currentConfigurationSha256'),
    sourcePlanSha256: normalizeChecksum(value.sourcePlanSha256, 'sourcePlanSha256'),
    backupSha256: normalizeChecksum(value.backupSha256, 'backupSha256'),
    compensationBackupSha256: normalizeChecksum(value.compensationBackupSha256, 'compensationBackupSha256'),
    restored: true,
  });
}

export function createMailConfigRollbackReceiptStore({
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
    throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_root_invalid', 'Managed mail rollback receipt root must be an absolute normalized path');
  }

  function receiptPath(serverId, jobId) {
    const identity = normalizeIdentity(serverId, jobId);
    return path.join(root, identity.serverId, `${identity.jobId}.json`);
  }

  async function write(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== WRITE_KEYS.length
      || Object.keys(input).some((key) => !WRITE_KEYS.includes(key))) {
      throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_invalid', 'Managed mail rollback receipt input is invalid');
    }
    const identity = normalizeIdentity(input?.serverId, input?.jobId);
    const receipt = normalizeReceipt({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      ...identity,
      mailDomainId: input?.mailDomainId,
      sourceApplyJobId: input?.sourceApplyJobId,
      previousRevision: input?.previousRevision,
      expectedCurrentRevision: input?.expectedCurrentRevision,
      currentStatus: input?.currentStatus,
      targetStatus: input?.targetStatus,
      previewDigest: input?.previewDigest,
      currentConfigurationSha256: input?.currentConfigurationSha256,
      sourcePlanSha256: input?.sourcePlanSha256,
      backupSha256: input?.backupSha256,
      compensationBackupSha256: input?.compensationBackupSha256,
      restored: input?.restored,
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
        throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_unsafe', 'Managed mail rollback receipt is not a protected regular file');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof MailConfigRollbackReceiptError) throw error;
      throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_read_failed', 'Managed mail rollback receipt could not be inspected');
    }
    let raw;
    try { raw = await readFileFn(target, 'utf8'); }
    catch { throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_read_failed', 'Managed mail rollback receipt could not be read'); }
    try { return normalizeReceipt(JSON.parse(raw)); }
    catch (error) {
      if (error instanceof MailConfigRollbackReceiptError) throw error;
      throw new MailConfigRollbackReceiptError('mail_config_rollback_receipt_invalid', 'Managed mail rollback receipt is invalid');
    }
  }

  return Object.freeze({ write, read, receiptPath });
}

export const mailConfigRollbackReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeIdentity,
  normalizeChecksum,
  normalizeReceipt,
});
