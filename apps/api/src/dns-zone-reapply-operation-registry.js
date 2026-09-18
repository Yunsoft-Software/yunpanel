import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 3;
const LEGACY_STORE_VERSION = 1;
const PREVIOUS_STORE_VERSION = 2;
const STATUSES = new Set(['pending', 'applying', 'succeeded', 'failed']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DnsZoneReapplyOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneReapplyOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new DnsZoneReapplyOperationRegistryError(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, `${field} is invalid`); }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply operation timestamp is invalid', 409);
  }
  return value;
}

function safeInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function optionalDigest(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function safeError(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply operation error state is invalid', 409);
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function safeResult(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.satisfied !== true
    || typeof value.zoneName !== 'string' || !value.zoneName
    || !Number.isSafeInteger(value.serial) || value.serial < 1
    || !Number.isSafeInteger(value.changedRrsetCount) || value.changedRrsetCount < 0
    || !Number.isSafeInteger(value.manualRrsetCount) || value.manualRrsetCount < 0) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply operation result is invalid', 409);
  }
  return Object.freeze({
    satisfied: true,
    zoneName: value.zoneName,
    serial: value.serial,
    changedRrsetCount: value.changedRrsetCount,
    manualRrsetCount: value.manualRrsetCount,
  });
}

function persistedOperation(value) {
  const fields = new Set([
    'id', 'domainId', 'serverId', 'zoneName', 'domainRevision', 'templateVersion', 'dnsIdentityRevision',
    'mailStateDigest', 'sourceZoneDigest', 'observedSerial', 'targetSerial', 'previewDigest', 'confirmation', 'status', 'result', 'error',
    'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.zoneName !== 'string' || !value.zoneName
    || typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation
    || !STATUSES.has(value.status)) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply operation state is invalid', 409);
  }
  const operation = Object.freeze({
    id: uuid(value.id, 'operationId'),
    domainId: uuid(value.domainId, 'domainId'),
    serverId: uuid(value.serverId, 'serverId'),
    zoneName: value.zoneName,
    domainRevision: value.domainRevision === null ? null : safeInteger(value.domainRevision, 'domainRevision', { min: 1 }),
    templateVersion: safeInteger(value.templateVersion, 'templateVersion', { min: 1 }),
    dnsIdentityRevision: safeInteger(value.dnsIdentityRevision, 'dnsIdentityRevision', { min: 1 }),
    mailStateDigest: optionalDigest(value.mailStateDigest, 'mailStateDigest'),
    sourceZoneDigest: optionalDigest(value.sourceZoneDigest, 'sourceZoneDigest'),
    observedSerial: safeInteger(value.observedSerial, 'observedSerial', { min: 1, max: 4_294_967_295 }),
    targetSerial: safeInteger(value.targetSerial, 'targetSerial', { min: 1, max: 4_294_967_295 }),
    previewDigest: value.previewDigest,
    confirmation: value.confirmation,
    status: value.status,
    result: safeResult(value.result),
    error: safeError(value.error),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
  if (operation.status === 'succeeded' && operation.result === null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Succeeded DNS zone reapply operation is missing result evidence', 409);
  }
  if (operation.status !== 'succeeded' && operation.result !== null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Non-succeeded DNS zone reapply operation cannot contain result evidence', 409);
  }
  if (operation.status === 'failed' && operation.error === null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Failed DNS zone reapply operation is missing error evidence', 409);
  }
  if (operation.status !== 'failed' && operation.error !== null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Non-failed DNS zone reapply operation cannot contain error evidence', 409);
  }
  return operation;
}

export function dnsZoneReapplyOperationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    domainId: operation.domainId,
    serverId: operation.serverId,
    zoneName: operation.zoneName,
    domainRevision: operation.domainRevision,
    templateVersion: operation.templateVersion,
    dnsIdentityRevision: operation.dnsIdentityRevision,
    mailStateDigest: operation.mailStateDigest,
    observedSerial: operation.observedSerial,
    targetSerial: operation.targetSerial,
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
    || !Number.isSafeInteger(preview.templateVersion) || preview.templateVersion < 1
    || !Number.isSafeInteger(preview.dnsIdentityRevision) || preview.dnsIdentityRevision < 1
    || typeof preview.mailStateDigest !== 'string' || !SHA256_PATTERN.test(preview.mailStateDigest)
    || typeof preview.sourceZoneDigest !== 'string' || !SHA256_PATTERN.test(preview.sourceZoneDigest)
    || !Number.isSafeInteger(preview.observedSerial) || preview.observedSerial < 1
    || !Number.isSafeInteger(preview.nextSerial) || preview.nextSerial < 1
    || typeof preview.previewDigest !== 'string' || !SHA256_PATTERN.test(preview.previewDigest)
    || typeof preview.confirmation !== 'string' || !preview.confirmation) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_preview_invalid', 'DNS zone reapply preview cannot be journaled', 409);
  }
  const timestampValue = new Date(now()).toISOString();
  return persistedOperation({
    id: idFactory(),
    domainId: preview.domainId,
    serverId: preview.serverId,
    zoneName: preview.zoneName,
    domainRevision: preview.domainRevision ?? null,
    templateVersion: preview.templateVersion,
    dnsIdentityRevision: preview.dnsIdentityRevision,
    mailStateDigest: preview.mailStateDigest,
    sourceZoneDigest: preview.sourceZoneDigest,
    observedSerial: preview.observedSerial,
    targetSerial: preview.nextSerial,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    status: 'pending',
    result: null,
    error: null,
    createdAt: timestampValue,
    updatedAt: timestampValue,
  });
}

export function createDnsZoneReapplyOperationRegistry({
  filePath = null,
  now = () => Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_dependencies_invalid', 'DNS zone reapply operation dependencies are unavailable', 503);
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
        if (![LEGACY_STORE_VERSION, PREVIOUS_STORE_VERSION, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.operations)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'operations'].includes(field))) {
          throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply operation store is invalid', 409);
        }
        const operations = parsed.operations.map((operation) => persistedOperation(
          parsed.version === LEGACY_STORE_VERSION
            ? { ...operation, mailStateDigest: null, sourceZoneDigest: null }
            : parsed.version === PREVIOUS_STORE_VERSION
              ? { ...operation, sourceZoneDigest: null }
              : operation,
        ));
        if (new Set(operations.map((entry) => entry.id)).size !== operations.length) {
          throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply operation IDs are not unique', 409);
        }
        state = { version: STORE_VERSION, operations };
        if (parsed.version !== STORE_VERSION) await persist();
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
    if (index < 0) throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    const current = state.operations[index];
    const next = persistedOperation({
      ...current,
      ...update,
      updatedAt: new Date(now()).toISOString(),
    });
    state.operations[index] = next;
    await persist();
    return next;
  }

  async function markApplying(operationId) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    if (current.status === 'applying') return current;
    if (current.status !== 'pending') {
      throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_pending', 'DNS zone reapply operation is not pending', 409);
    }
    return mutate(current.id, { status: 'applying', result: null, error: null });
  }

  async function succeed(operationId, result) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    const normalized = safeResult(result);
    if (current.status === 'succeeded') {
      if (JSON.stringify(current.result) !== JSON.stringify(normalized)) {
        throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_result_conflict', 'DNS zone reapply operation already completed with different evidence', 409);
      }
      return current;
    }
    if (current.status !== 'applying') {
      throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_applying', 'DNS zone reapply operation is not applying', 409);
    }
    return mutate(current.id, { status: 'succeeded', result: normalized, error: null });
  }

  async function fail(operationId, error) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    if (current.status === 'failed') return current;
    if (!['pending', 'applying'].includes(current.status)) {
      throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_mutable', 'DNS zone reapply operation cannot be failed from its current state', 409);
    }
    return mutate(current.id, { status: 'failed', result: null, error: safeError(error) });
  }

  return Object.freeze({ init, create, get, listForDomain, listInterrupted, markApplying, succeed, fail });
}

export const dnsZoneReapplyOperationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  legacyStoreVersion: LEGACY_STORE_VERSION,
  previousStoreVersion: PREVIOUS_STORE_VERSION,
  statuses: Object.freeze([...STATUSES]),
  persistedOperation,
  operationFromPreview,
  safeResult,
  safeError,
  optionalDigest,
});
