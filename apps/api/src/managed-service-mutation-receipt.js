import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MANAGED_SERVICE_IDS, OPERATIONS } from '@yunpanel/protocol';
import { managedServiceStatePolicy } from './managed-service-state-policy.js';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/service-mutations';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,100}$/;
const PACKAGE_VERSION_PATTERN = /^[A-Za-z0-9.+:~_-]{1,100}$/;
const SYSTEMD_UNIT_PATTERN = /^[a-z0-9@_.-]{1,120}\.service$/;
const SYSTEMD_STATE_PATTERN = /^[a-z0-9-]{1,40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SERVICE_IDS = new Set(MANAGED_SERVICE_IDS);
const RECEIPT_KEYS = Object.freeze([
  'version', 'recordedAt', 'serverId', 'jobId', 'operation', 'serviceId', 'action', 'changed', 'stateDigest',
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

function normalizeServiceState(value, serviceId) {
  const policy = managedServiceStatePolicy(serviceId);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== serviceId
    || typeof value.installed !== 'boolean' || typeof value.active !== 'boolean'
    || !Array.isArray(value.packages) || value.packages.length !== policy.packages.length
    || !Array.isArray(value.units) || value.units.length !== policy.units.length) {
    throw new ManagedServiceMutationReceiptError('service_receipt_state_invalid', 'Managed service receipt state is invalid');
  }
  const packages = value.packages.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(entry.packageName)
      || typeof entry.installed !== 'boolean') {
      throw new ManagedServiceMutationReceiptError('service_receipt_state_invalid', 'Managed service receipt package state is invalid');
    }
    const version = entry.version == null ? null : entry.version;
    if (version !== null && (typeof version !== 'string' || !PACKAGE_VERSION_PATTERN.test(version))) {
      throw new ManagedServiceMutationReceiptError('service_receipt_state_invalid', 'Managed service receipt package version is invalid');
    }
    if (entry.installed !== Boolean(version)) {
      throw new ManagedServiceMutationReceiptError('service_receipt_state_invalid', 'Managed service receipt package state is inconsistent');
    }
    return { packageName: entry.packageName, installed: entry.installed, version };
  });
  const units = value.units.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.unit !== 'string' || !SYSTEMD_UNIT_PATTERN.test(entry.unit)
      || typeof entry.inspectionError !== 'boolean') {
      throw new ManagedServiceMutationReceiptError('service_receipt_state_invalid', 'Managed service receipt unit state is invalid');
    }
    const unit = { unit: entry.unit };
    for (const field of ['loadState', 'activeState', 'subState', 'unitFileState']) {
      if (typeof entry[field] !== 'string' || !SYSTEMD_STATE_PATTERN.test(entry[field])) {
        throw new ManagedServiceMutationReceiptError('service_receipt_state_invalid', 'Managed service receipt unit state is invalid');
      }
      unit[field] = entry[field];
    }
    unit.inspectionError = entry.inspectionError;
    return unit;
  });
  if (packages.some((entry, index) => entry.packageName !== policy.packages[index])
    || units.some((entry, index) => entry.unit !== policy.units[index])) {
    throw new ManagedServiceMutationReceiptError('service_receipt_state_invalid', 'Managed service receipt package or unit identities are invalid');
  }
  if (value.installed !== packages.every((entry) => entry.installed)
    || value.active !== (units.length > 0 && units.every((entry) => entry.activeState === 'active'))) {
    throw new ManagedServiceMutationReceiptError('service_receipt_state_invalid', 'Managed service receipt aggregate state is inconsistent');
  }
  return { id: serviceId, installed: value.installed, active: value.active, packages, units };
}

export function managedServiceStateDigest(value, serviceId) {
  const safeState = normalizeServiceState(value, normalizeServiceId(serviceId));
  return createHash('sha256').update(JSON.stringify(safeState)).digest('hex');
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key))) {
    throw new ManagedServiceMutationReceiptError('service_receipt_invalid', 'Managed service mutation receipt is invalid');
  }
  const { serverId, jobId } = normalizeIdentity(value.serverId, value.jobId);
  const serviceId = normalizeServiceId(value.serviceId);
  const mutation = normalizeMutation({ operation: value.operation, action: value.action, changed: value.changed });
  if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.stateDigest !== 'string' || !DIGEST_PATTERN.test(value.stateDigest)) {
    throw new ManagedServiceMutationReceiptError('service_receipt_invalid', 'Managed service mutation receipt metadata is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: value.recordedAt,
    serverId,
    jobId,
    ...mutation,
    serviceId,
    stateDigest: value.stateDigest,
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

  async function write({ serverId, jobId, operation, serviceId, action = null, changed = null, state }) {
    const identity = normalizeIdentity(serverId, jobId);
    const normalizedServiceId = normalizeServiceId(serviceId);
    const receipt = normalizeReceipt({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      ...identity,
      operation,
      serviceId: normalizedServiceId,
      action,
      changed,
      stateDigest: managedServiceStateDigest(state, normalizedServiceId),
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
  normalizeServiceState,
  normalizeReceipt,
});
