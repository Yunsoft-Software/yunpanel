import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MANAGED_SERVICE_IDS, OPERATIONS } from '@yunpanel/protocol';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/service-mutations';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SERVICE_IDS = new Set(MANAGED_SERVICE_IDS);
const RECEIPT_KEYS = Object.freeze([
  'version', 'recordedAt', 'serverId', 'jobId', 'operation', 'serviceId', 'action', 'changed',
]);

export class ManagedServiceMutationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedServiceMutationReceiptError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new ManagedServiceMutationReceiptError('service_receipt_identity_invalid', 'Managed service receipt identity is invalid');
  }
  return { serverId, jobId };
}

function normalizeServiceId(value) {
  if (typeof value !== 'string' || !SERVICE_IDS.has(value)) {
    throw new ManagedServiceMutationReceiptError('service_receipt_service_invalid', 'Managed service receipt service identity is invalid');
  }
  return value;
}

function normalizeMutation({ operation, action, changed }) {
  if (operation === OPERATIONS.SYSTEM_SERVICE_INSTALL) {
    if (action !== null || typeof changed !== 'boolean') {
      throw new ManagedServiceMutationReceiptError('service_receipt_mutation_invalid', 'Managed service install receipt metadata is invalid');
    }
    return { operation, action: null, changed };
  }
  if (operation === OPERATIONS.SYSTEM_SERVICE_CONTROL) {
    if (action !== 'restart' || changed !== null) {
      throw new ManagedServiceMutationReceiptError('service_receipt_mutation_invalid', 'Managed service restart receipt metadata is invalid');
    }
    return { operation, action: 'restart', changed: null };
  }
  throw new ManagedServiceMutationReceiptError('service_receipt_operation_invalid', 'Managed service receipt operation is not supported');
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key))) {
    throw new ManagedServiceMutationReceiptError('service_receipt_invalid', 'Managed service mutation receipt is invalid');
  }
  const { serverId, jobId } = normalizeIdentity(value.serverId, value.jobId);
  const serviceId = normalizeServiceId(value.serviceId);
  const mutation = normalizeMutation({ operation: value.operation, action: value.action, changed: value.changed });
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))) {
    throw new ManagedServiceMutationReceiptError('service_receipt_invalid', 'Managed service mutation receipt timestamp is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: value.recordedAt,
    serverId,
    jobId,
    ...mutation,
    serviceId,
  });
}

export function createManagedServiceMutationReceiptStore({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  chmodFn = chmod,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new ManagedServiceMutationReceiptError('service_receipt_root_invalid', 'Managed service receipt root must be absolute');
  }

  function receiptPath(serverId, jobId) {
    const identity = normalizeIdentity(serverId, jobId);
    return path.join(root, identity.serverId, `${identity.jobId}.json`);
  }

  async function write({ serverId, jobId, operation, serviceId, action = null, changed = null }) {
    const identity = normalizeIdentity(serverId, jobId);
    const receipt = normalizeReceipt({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      ...identity,
      operation,
      serviceId,
      action,
      changed,
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
      throw new ManagedServiceMutationReceiptError('service_receipt_read_failed', 'Managed service mutation receipt could not be read');
    }
    try {
      return normalizeReceipt(JSON.parse(raw));
    } catch (error) {
      if (error instanceof ManagedServiceMutationReceiptError) throw error;
      throw new ManagedServiceMutationReceiptError('service_receipt_invalid', 'Managed service mutation receipt is invalid');
    }
  }

  return Object.freeze({ write, read, receiptPath });
}

export const managedServiceMutationReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalizeIdentity,
  normalizeServiceId,
  normalizeMutation,
  normalizeReceipt,
});
