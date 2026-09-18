import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 5;
const LEGACY_STORE_VERSION = 1;
const PREVIOUS_STORE_VERSION = 2;
const SOURCE_DIGEST_STORE_VERSION = 3;
const SOURCE_SNAPSHOT_STORE_VERSION = 4;
const STATUSES = new Set(['pending', 'applying', 'succeeded', 'failed', 'rolling_back', 'rolled_back', 'rollback_failed']);
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

function snapshotDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeSnapshotString(value, field, max = 16_384) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function safeSourceZoneSnapshot(value, expectedDigest) {
  if (value === null) return null;
  const rootFields = new Set(['version', 'zoneName', 'id', 'kind', 'dnssec', 'rrsets']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== rootFields.size || Object.keys(value).some((field) => !rootFields.has(field))
    || value.version !== 1 || typeof value.dnssec !== 'boolean' || !Array.isArray(value.rrsets)
    || value.rrsets.length < 1 || value.rrsets.length > 10_000) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply source snapshot is invalid', 409);
  }
  const rrsets = Object.freeze(value.rrsets.map((rrset) => {
    const rrsetFields = new Set(['name', 'type', 'ttl', 'records', 'comments']);
    if (!rrset || typeof rrset !== 'object' || Array.isArray(rrset)
      || Object.keys(rrset).length !== rrsetFields.size || Object.keys(rrset).some((field) => !rrsetFields.has(field))
      || typeof rrset.type !== 'string' || !/^[A-Z0-9-]{1,32}$/.test(rrset.type)
      || (rrset.ttl !== null && (!Number.isSafeInteger(rrset.ttl) || rrset.ttl < 0 || rrset.ttl > 2_147_483_647))
      || !Array.isArray(rrset.records) || rrset.records.length > 10_000
      || !Array.isArray(rrset.comments) || rrset.comments.length > 10_000) {
      throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply source RRset snapshot is invalid', 409);
    }
    return Object.freeze({
      name: safeSnapshotString(rrset.name, 'sourceZoneSnapshot.rrset.name', 1024),
      type: rrset.type,
      ttl: rrset.ttl,
      records: Object.freeze(rrset.records.map((record) => {
        const fields = new Set(['content', 'disabled']);
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
          || typeof record.content !== 'string' || record.content.length > 16_384
          || typeof record.disabled !== 'boolean') {
          throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply source record snapshot is invalid', 409);
        }
        return Object.freeze({ content: record.content, disabled: record.disabled });
      })),
      comments: Object.freeze(rrset.comments.map((comment) => {
        const fields = new Set(['account', 'content']);
        if (!comment || typeof comment !== 'object' || Array.isArray(comment)
          || Object.keys(comment).length !== fields.size || Object.keys(comment).some((field) => !fields.has(field))
          || typeof comment.account !== 'string' || comment.account.length > 1024
          || typeof comment.content !== 'string' || comment.content.length > 16_384) {
          throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply source comment snapshot is invalid', 409);
        }
        return Object.freeze({ account: comment.account, content: comment.content });
      })),
    });
  }));
  const snapshot = Object.freeze({
    version: 1,
    zoneName: safeSnapshotString(value.zoneName, 'sourceZoneSnapshot.zoneName', 1024),
    id: safeSnapshotString(value.id, 'sourceZoneSnapshot.id', 1024),
    kind: value.kind === null ? null : safeSnapshotString(value.kind, 'sourceZoneSnapshot.kind', 64),
    dnssec: value.dnssec,
    rrsets,
  });
  if (typeof expectedDigest !== 'string' || !SHA256_PATTERN.test(expectedDigest)
    || snapshotDigest(snapshot) !== expectedDigest) {
    throw new DnsZoneReapplyOperationRegistryError(
      'dns_zone_reapply_operation_state_invalid',
      'DNS zone reapply source snapshot digest does not match operation evidence',
      409,
    );
  }
  return snapshot;
}

function safeRollbackResult(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.satisfied !== true || typeof value.zoneName !== 'string' || !value.zoneName
    || !Number.isSafeInteger(value.restoredRrsetCount) || value.restoredRrsetCount < 0
    || typeof value.kindRestored !== 'boolean'
    || typeof value.sourceZoneDigest !== 'string' || !SHA256_PATTERN.test(value.sourceZoneDigest)) {
    throw new DnsZoneReapplyOperationRegistryError(
      'dns_zone_reapply_operation_state_invalid',
      'DNS zone reapply rollback result is invalid',
      409,
    );
  }
  return Object.freeze({
    satisfied: true,
    zoneName: value.zoneName,
    restoredRrsetCount: value.restoredRrsetCount,
    kindRestored: value.kindRestored,
    sourceZoneDigest: value.sourceZoneDigest,
  });
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
  const appliedZoneDigest = optionalDigest(value.appliedZoneDigest ?? null, 'appliedZoneDigest');
  const appliedZoneSnapshot = value.appliedZoneSnapshot == null
    ? null
    : safeSourceZoneSnapshot(value.appliedZoneSnapshot, appliedZoneDigest);
  if ((appliedZoneDigest === null) !== (appliedZoneSnapshot === null)) {
    throw new DnsZoneReapplyOperationRegistryError(
      'dns_zone_reapply_operation_state_invalid',
      'DNS zone reapply applied snapshot evidence is incomplete',
      409,
    );
  }
  return Object.freeze({
    satisfied: true,
    zoneName: value.zoneName,
    serial: value.serial,
    changedRrsetCount: value.changedRrsetCount,
    manualRrsetCount: value.manualRrsetCount,
    appliedZoneDigest,
    appliedZoneSnapshot,
  });
}

function publicResult(value) {
  if (value === null) return null;
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
    'mailStateDigest', 'sourceZoneDigest', 'sourceZoneSnapshot', 'appliedZoneDigest', 'appliedZoneSnapshot',
    'observedSerial', 'targetSerial', 'previewDigest', 'confirmation', 'status', 'result', 'error',
    'rollbackResult', 'rollbackError', 'createdAt', 'updatedAt',
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
    sourceZoneSnapshot: value.sourceZoneSnapshot === null
      ? null
      : safeSourceZoneSnapshot(value.sourceZoneSnapshot, value.sourceZoneDigest),
    appliedZoneDigest: optionalDigest(value.appliedZoneDigest, 'appliedZoneDigest'),
    appliedZoneSnapshot: value.appliedZoneSnapshot === null
      ? null
      : safeSourceZoneSnapshot(value.appliedZoneSnapshot, value.appliedZoneDigest),
    observedSerial: safeInteger(value.observedSerial, 'observedSerial', { min: 1, max: 4_294_967_295 }),
    targetSerial: safeInteger(value.targetSerial, 'targetSerial', { min: 1, max: 4_294_967_295 }),
    previewDigest: value.previewDigest,
    confirmation: value.confirmation,
    status: value.status,
    result: safeResult(value.result),
    error: safeError(value.error),
    rollbackResult: safeRollbackResult(value.rollbackResult),
    rollbackError: safeError(value.rollbackError),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
  if ((operation.sourceZoneDigest === null) !== (operation.sourceZoneSnapshot === null)
    || (operation.appliedZoneDigest === null) !== (operation.appliedZoneSnapshot === null)) {
    throw new DnsZoneReapplyOperationRegistryError(
      'dns_zone_reapply_operation_state_invalid',
      'DNS zone reapply rollback snapshot evidence is incomplete',
      409,
    );
  }
  const applyCompleted = ['succeeded', 'rolling_back', 'rolled_back', 'rollback_failed'].includes(operation.status);
  if (applyCompleted && operation.result === null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Completed DNS zone reapply operation is missing apply result evidence', 409);
  }
  if (!applyCompleted && operation.result !== null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Incomplete DNS zone reapply operation cannot contain apply result evidence', 409);
  }
  if (operation.status === 'failed' && operation.error === null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Failed DNS zone reapply operation is missing error evidence', 409);
  }
  if (operation.status !== 'failed' && operation.error !== null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Non-failed DNS zone reapply operation cannot contain apply error evidence', 409);
  }
  if (operation.status === 'rolled_back' && operation.rollbackResult === null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Completed DNS zone rollback is missing result evidence', 409);
  }
  if (operation.status !== 'rolled_back' && operation.rollbackResult !== null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Incomplete DNS zone rollback cannot contain result evidence', 409);
  }
  if (operation.status === 'rollback_failed' && operation.rollbackError === null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Failed DNS zone rollback is missing failure evidence', 409);
  }
  if (operation.status !== 'rollback_failed' && operation.rollbackError !== null) {
    throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'Non-failed DNS zone rollback cannot contain failure evidence', 409);
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
    result: publicResult(operation.result),
    error: operation.error,
    rollback: Object.freeze({
      available: ['succeeded', 'rollback_failed'].includes(operation.status)
        && operation.sourceZoneSnapshot !== null && operation.appliedZoneSnapshot !== null,
      status: operation.status === 'rolling_back'
        ? 'applying'
        : operation.status === 'rolled_back'
          ? 'succeeded'
          : operation.status === 'rollback_failed'
            ? 'failed'
            : 'idle',
      sourceZoneDigest: operation.sourceZoneDigest,
      appliedZoneDigest: operation.appliedZoneDigest,
      result: operation.rollbackResult,
      error: operation.rollbackError,
      automaticReplayBlocked: operation.status === 'rolling_back',
    }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

function operationFromPreview(preview, rollbackEvidence, now, idFactory) {
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
  if (!rollbackEvidence || rollbackEvidence.version !== 2
    || rollbackEvidence.sourceZoneDigest !== preview.sourceZoneDigest
    || !rollbackEvidence.sourceZoneSnapshot || typeof rollbackEvidence.sourceZoneSnapshot !== 'object'
    || typeof rollbackEvidence.appliedZoneDigest !== 'string' || !SHA256_PATTERN.test(rollbackEvidence.appliedZoneDigest)
    || !rollbackEvidence.appliedZoneSnapshot || typeof rollbackEvidence.appliedZoneSnapshot !== 'object') {
    throw new DnsZoneReapplyOperationRegistryError(
      'dns_zone_reapply_operation_source_snapshot_invalid',
      'DNS zone reapply operation requires exact before/after rollback snapshot evidence',
      409,
    );
  }
  const sourceZoneSnapshot = safeSourceZoneSnapshot(
    rollbackEvidence.sourceZoneSnapshot,
    preview.sourceZoneDigest,
  );
  const appliedZoneSnapshot = safeSourceZoneSnapshot(
    rollbackEvidence.appliedZoneSnapshot,
    rollbackEvidence.appliedZoneDigest,
  );
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
    sourceZoneSnapshot,
    appliedZoneDigest: rollbackEvidence.appliedZoneDigest,
    appliedZoneSnapshot,
    observedSerial: preview.observedSerial,
    targetSerial: preview.nextSerial,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    status: 'pending',
    result: null,
    error: null,
    rollbackResult: null,
    rollbackError: null,
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
        if (![LEGACY_STORE_VERSION, PREVIOUS_STORE_VERSION, SOURCE_DIGEST_STORE_VERSION, SOURCE_SNAPSHOT_STORE_VERSION, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.operations)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'operations'].includes(field))) {
          throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_state_invalid', 'DNS zone reapply operation store is invalid', 409);
        }
        const operations = parsed.operations.map((operation) => {
          const migrated = parsed.version === LEGACY_STORE_VERSION
            ? {
              ...operation,
              mailStateDigest: null,
              sourceZoneDigest: null,
              sourceZoneSnapshot: null,
              appliedZoneDigest: null,
              appliedZoneSnapshot: null,
              rollbackResult: operation.rollbackResult ?? null,
              rollbackError: operation.rollbackError ?? null,
            }
            : parsed.version === PREVIOUS_STORE_VERSION
              ? {
                ...operation,
                sourceZoneDigest: null,
                sourceZoneSnapshot: null,
                appliedZoneDigest: null,
                appliedZoneSnapshot: null,
                rollbackResult: operation.rollbackResult ?? null,
                rollbackError: operation.rollbackError ?? null,
              }
              : parsed.version === SOURCE_DIGEST_STORE_VERSION
                ? {
                  ...operation,
                  sourceZoneSnapshot: null,
                  appliedZoneDigest: null,
                  appliedZoneSnapshot: null,
                }
                : parsed.version === SOURCE_SNAPSHOT_STORE_VERSION
                  ? { ...operation, appliedZoneDigest: null, appliedZoneSnapshot: null, rollbackResult: null, rollbackError: null }
                  : operation,;
          return persistedOperation({
            ...migrated,
            rollbackResult: migrated.rollbackResult ?? null,
            rollbackError: migrated.rollbackError ?? null,
          });
        });
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

  async function create(preview, rollbackEvidence) {
    await ensureInitialized();
    const duplicate = state.operations.find((entry) => entry.domainId === preview?.domainId
      && entry.previewDigest === preview?.previewDigest
      && ['pending', 'applying', 'succeeded'].includes(entry.status));
    if (duplicate) {
      if (duplicate.sourceZoneSnapshot === null) {
        throw new DnsZoneReapplyOperationRegistryError(
          'dns_zone_reapply_operation_source_snapshot_missing',
          'Existing DNS zone reapply operation predates exact rollback snapshot evidence',
          409,
        );
      }
      return duplicate;
    }
    const operation = operationFromPreview(preview, rollbackEvidence, now, idFactory);
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

  async function listInterruptedRollbacks() {
    await ensureInitialized();
    return state.operations.filter((entry) => entry.status === 'rolling_back');
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

  async function markRollingBack(operationId) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    if (current.status === 'rolling_back') return current;
    if (!['succeeded', 'rollback_failed'].includes(current.status)) {
      throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_rollback_not_available', 'DNS zone reapply operation cannot be rolled back from its current state', 409);
    }
    if (current.sourceZoneSnapshot === null || current.appliedZoneSnapshot === null) {
      throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_rollback_evidence_missing', 'DNS zone reapply operation has no exact rollback snapshot evidence', 409);
    }
    return mutate(current.id, {
      status: 'rolling_back',
      rollbackResult: null,
      rollbackError: null,
    });
  }

  async function succeedRollback(operationId, result) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    const normalized = safeRollbackResult(result);
    if (current.status === 'rolled_back') {
      if (JSON.stringify(current.rollbackResult) !== JSON.stringify(normalized)) {
        throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_rollback_result_conflict', 'DNS zone rollback already completed with different evidence', 409);
      }
      return current;
    }
    if (current.status !== 'rolling_back') {
      throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_rollback_not_applying', 'DNS zone rollback is not applying', 409);
    }
    return mutate(current.id, {
      status: 'rolled_back',
      rollbackResult: normalized,
      rollbackError: null,
    });
  }

  async function failRollback(operationId, error) {
    const current = await get(operationId);
    if (!current) throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    if (current.status === 'rollback_failed') return current;
    if (current.status !== 'rolling_back') {
      throw new DnsZoneReapplyOperationRegistryError('dns_zone_reapply_rollback_not_applying', 'DNS zone rollback is not applying', 409);
    }
    return mutate(current.id, {
      status: 'rollback_failed',
      rollbackResult: null,
      rollbackError: safeError(error),
    });
  }

  return Object.freeze({
    init,
    create,
    get,
    listForDomain,
    listInterrupted,
    listInterruptedRollbacks,
    markApplying,
    succeed,
    fail,
    markRollingBack,
    succeedRollback,
    failRollback,
  });
}

export const dnsZoneReapplyOperationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  legacyStoreVersion: LEGACY_STORE_VERSION,
  previousStoreVersion: PREVIOUS_STORE_VERSION,
  sourceDigestStoreVersion: SOURCE_DIGEST_STORE_VERSION,
  sourceSnapshotStoreVersion: SOURCE_SNAPSHOT_STORE_VERSION,
  statuses: Object.freeze([...STATUSES]),
  persistedOperation,
  operationFromPreview,
  safeResult,
  safeRollbackResult,
  publicResult,
  safeError,
  optionalDigest,
  safeSourceZoneSnapshot,
  snapshotDigest,
});
