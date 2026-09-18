import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { powerDnsZoneManagerInternals } from '@yunpanel/host-runtime/powerdns-zone-manager';

const STORE_VERSION = 1;
const STATUSES = new Set(['pending', 'deleting', 'deleted', 'failed']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_RETENTION_DAYS = 3650;

export class DnsZoneRetirementOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneRetirementOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'DNS zone retirement operation timestamp is invalid',
      409,
    );
  }
  return value;
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      `${field} is invalid`,
      409,
    );
  }
  return value;
}

function safeDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      `${field} is invalid`,
      409,
    );
  }
  return value;
}

function safeError(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'DNS zone retirement failure evidence is invalid',
      409,
    );
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function normalizedSnapshot(value, expectedDigest) {
  let snapshot;
  try { snapshot = powerDnsZoneManagerInternals.zoneSnapshot(value); }
  catch {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'DNS zone retirement retained snapshot is invalid',
      409,
    );
  }
  const digest = powerDnsZoneManagerInternals.zoneSnapshotDigest(snapshot);
  if (digest !== safeDigest(expectedDigest, 'snapshotDigest')) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'DNS zone retirement retained snapshot digest is invalid',
      409,
    );
  }
  return snapshot;
}

function safeResult(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.deleted !== true || typeof value.changed !== 'boolean'
    || typeof value.snapshotDigest !== 'string' || !SHA256_PATTERN.test(value.snapshotDigest)
    || typeof value.deletedAt !== 'string' || typeof value.retainUntil !== 'string') {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'DNS zone retirement result evidence is invalid',
      409,
    );
  }
  const deletedAt = timestamp(value.deletedAt);
  const retainUntil = timestamp(value.retainUntil);
  if (Date.parse(retainUntil) <= Date.parse(deletedAt)) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'DNS zone retirement snapshot retention deadline is invalid',
      409,
    );
  }
  return Object.freeze({
    deleted: true,
    changed: value.changed,
    snapshotDigest: value.snapshotDigest,
    deletedAt,
    retainUntil,
  });
}

function persistedOperation(value) {
  const fields = new Set([
    'id', 'domainId', 'serverId', 'zoneName', 'domainRevision',
    'previewDigest', 'snapshotDigest', 'ownershipEvidenceDigest',
    'snapshotRetentionDays', 'snapshot', 'confirmation',
    'status', 'result', 'error', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || !STATUSES.has(value.status)
    || typeof value.zoneName !== 'string' || value.zoneName.length < 1 || value.zoneName.length > 253
    || /[\u0000-\u001f\u007f]/.test(value.zoneName)
    || !Number.isSafeInteger(value.domainRevision) || value.domainRevision < 1
    || !Number.isSafeInteger(value.snapshotRetentionDays)
    || value.snapshotRetentionDays < 1 || value.snapshotRetentionDays > MAX_RETENTION_DAYS
    || typeof value.confirmation !== 'string' || value.confirmation.length < 1 || value.confirmation.length > 1000) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'DNS zone retirement operation state is invalid',
      409,
    );
  }
  const operation = Object.freeze({
    id: safeId(value.id, 'operationId'),
    domainId: safeId(value.domainId, 'domainId'),
    serverId: safeId(value.serverId, 'serverId'),
    zoneName: value.zoneName,
    domainRevision: value.domainRevision,
    previewDigest: safeDigest(value.previewDigest, 'previewDigest'),
    snapshotDigest: safeDigest(value.snapshotDigest, 'snapshotDigest'),
    ownershipEvidenceDigest: safeDigest(value.ownershipEvidenceDigest, 'ownershipEvidenceDigest'),
    snapshotRetentionDays: value.snapshotRetentionDays,
    snapshot: normalizedSnapshot(value.snapshot, value.snapshotDigest),
    confirmation: value.confirmation,
    status: value.status,
    result: safeResult(value.result),
    error: safeError(value.error),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
  if (operation.status === 'deleted' && operation.result === null) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'Deleted DNS zone retirement operation is missing result evidence',
      409,
    );
  }
  if (operation.status !== 'deleted' && operation.result !== null) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'Incomplete DNS zone retirement operation cannot contain result evidence',
      409,
    );
  }
  if (operation.status === 'failed' && operation.error === null) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'Failed DNS zone retirement operation is missing error evidence',
      409,
    );
  }
  if (operation.status !== 'failed' && operation.error !== null) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_state_invalid',
      'Non-failed DNS zone retirement operation cannot contain failure evidence',
      409,
    );
  }
  return operation;
}

function operationFromCapture(capture, now, idFactory) {
  if (!capture || capture.version !== 1
    || typeof capture.domainId !== 'string' || typeof capture.serverId !== 'string'
    || typeof capture.zoneName !== 'string'
    || !Number.isSafeInteger(capture.domainRevision) || capture.domainRevision < 1
    || typeof capture.previewDigest !== 'string' || !SHA256_PATTERN.test(capture.previewDigest)
    || typeof capture.snapshotDigest !== 'string' || !SHA256_PATTERN.test(capture.snapshotDigest)
    || typeof capture.ownershipEvidenceDigest !== 'string' || !SHA256_PATTERN.test(capture.ownershipEvidenceDigest)
    || !Number.isSafeInteger(capture.snapshotRetentionDays)
    || capture.snapshotRetentionDays < 1 || capture.snapshotRetentionDays > MAX_RETENTION_DAYS
    || !capture.snapshot || typeof capture.snapshot !== 'object'
    || typeof capture.confirmation !== 'string' || !capture.confirmation) {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_capture_invalid',
      'DNS zone retirement capture cannot be journaled',
      409,
    );
  }
  const createdAt = new Date(now()).toISOString();
  return persistedOperation({
    id: idFactory(),
    domainId: capture.domainId,
    serverId: capture.serverId,
    zoneName: capture.zoneName,
    domainRevision: capture.domainRevision,
    previewDigest: capture.previewDigest,
    snapshotDigest: capture.snapshotDigest,
    ownershipEvidenceDigest: capture.ownershipEvidenceDigest,
    snapshotRetentionDays: capture.snapshotRetentionDays,
    snapshot: capture.snapshot,
    confirmation: capture.confirmation,
    status: 'pending',
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function dnsZoneRetirementOperationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    domainId: operation.domainId,
    serverId: operation.serverId,
    zoneName: operation.zoneName,
    domainRevision: operation.domainRevision,
    previewDigest: operation.previewDigest,
    snapshotDigest: operation.snapshotDigest,
    ownershipEvidenceDigest: operation.ownershipEvidenceDigest,
    snapshotRetentionDays: operation.snapshotRetentionDays,
    status: operation.status,
    result: operation.result,
    error: operation.error,
    recovery: Object.freeze({
      required: operation.status === 'deleting',
      automaticReplayBlocked: operation.status === 'deleting',
      reason: operation.status === 'deleting' ? 'dns_zone_retirement_interrupted_delete' : null,
    }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createDnsZoneRetirementOperationRegistry({
  filePath = null,
  now = () => Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new DnsZoneRetirementOperationRegistryError(
      'dns_zone_retirement_operation_dependencies_invalid',
      'DNS zone retirement operation registry dependencies are invalid',
      503,
    );
  }
  let state = { version: STORE_VERSION, operations: [] };
  let initialized = filePath === null;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const content = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    });
    await writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.operations)
          || Object.keys(parsed).length !== 2
          || Object.keys(parsed).some((field) => !['version', 'operations'].includes(field))) {
          throw new DnsZoneRetirementOperationRegistryError(
            'dns_zone_retirement_operation_state_invalid',
            'DNS zone retirement operation store is invalid',
            409,
          );
        }
        const operations = parsed.operations.map(persistedOperation);
        if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
          throw new DnsZoneRetirementOperationRegistryError(
            'dns_zone_retirement_operation_state_invalid',
            'DNS zone retirement operation IDs are not unique',
            409,
          );
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

  async function create(capture) {
    await ensureInitialized();
    const duplicate = state.operations.find((operation) => (
      operation.domainId === capture?.domainId
      && operation.snapshotDigest === capture?.snapshotDigest
      && ['pending', 'deleting', 'deleted'].includes(operation.status)
    ));
    if (duplicate) return duplicate;
    const operation = operationFromCapture(capture, now, idFactory);
    state.operations.push(operation);
    await persist();
    return operation;
  }

  async function get(operationId) {
    await ensureInitialized();
    const id = safeId(operationId, 'operationId');
    return state.operations.find((operation) => operation.id === id) ?? null;
  }

  async function listForDomain(domainId) {
    await ensureInitialized();
    const id = safeId(domainId, 'domainId');
    return Object.freeze(state.operations
      .filter((operation) => operation.domainId === id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  async function listInterrupted() {
    await ensureInitialized();
    return Object.freeze(state.operations.filter((operation) => operation.status === 'deleting'));
  }

  async function mutate(operation, update) {
    const index = state.operations.findIndex((candidate) => candidate.id === operation.id);
    if (index < 0) {
      throw new DnsZoneRetirementOperationRegistryError(
        'dns_zone_retirement_operation_not_found',
        'DNS zone retirement operation was not found',
        404,
      );
    }
    const previous = Date.parse(operation.updatedAt);
    const current = now();
    const next = persistedOperation({
      ...operation,
      ...update,
      updatedAt: new Date(Math.max(current, previous + 1)).toISOString(),
    });
    state.operations[index] = next;
    await persist();
    return next;
  }

  async function markDeleting(operationId) {
    const current = await get(operationId);
    if (!current) {
      throw new DnsZoneRetirementOperationRegistryError(
        'dns_zone_retirement_operation_not_found',
        'DNS zone retirement operation was not found',
        404,
      );
    }
    if (current.status === 'deleting') return current;
    if (!['pending', 'failed'].includes(current.status)) {
      throw new DnsZoneRetirementOperationRegistryError(
        'dns_zone_retirement_operation_not_retryable',
        'DNS zone retirement operation cannot enter deleting state',
        409,
      );
    }
    return mutate(current, { status: 'deleting', result: null, error: null });
  }

  async function succeed(operationId, { changed, snapshotDigest } = {}) {
    const current = await get(operationId);
    if (!current) {
      throw new DnsZoneRetirementOperationRegistryError(
        'dns_zone_retirement_operation_not_found',
        'DNS zone retirement operation was not found',
        404,
      );
    }
    if (current.status === 'deleted') return current;
    if (current.status !== 'deleting') {
      throw new DnsZoneRetirementOperationRegistryError(
        'dns_zone_retirement_operation_not_deleting',
        'DNS zone retirement operation is not deleting',
        409,
      );
    }
    if (typeof changed !== 'boolean' || snapshotDigest !== current.snapshotDigest) {
      throw new DnsZoneRetirementOperationRegistryError(
        'dns_zone_retirement_operation_result_invalid',
        'DNS zone retirement result does not match retained snapshot evidence',
        409,
      );
    }
    const deletedAtMs = now();
    if (!Number.isSafeInteger(deletedAtMs) || deletedAtMs < 0) {
      throw new DnsZoneRetirementOperationRegistryError(
        'dns_zone_retirement_operation_clock_invalid',
        'DNS zone retirement registry clock is invalid',
        503,
      );
    }
    const deletedAt = new Date(deletedAtMs).toISOString();
    const retainUntil = new Date(
      deletedAtMs + current.snapshotRetentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    return mutate(current, {
      status: 'deleted',
      result: {
        deleted: true,
        changed,
        snapshotDigest: current.snapshotDigest,
        deletedAt,
        retainUntil,
      },
      error: null,
    });
  }

  async function fail(operationId, error) {
    const current = await get(operationId);
    if (!current) {
      throw new DnsZoneRetirementOperationRegistryError(
        'dns_zone_retirement_operation_not_found',
        'DNS zone retirement operation was not found',
        404,
      );
    }
    if (current.status === 'failed') return current;
    if (!['pending', 'deleting'].includes(current.status)) {
      throw new DnsZoneRetirementOperationRegistryError(
        'dns_zone_retirement_operation_not_mutable',
        'DNS zone retirement operation cannot fail from its current state',
        409,
      );
    }
    return mutate(current, {
      status: 'failed',
      result: null,
      error: safeError(error),
    });
  }

  return Object.freeze({
    init,
    create,
    get,
    listForDomain,
    listInterrupted,
    markDeleting,
    succeed,
    fail,
  });
}

export const dnsZoneRetirementOperationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  statuses: Object.freeze([...STATUSES]),
  maxRetentionDays: MAX_RETENTION_DAYS,
  persistedOperation,
  operationFromCapture,
  safeError,
  safeResult,
  normalizedSnapshot,
});
