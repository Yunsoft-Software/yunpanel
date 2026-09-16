import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const STATUSES = new Set(['pending', 'applying', 'succeeded', 'failed']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATE_PATTERN = /^[a-z0-9_]{1,80}$/;

export class DnsZoneDnssecOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneDnssecOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new DnsZoneDnssecOperationRegistryError(
      `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      `${field} is invalid`,
    );
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'DNSSEC operation timestamp is invalid', 409);
  }
  return value;
}

function dnsStrings(value, field) {
  if (!Array.isArray(value) || value.length > 32
    || value.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 2048 || /[\r\n\u0000]/.test(entry))) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', `DNSSEC ${field} evidence is invalid`, 409);
  }
  return Object.freeze([...value]);
}

function safeResult(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.zoneName !== 'string' || !value.zoneName
    || typeof value.dnssec !== 'boolean'
    || typeof value.status !== 'string' || !STATE_PATTERN.test(value.status)
    || typeof value.secureReady !== 'boolean'
    || (value.serial !== null && (!Number.isSafeInteger(value.serial) || value.serial < 1))
    || typeof value.parentStatus !== 'string' || !['present', 'absent', 'unverifiable'].includes(value.parentStatus)) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'DNSSEC operation result evidence is invalid', 409);
  }
  return Object.freeze({
    zoneName: value.zoneName,
    dnssec: value.dnssec,
    status: value.status,
    secureReady: value.secureReady,
    serial: value.serial ?? null,
    ds: dnsStrings(value.ds, 'DS'),
    parentStatus: value.parentStatus,
    parentRecords: dnsStrings(value.parentRecords, 'parent DS'),
    parentMatchingRecords: dnsStrings(value.parentMatchingRecords, 'matching DS'),
  });
}

function safeError(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'DNSSEC operation error evidence is invalid', 409);
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function persistedOperation(value) {
  const fields = new Set([
    'id', 'domainId', 'serverId', 'zoneName', 'targetEnabled', 'previewDigest', 'confirmation',
    'status', 'result', 'error', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.zoneName !== 'string' || !value.zoneName
    || typeof value.targetEnabled !== 'boolean'
    || typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation
    || !STATUSES.has(value.status)) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'DNSSEC operation state is invalid', 409);
  }
  const operation = Object.freeze({
    id: uuid(value.id, 'operationId'),
    domainId: uuid(value.domainId, 'domainId'),
    serverId: uuid(value.serverId, 'serverId'),
    zoneName: value.zoneName,
    targetEnabled: value.targetEnabled,
    previewDigest: value.previewDigest,
    confirmation: value.confirmation,
    status: value.status,
    result: safeResult(value.result),
    error: safeError(value.error),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
  if (operation.status === 'succeeded' && operation.result === null) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'Succeeded DNSSEC operation is missing result evidence', 409);
  }
  if (operation.status !== 'succeeded' && operation.result !== null) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'Non-succeeded DNSSEC operation cannot contain result evidence', 409);
  }
  if (operation.status === 'failed' && operation.error === null) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'Failed DNSSEC operation is missing error evidence', 409);
  }
  if (operation.status !== 'failed' && operation.error !== null) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'Non-failed DNSSEC operation cannot contain error evidence', 409);
  }
  return operation;
}

export function dnsZoneDnssecOperationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    domainId: operation.domainId,
    serverId: operation.serverId,
    zoneName: operation.zoneName,
    targetEnabled: operation.targetEnabled,
    previewDigest: operation.previewDigest,
    status: operation.status,
    result: operation.result,
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

function operationFromPreview(preview, now, idFactory) {
  if (!preview || preview.applyAllowed !== true || preview.noChanges === true
    || typeof preview.domainId !== 'string' || typeof preview.serverId !== 'string'
    || typeof preview.zoneName !== 'string' || !preview.zoneName
    || typeof preview.targetEnabled !== 'boolean'
    || typeof preview.previewDigest !== 'string' || !SHA256_PATTERN.test(preview.previewDigest)
    || typeof preview.confirmation !== 'string' || !preview.confirmation) {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_preview_invalid', 'DNSSEC preview cannot be journaled', 409);
  }
  const createdAt = new Date(now()).toISOString();
  return persistedOperation({
    id: idFactory(),
    domainId: preview.domainId,
    serverId: preview.serverId,
    zoneName: preview.zoneName,
    targetEnabled: preview.targetEnabled,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    status: 'pending',
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function createDnsZoneDnssecOperationRegistry({
  filePath = null,
  now = () => Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_dependencies_invalid', 'DNSSEC operation registry dependencies are unavailable', 503);
  }
  let state = { version: STORE_VERSION, operations: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.operations)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'operations'].includes(field))) {
          throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'DNSSEC operation store is invalid', 409);
        }
        const operations = parsed.operations.map(persistedOperation);
        if (new Set(operations.map((entry) => entry.id)).size !== operations.length) {
          throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_state_invalid', 'DNSSEC operation IDs are not unique', 409);
        }
        state = { version: STORE_VERSION, operations };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist();
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function create(preview) {
    await ensureInitialized();
    const duplicate = state.operations.find((entry) => entry.domainId === preview?.domainId
      && entry.previewDigest === preview?.previewDigest
      && ['pending', 'applying', 'succeeded'].includes(entry.status));
    if (duplicate) return duplicate;
    const operation = operationFromPreview(preview, now, idFactory);
    state.operations.push(operation);
    await persist();
    return operation;
  }

  async function get(operationId) {
    await ensureInitialized();
    const id = uuid(operationId, 'operationId');
    return state.operations.find((entry) => entry.id === id) ?? null;
  }

  async function listForDomain(domainId) {
    await ensureInitialized();
    const id = uuid(domainId, 'domainId');
    return state.operations.filter((entry) => entry.domainId === id);
  }

  async function listInterrupted() {
    await ensureInitialized();
    return state.operations.filter((entry) => entry.status === 'applying');
  }

  async function mutate(operationId, update) {
    await ensureInitialized();
    const id = uuid(operationId, 'operationId');
    const index = state.operations.findIndex((entry) => entry.id === id);
    if (index < 0) throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_not_found', 'DNSSEC operation was not found', 404);
    const next = persistedOperation({
      ...state.operations[index],
      ...update,
      updatedAt: new Date(now()).toISOString(),
    });
    state.operations[index] = next;
    await persist();
    return next;
  }

  async function markApplying(operationId) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_not_found', 'DNSSEC operation was not found', 404);
    if (current.status === 'applying') return current;
    if (current.status !== 'pending') {
      throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_not_pending', 'DNSSEC operation is not pending', 409);
    }
    return mutate(current.id, { status: 'applying', result: null, error: null });
  }

  async function succeed(operationId, result) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_not_found', 'DNSSEC operation was not found', 404);
    const normalized = safeResult(result);
    if (current.status === 'succeeded') {
      if (JSON.stringify(current.result) !== JSON.stringify(normalized)) {
        throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_result_conflict', 'DNSSEC operation already completed with different evidence', 409);
      }
      return current;
    }
    if (current.status !== 'applying') {
      throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_not_applying', 'DNSSEC operation is not applying', 409);
    }
    return mutate(current.id, { status: 'succeeded', result: normalized, error: null });
  }

  async function fail(operationId, error) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_not_found', 'DNSSEC operation was not found', 404);
    if (current.status === 'failed') return current;
    if (!['pending', 'applying'].includes(current.status)) {
      throw new DnsZoneDnssecOperationRegistryError('dnssec_operation_not_mutable', 'DNSSEC operation cannot fail from its current state', 409);
    }
    return mutate(current.id, { status: 'failed', result: null, error: safeError(error) });
  }

  return Object.freeze({ init, create, get, listForDomain, listInterrupted, markApplying, succeed, fail });
}

export const dnsZoneDnssecOperationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  statuses: Object.freeze([...STATUSES]),
  persistedOperation,
  operationFromPreview,
  safeResult,
  safeError,
});
