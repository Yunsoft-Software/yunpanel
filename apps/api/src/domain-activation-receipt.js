import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/domain-activations';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_KEYS = Object.freeze(['version', 'recordedAt', 'serverId', 'jobId', 'primaryDomain', 'checksum']);

export class DomainActivationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainActivationReceiptError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new DomainActivationReceiptError('domain_activation_receipt_identity_invalid', 'Domain activation receipt identity is invalid');
  }
  return { serverId, jobId };
}

function normalizePrimaryDomain(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new DomainActivationReceiptError('domain_activation_receipt_domain_invalid', 'Domain activation receipt hostname is invalid');
  }
  return value.toLowerCase();
}

function normalizeChecksum(value) {
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) {
    throw new DomainActivationReceiptError('domain_activation_receipt_checksum_invalid', 'Domain activation receipt checksum is invalid');
  }
  return value;
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key))) {
    throw new DomainActivationReceiptError('domain_activation_receipt_invalid', 'Domain activation receipt is invalid');
  }
  const identity = normalizeIdentity(value.serverId, value.jobId);
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))) {
    throw new DomainActivationReceiptError('domain_activation_receipt_invalid', 'Domain activation receipt timestamp is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: value.recordedAt,
    ...identity,
    primaryDomain: normalizePrimaryDomain(value.primaryDomain),
    checksum: normalizeChecksum(value.checksum),
  });
}

export function createDomainActivationReceiptStore({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  chmodFn = chmod,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new DomainActivationReceiptError('domain_activation_receipt_root_invalid', 'Domain activation receipt root must be absolute');
  }

  function receiptPath(serverId, jobId) {
    const identity = normalizeIdentity(serverId, jobId);
    return path.join(root, identity.serverId, `${identity.jobId}.json`);
  }

  async function write({ serverId, jobId, primaryDomain, checksum }) {
    const identity = normalizeIdentity(serverId, jobId);
    const receipt = normalizeReceipt({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      ...identity,
      primaryDomain,
      checksum,
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
      throw new DomainActivationReceiptError('domain_activation_receipt_read_failed', 'Domain activation receipt could not be read');
    }
    try {
      return normalizeReceipt(JSON.parse(raw));
    } catch (error) {
      if (error instanceof DomainActivationReceiptError) throw error;
      throw new DomainActivationReceiptError('domain_activation_receipt_invalid', 'Domain activation receipt is invalid');
    }
  }

  return Object.freeze({ write, read, receiptPath });
}

export const domainActivationReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeIdentity,
  normalizePrimaryDomain,
  normalizeChecksum,
  normalizeReceipt,
});
