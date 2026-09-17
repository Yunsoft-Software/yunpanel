import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertDomainName, assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 2;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ALGORITHM_PATTERN = /^[A-Z][A-Z0-9_-]{1,63}$/;
const KEY_TYPES = new Set(['ksk', 'csk']);
const DS_PATTERN = /^(\d{1,5}) (\d{1,3}) (\d{1,3}) ([A-F0-9]+)$/;
const STAGES = Object.freeze([
  'create_new_key',
  'publish_new_key',
  'verify_dnskey_propagation',
  'activate_new_key',
  'await_parent_ds_addition',
  'await_old_ds_retirement',
  'deactivate_old_key',
  'delete_old_key',
]);
const STATUSES = Object.freeze([
  'pending',
  'creating_key',
  'publishing_key',
  'verifying_dnskey_propagation',
  'activating_key',
  'awaiting_parent_ds_addition',
  'awaiting_parent_ds_retirement',
  'deactivating_old_key',
  'deleting_old_key',
  'succeeded',
  'failed',
]);
const STATUS_SET = new Set(STATUSES);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);
const NEXT_STATUS = Object.freeze({
  pending: 'creating_key',
  creating_key: 'publishing_key',
  publishing_key: 'verifying_dnskey_propagation',
  verifying_dnskey_propagation: 'activating_key',
  activating_key: 'awaiting_parent_ds_addition',
  awaiting_parent_ds_addition: 'awaiting_parent_ds_retirement',
  awaiting_parent_ds_retirement: 'deactivating_old_key',
  deactivating_old_key: 'deleting_old_key',
});

export class DnsZoneDnssecRolloverRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneDnssecRolloverRegistryError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message = 'DNSSEC rollover operation state is invalid') {
  return new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_operation_state_invalid', message, 409);
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw invalid(`DNSSEC rollover ${field} is invalid`); }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invalid('DNSSEC rollover timestamp is invalid');
  }
  return value;
}

function sha256(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw invalid(`DNSSEC rollover ${field} is invalid`);
  return value;
}

function dnsStrings(value, field, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > 32 || (required && value.length === 0)
    || value.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 2048 || /[\r\n\u0000]/.test(entry))) {
    throw invalid(`DNSSEC rollover ${field} is invalid`);
  }
  return Object.freeze([...value]);
}

function dsRecords(value, field, options = {}) {
  const records = dnsStrings(value, field, options);
  if (records.some((entry) => {
    const match = entry.match(DS_PATTERN);
    return !match || Number.parseInt(match[1], 10) > 65535
      || Number.parseInt(match[2], 10) > 255 || Number.parseInt(match[3], 10) > 255
      || match[4].length < 2 || match[4].length % 2 !== 0;
  })) throw invalid(`DNSSEC rollover ${field} is invalid`);
  return records;
}

function keyIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32
    || value.some((entry) => !Number.isSafeInteger(entry) || entry < 0)
    || new Set(value).size !== value.length) {
    throw invalid('DNSSEC rollover key identifiers are invalid');
  }
  return Object.freeze([...value].sort((left, right) => left - right));
}

function oldKey(value) {
  const fields = new Set(['id', 'keyType', 'algorithm', 'bits', 'ds']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !Number.isSafeInteger(value.id) || value.id < 0
    || typeof value.keyType !== 'string' || !KEY_TYPES.has(value.keyType)
    || typeof value.algorithm !== 'string' || !ALGORITHM_PATTERN.test(value.algorithm)
    || !Number.isSafeInteger(value.bits) || value.bits < 1 || value.bits > 65535) {
    throw invalid('DNSSEC rollover current key is invalid');
  }
  return Object.freeze({
    id: value.id,
    keyType: value.keyType,
    algorithm: value.algorithm,
    bits: value.bits,
    ds: dsRecords(value.ds, 'current key DS', { required: true }),
  });
}

function newKey(value) {
  const fields = new Set(['keyType', 'algorithm', 'bits', 'active', 'published']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.keyType !== 'string' || !KEY_TYPES.has(value.keyType)
    || typeof value.algorithm !== 'string' || !ALGORITHM_PATTERN.test(value.algorithm)
    || !Number.isSafeInteger(value.bits) || value.bits < 1 || value.bits > 65535
    || value.active !== false || value.published !== false) {
    throw invalid('DNSSEC rollover new key target is invalid');
  }
  return Object.freeze({
    keyType: value.keyType,
    algorithm: value.algorithm,
    bits: value.bits,
    active: false,
    published: false,
  });
}

function propagation(value) {
  if (value === null) return null;
  const fields = new Set(['status', 'serial', 'checkedAt']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !['synced', 'disabled'].includes(value.status)
    || !Number.isSafeInteger(value.serial) || value.serial < 1) {
    throw invalid('DNSSEC rollover propagation evidence is invalid');
  }
  return Object.freeze({ status: value.status, serial: value.serial, checkedAt: timestamp(value.checkedAt) });
}

function evidence(value) {
  const fields = new Set(['newKeyId', 'keySetDigest', 'targetKeySetDigest', 'newKeyDs', 'serial', 'parentDs', 'propagation']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || (value.newKeyId !== null && (!Number.isSafeInteger(value.newKeyId) || value.newKeyId < 0))
    || (value.serial !== null && (!Number.isSafeInteger(value.serial) || value.serial < 1))) {
    throw invalid('DNSSEC rollover evidence is invalid');
  }
  return Object.freeze({
    newKeyId: value.newKeyId,
    keySetDigest: sha256(value.keySetDigest, 'key-set digest'),
    targetKeySetDigest: value.targetKeySetDigest === null
      ? null
      : sha256(value.targetKeySetDigest, 'target key-set digest'),
    newKeyDs: dsRecords(value.newKeyDs, 'new key DS'),
    serial: value.serial,
    parentDs: dsRecords(value.parentDs, 'parent DS'),
    propagation: propagation(value.propagation),
  });
}

function safeError(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || typeof value.code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    throw invalid('DNSSEC rollover error evidence is invalid');
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function safeResult(value) {
  if (value === null) return null;
  const fields = new Set(['oldKeyId', 'newKeyId', 'keySetDigest', 'serial', 'parentDs']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !Number.isSafeInteger(value.oldKeyId) || value.oldKeyId < 0
    || !Number.isSafeInteger(value.newKeyId) || value.newKeyId < 0 || value.newKeyId === value.oldKeyId
    || !Number.isSafeInteger(value.serial) || value.serial < 1) {
    throw invalid('DNSSEC rollover result evidence is invalid');
  }
  return Object.freeze({
    oldKeyId: value.oldKeyId,
    newKeyId: value.newKeyId,
    keySetDigest: sha256(value.keySetDigest, 'result key-set digest'),
    serial: value.serial,
    parentDs: dsRecords(value.parentDs, 'result parent DS', { required: true }),
  });
}

function validateProgress(operation) {
  if (operation.status === 'failed') return;
  const requiresNewKey = !['pending', 'creating_key'].includes(operation.status);
  const requiresPropagation = ['activating_key', 'awaiting_parent_ds_addition', 'awaiting_parent_ds_retirement',
    'deactivating_old_key', 'deleting_old_key', 'succeeded'].includes(operation.status);
  const requiresTargetDigest = ['publishing_key', 'activating_key', 'deactivating_old_key', 'deleting_old_key'].includes(operation.status);
  if (requiresNewKey && (operation.evidence.newKeyId === null
    || operation.evidence.newKeyId === operation.oldKey.id || operation.evidence.newKeyDs.length === 0)) {
    throw invalid('DNSSEC rollover stage is missing new key evidence');
  }
  if (requiresPropagation && operation.evidence.propagation === null) {
    throw invalid('DNSSEC rollover stage is missing propagation evidence');
  }
  if (requiresTargetDigest && operation.evidence.targetKeySetDigest === null) {
    throw invalid('DNSSEC rollover mutation stage is missing target key-set evidence');
  }
  if (!requiresTargetDigest && !TERMINAL_STATUSES.has(operation.status) && operation.evidence.targetKeySetDigest !== null) {
    throw invalid('DNSSEC rollover non-mutation stage cannot retain target key-set evidence');
  }
}

function persistedOperation(value) {
  const fields = new Set([
    'id', 'domainId', 'serverId', 'zoneName', 'previewDigest', 'confirmation', 'status',
    'expectedKeySetDigest', 'expectedKeyIds', 'oldKey', 'newKey', 'initialParentDs',
    'evidence', 'result', 'error', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.zoneName !== 'string' || !value.zoneName
    || typeof value.confirmation !== 'string' || !value.confirmation
    || !STATUS_SET.has(value.status)) {
    throw invalid();
  }
  const normalizedOldKey = oldKey(value.oldKey);
  const normalizedNewKey = newKey(value.newKey);
  const normalizedIds = keyIds(value.expectedKeyIds);
  const normalizedParent = dsRecords(value.initialParentDs, 'initial parent DS', { required: true });
  let normalizedZone;
  try { normalizedZone = assertDomainName(value.zoneName); }
  catch { throw invalid('DNSSEC rollover zone name is invalid'); }
  if (normalizedZone !== value.zoneName) throw invalid('DNSSEC rollover zone name is not canonical');
  const operation = Object.freeze({
    id: uuid(value.id, 'operationId'),
    domainId: uuid(value.domainId, 'domainId'),
    serverId: uuid(value.serverId, 'serverId'),
    zoneName: normalizedZone,
    previewDigest: sha256(value.previewDigest, 'preview digest'),
    confirmation: value.confirmation,
    status: value.status,
    expectedKeySetDigest: sha256(value.expectedKeySetDigest, 'expected key-set digest'),
    expectedKeyIds: normalizedIds,
    oldKey: normalizedOldKey,
    newKey: normalizedNewKey,
    initialParentDs: normalizedParent,
    evidence: evidence(value.evidence),
    result: safeResult(value.result),
    error: safeError(value.error),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
  if (!normalizedIds.includes(normalizedOldKey.id)
    || normalizedNewKey.keyType !== normalizedOldKey.keyType
    || normalizedNewKey.algorithm !== normalizedOldKey.algorithm
    || normalizedNewKey.bits !== normalizedOldKey.bits
    || normalizedParent.some((entry) => !normalizedOldKey.ds.includes(entry))) {
    throw invalid('DNSSEC rollover preview identity is inconsistent');
  }
  if (operation.confirmation !== `rollover-dnssec:${operation.domainId}:${operation.previewDigest}`) {
    throw invalid('DNSSEC rollover confirmation identity is inconsistent');
  }
  if (operation.status === 'succeeded' && operation.result === null) throw invalid('Succeeded rollover is missing result evidence');
  if (operation.status !== 'succeeded' && operation.result !== null) throw invalid('Non-succeeded rollover cannot contain result evidence');
  if (operation.status === 'failed' && operation.error === null) throw invalid('Failed rollover is missing error evidence');
  if (operation.status !== 'failed' && operation.error !== null) throw invalid('Non-failed rollover cannot contain error evidence');
  validateProgress(operation);
  return operation;
}

function operationFromPreview(preview, now, idFactory) {
  if (!preview || preview.action !== 'dnssec_key_rollover' || preview.applyAllowed !== true
    || !Array.isArray(preview.blockers) || preview.blockers.length !== 0
    || !Array.isArray(preview.stages) || JSON.stringify(preview.stages) !== JSON.stringify(STAGES)) {
    throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_preview_invalid', 'DNSSEC rollover preview cannot be journaled', 409);
  }
  const createdAt = new Date(now()).toISOString();
  return persistedOperation({
    id: idFactory(),
    domainId: preview.domainId,
    serverId: preview.serverId,
    zoneName: preview.zoneName,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    status: 'pending',
    expectedKeySetDigest: preview.expectedKeySetDigest,
    expectedKeyIds: preview.expectedKeyIds,
    oldKey: preview.oldKey,
    newKey: preview.newKey,
    initialParentDs: preview.parentDs,
    evidence: {
      newKeyId: null,
      keySetDigest: preview.expectedKeySetDigest,
      targetKeySetDigest: null,
      newKeyDs: [],
      serial: null,
      parentDs: preview.parentDs,
      propagation: null,
    },
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function dnsZoneDnssecRolloverPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    domainId: operation.domainId,
    serverId: operation.serverId,
    zoneName: operation.zoneName,
    previewDigest: operation.previewDigest,
    status: operation.status,
    expectedKeySetDigest: operation.expectedKeySetDigest,
    expectedKeyIds: operation.expectedKeyIds,
    oldKey: operation.oldKey,
    newKey: operation.newKey,
    initialParentDs: operation.initialParentDs,
    evidence: operation.evidence,
    result: operation.result,
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createDnsZoneDnssecRolloverRegistry({
  filePath = null,
  now = () => Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_registry_dependencies_invalid', 'DNSSEC rollover registry dependencies are unavailable', 503);
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
        if (![1, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.operations)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'operations'].includes(field))) {
          throw invalid('DNSSEC rollover operation store is invalid');
        }
        const migrated = parsed.version === 1
          ? parsed.operations.map((entry) => ({
            ...entry,
            evidence: entry?.evidence && typeof entry.evidence === 'object' && !Array.isArray(entry.evidence)
              ? { ...entry.evidence, targetKeySetDigest: null }
              : entry?.evidence,
          }))
          : parsed.operations;
        const operations = migrated.map(persistedOperation);
        if (new Set(operations.map((entry) => entry.id)).size !== operations.length) {
          throw invalid('DNSSEC rollover operation IDs are not unique');
        }
        state = { version: STORE_VERSION, operations };
        if (parsed.version === 1) await persist();
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

  async function mutate(operationId, update) {
    await ensureInitialized();
    const id = uuid(operationId, 'operationId');
    const index = state.operations.findIndex((entry) => entry.id === id);
    if (index < 0) throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_operation_not_found', 'DNSSEC rollover operation was not found', 404);
    const next = persistedOperation({
      ...state.operations[index],
      ...update,
      updatedAt: new Date(now()).toISOString(),
    });
    state.operations[index] = next;
    await persist();
    return next;
  }

  async function create(preview) {
    await ensureInitialized();
    const duplicate = state.operations.find((entry) => entry.domainId === preview?.domainId
      && entry.previewDigest === preview?.previewDigest && entry.status !== 'failed');
    if (duplicate) return duplicate;
    if (state.operations.some((entry) => entry.domainId === preview?.domainId && !TERMINAL_STATUSES.has(entry.status))) {
      throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_operation_conflict', 'Another DNSSEC rollover is active for this Domain', 409);
    }
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

  async function listActive() {
    await ensureInitialized();
    return state.operations.filter((entry) => !TERMINAL_STATUSES.has(entry.status));
  }

  async function advance(operationId, targetStatus, nextEvidence) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_operation_not_found', 'DNSSEC rollover operation was not found', 404);
    const normalizedEvidence = evidence(nextEvidence);
    if (current.status === targetStatus) {
      if (JSON.stringify(current.evidence) !== JSON.stringify(normalizedEvidence)) {
        throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_evidence_conflict', 'DNSSEC rollover stage already has different evidence', 409);
      }
      return current;
    }
    if (NEXT_STATUS[current.status] !== targetStatus) {
      throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_transition_invalid', 'DNSSEC rollover stage transition is invalid', 409);
    }
    return mutate(current.id, { status: targetStatus, evidence: normalizedEvidence, result: null, error: null });
  }

  async function succeed(operationId, result) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_operation_not_found', 'DNSSEC rollover operation was not found', 404);
    const normalized = safeResult(result);
    if (current.status === 'succeeded') {
      if (JSON.stringify(current.result) !== JSON.stringify(normalized)) {
        throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_result_conflict', 'DNSSEC rollover already completed with different evidence', 409);
      }
      return current;
    }
    if (current.status !== 'deleting_old_key') {
      throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_transition_invalid', 'DNSSEC rollover cannot complete from its current stage', 409);
    }
    return mutate(current.id, {
      status: 'succeeded',
      evidence: {
        ...current.evidence,
        keySetDigest: normalized.keySetDigest,
        targetKeySetDigest: null,
        serial: normalized.serial,
        parentDs: normalized.parentDs,
      },
      result: normalized,
      error: null,
    });
  }

  async function fail(operationId, error) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_operation_not_found', 'DNSSEC rollover operation was not found', 404);
    if (current.status === 'failed') return current;
    if (current.status === 'succeeded') {
      throw new DnsZoneDnssecRolloverRegistryError('dnssec_rollover_transition_invalid', 'Completed DNSSEC rollover cannot fail', 409);
    }
    return mutate(current.id, { status: 'failed', result: null, error: safeError(error) });
  }

  return Object.freeze({ init, create, get, listForDomain, listActive, advance, succeed, fail });
}

export const dnsZoneDnssecRolloverRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  stages: STAGES,
  statuses: STATUSES,
  nextStatus: NEXT_STATUS,
  persistedOperation,
  operationFromPreview,
  evidence,
  dsRecords,
  safeResult,
  safeError,
});
