import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OPERATIONS } from '@yunpanel/protocol';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/website-crons';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPERATIONS_SET = new Set([
  OPERATIONS.CRON_APPLY,
  OPERATIONS.CRON_REMOVE,
]);

export class WebsiteCronOperationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteCronOperationReceiptError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !UUID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new WebsiteCronOperationReceiptError('website_cron_receipt_identity_invalid', 'Website cron receipt identity is invalid');
  }
  return { serverId: serverId.toLowerCase(), jobId };
}

function normalizeResult(operation, result) {
  const terminalField = operation === OPERATIONS.CRON_APPLY ? 'applied' : 'removed';
  const fields = [
    'version', 'taskId', 'websiteId', 'applicationId', 'unixUser',
    'revision', 'desiredStateSha256', 'contentSha256', terminalField, 'sideEffects',
  ];
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== fields.length || fields.some((field) => !Object.hasOwn(result, field))
    || result.version !== 1
    || typeof result.taskId !== 'string' || !UUID_PATTERN.test(result.taskId)
    || typeof result.websiteId !== 'string' || !UUID_PATTERN.test(result.websiteId)
    || typeof result.applicationId !== 'string' || !UUID_PATTERN.test(result.applicationId)
    || typeof result.unixUser !== 'string' || !APP_USER_PATTERN.test(result.unixUser)
    || !Number.isSafeInteger(result.revision) || result.revision < 1
    || typeof result.desiredStateSha256 !== 'string' || !SHA256_PATTERN.test(result.desiredStateSha256)
    || (result.contentSha256 !== null && (typeof result.contentSha256 !== 'string' || !SHA256_PATTERN.test(result.contentSha256)))
    || result[terminalField] !== true || typeof result.sideEffects !== 'boolean') {
    throw new WebsiteCronOperationReceiptError('website_cron_receipt_result_invalid', 'Website cron receipt result is invalid');
  }
  return Object.freeze({
    version: 1,
    taskId: result.taskId.toLowerCase(),
    websiteId: result.websiteId.toLowerCase(),
    applicationId: result.applicationId.toLowerCase(),
    unixUser: result.unixUser,
    revision: result.revision,
    desiredStateSha256: result.desiredStateSha256,
    contentSha256: result.contentSha256,
    [terminalField]: true,
    sideEffects: result.sideEffects,
  });
}

function normalizeReceipt(value) {
  const fields = ['version', 'recordedAt', 'serverId', 'jobId', 'operation', 'result'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))
    || value.version !== STORE_VERSION || !OPERATIONS_SET.has(value.operation)
    || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))) {
    throw new WebsiteCronOperationReceiptError('website_cron_receipt_invalid', 'Website cron receipt is invalid');
  }
  const identity = normalizeIdentity(value.serverId, value.jobId);
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: new Date(value.recordedAt).toISOString(),
    ...identity,
    operation: value.operation,
    result: normalizeResult(value.operation, value.result),
  });
}

export function createWebsiteCronOperationReceiptStore({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  chmodFn = chmod,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new WebsiteCronOperationReceiptError('website_cron_receipt_root_invalid', 'Website cron receipt root must be absolute');
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
    try { raw = await readFileFn(target, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new WebsiteCronOperationReceiptError('website_cron_receipt_read_failed', 'Website cron receipt could not be read');
    }
    try { return normalizeReceipt(JSON.parse(raw)); }
    catch (error) {
      if (error instanceof WebsiteCronOperationReceiptError) throw error;
      throw new WebsiteCronOperationReceiptError('website_cron_receipt_invalid', 'Website cron receipt is invalid');
    }
  }

  return Object.freeze({ write, read, receiptPath });
}

export const websiteCronOperationReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeIdentity,
  normalizeResult,
  normalizeReceipt,
});
