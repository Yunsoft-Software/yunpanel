import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPowerDnsAuthoritativeSecureManager } from './powerdns-authoritative-secure-manager.js';
import {
  powerDnsAuthoritativeManagerInternals,
  PowerDnsAuthoritativeManagerError,
} from './powerdns-authoritative-manager.js';

const LEGACY_STORE_VERSION = 1;
const STORE_VERSION = 2;
const DEFAULT_OPERATION_PATH = '/var/lib/yunpanel/staging/powerdns/authoritative-operation.json';
const STATUSES = new Set(['applying', 'succeeded', 'failed', 'rolling_back', 'rolled_back', 'rollback_failed']);
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DETERMINISTIC_FAILURE_CODES = new Set([
  'powerdns_recursor_conflict',
  'powerdns_include_dir_required',
  'powerdns_schema_missing',
  'powerdns_hash_failed',
  'powerdns_hash_invalid',
  'powerdns_config_invalid',
  'powerdns_rollback_snapshot_failed',
  'powerdns_rollback_credential_mismatch',
  'powerdns_rollback_snapshot_unsafe',
  'powerdns_rollback_snapshot_invalid',
  'powerdns_rollback_snapshot_unavailable',
  'powerdns_rollback_snapshot_conflict',
  'powerdns_rollback_context_invalid',
]);

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_operation_state_invalid',
      'PowerDNS authoritative operation timestamp is invalid',
    );
  }
  return value;
}

function safeError(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_operation_state_invalid',
      'PowerDNS authoritative operation error evidence is invalid',
    );
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function safePackages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.some((entry) => !entry || typeof entry !== 'object'
    || entry.installed !== true || typeof entry.version !== 'string' || !entry.version)) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_operation_evidence_invalid',
      'PowerDNS package evidence is invalid',
    );
  }
  return Object.freeze(value.map((entry) => Object.freeze({ installed: true, version: entry.version })));
}

function normalizeSecondaryDns(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_operation_state_invalid',
      'PowerDNS secondary DNS operation evidence is invalid',
    );
  }
  return Object.freeze([...value].sort());
}

function resultEvidence(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.satisfied !== true || typeof value.serverId !== 'string' || !value.serverId
    || !Number.isSafeInteger(value.apiKeyRevision) || value.apiKeyRevision < 1
    || typeof value.receiptAppliedAt !== 'string') {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_operation_evidence_invalid',
      'PowerDNS authoritative operation result evidence is invalid',
    );
  }
  return Object.freeze({
    satisfied: true,
    serverId: value.serverId,
    apiKeyRevision: value.apiKeyRevision,
    secondaryDns: normalizeSecondaryDns(value.secondaryDns),
    packages: safePackages(value.packages),
    receiptAppliedAt: timestamp(value.receiptAppliedAt),
  });
}

function persistedOperation(value) {
  const fields = new Set([
    'version', 'id', 'serverId', 'apiKeyRevision', 'secondaryDns', 'status', 'result', 'lastError', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || ![LEGACY_STORE_VERSION, STORE_VERSION].includes(value.version)
    || typeof value.id !== 'string' || !OPERATION_ID_PATTERN.test(value.id)
    || typeof value.serverId !== 'string' || !value.serverId
    || !Number.isSafeInteger(value.apiKeyRevision) || value.apiKeyRevision < 1
    || !STATUSES.has(value.status)) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_operation_state_invalid',
      'PowerDNS authoritative operation state is invalid',
    );
  }
  const operation = Object.freeze({
    version: STORE_VERSION,
    id: value.id,
    serverId: value.serverId,
    apiKeyRevision: value.apiKeyRevision,
    secondaryDns: normalizeSecondaryDns(value.secondaryDns),
    status: value.status,
    result: resultEvidence(value.result),
    lastError: safeError(value.lastError),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
  if (['succeeded', 'rolling_back', 'rolled_back', 'rollback_failed'].includes(operation.status)
    && operation.result === null) {
    throw new PowerDnsAuthoritativeManagerError('powerdns_operation_state_invalid', 'Completed PowerDNS apply evidence is missing');
  }
  if (['applying', 'failed'].includes(operation.status) && operation.result !== null) {
    throw new PowerDnsAuthoritativeManagerError('powerdns_operation_state_invalid', 'Incomplete PowerDNS apply cannot contain result evidence');
  }
  if (operation.status === 'applying' && operation.lastError !== null
    && !operation.lastError.code.startsWith('powerdns_')) {
    throw new PowerDnsAuthoritativeManagerError('powerdns_operation_state_invalid', 'PowerDNS recovery error code is invalid');
  }
  return operation;
}

function safeFailure(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
    ? error.code
    : 'powerdns_apply_failed';
  const message = typeof error?.message === 'string' && error.message.length > 0 && error.message.length <= 500
    ? error.message
    : 'PowerDNS authoritative apply failed';
  return Object.freeze({ code, message });
}

function operationMatches(operation, spec) {
  return Boolean(operation
    && operation.serverId === spec.serverId
    && operation.apiKeyRevision === spec.apiKeyRevision
    && JSON.stringify(operation.secondaryDns) === JSON.stringify([...spec.secondaryDns].sort()));
}

function evidenceFromInspection(spec, inspected) {
  if (!inspected || inspected.satisfied !== true
    || inspected.serverId !== spec.serverId
    || inspected.apiKeyRevision !== spec.apiKeyRevision
    || JSON.stringify(normalizeSecondaryDns(inspected.secondaryDns)) !== JSON.stringify(spec.secondaryDns)
    || typeof inspected.receipt?.appliedAt !== 'string') {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_operation_evidence_invalid',
      'PowerDNS authoritative post-condition evidence does not match the requested intent',
    );
  }
  return resultEvidence({
    satisfied: true,
    serverId: inspected.serverId,
    apiKeyRevision: inspected.apiKeyRevision,
    secondaryDns: inspected.secondaryDns,
    packages: inspected.packages,
    receiptAppliedAt: inspected.receipt.appliedAt,
  });
}

function publicOperation(operation) {
  if (!operation) return null;
  return Object.freeze({
    version: operation.version,
    id: operation.id,
    serverId: operation.serverId,
    credentialRevision: operation.apiKeyRevision,
    secondaryDns: operation.secondaryDns,
    status: operation.status,
    evidence: operation.result,
    failure: operation.lastError ? Object.freeze({ code: operation.lastError.code }) : null,
    recovery: Object.freeze({
      required: ['applying', 'rolling_back'].includes(operation.status),
      automaticReplayBlocked: ['applying', 'rolling_back'].includes(operation.status),
      reason: ['applying', 'rolling_back'].includes(operation.status)
        ? operation.lastError?.code ?? (operation.status === 'rolling_back'
          ? 'powerdns_interrupted_rollback'
          : 'powerdns_interrupted_apply')
        : null,
    }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createPowerDnsAuthoritativeDurableManager({
  manager = createPowerDnsAuthoritativeSecureManager(),
  operationPath = DEFAULT_OPERATION_PATH,
  now = () => Date.now(),
  idFactory = randomUUID,
  chmodFn = chmod,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (!manager || typeof manager.inspect !== 'function' || typeof manager.apply !== 'function'
    || typeof operationPath !== 'string' || !operationPath || typeof now !== 'function' || typeof idFactory !== 'function'
    || typeof chmodFn !== 'function' || typeof mkdirFn !== 'function' || typeof readFileFn !== 'function'
    || typeof renameFn !== 'function' || typeof writeFileFn !== 'function') {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_durable_manager_dependencies_invalid',
      'PowerDNS durable manager dependencies are unavailable',
    );
  }

  let writeChain = Promise.resolve();
  let mutationChain = Promise.resolve();

  function serializeMutation(operation) {
    const execution = mutationChain.then(operation, operation);
    mutationChain = execution.catch(() => {});
    return execution;
  }

  async function readOperation() {
    try { return persistedOperation(JSON.parse(await readFileFn(operationPath, 'utf8'))); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof PowerDnsAuthoritativeManagerError) throw error;
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_operation_state_invalid',
        'PowerDNS authoritative operation journal is invalid',
      );
    }
  }

  async function persist(operation) {
    const normalized = persistedOperation(operation);
    const directory = path.dirname(operationPath);
    const temporary = `${operationPath}.${process.pid}.tmp`;
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdirFn(directory, { recursive: true, mode: 0o700 });
      await chmodFn(directory, 0o700);
      await writeFileFn(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await renameFn(temporary, operationPath);
      await chmodFn(operationPath, 0o600);
    });
    await writeChain;
    return normalized;
  }

  async function mutate(operation, update) {
    const previous = Date.parse(operation.updatedAt);
    const current = now();
    return persist({
      ...operation,
      ...update,
      version: STORE_VERSION,
      updatedAt: new Date(Math.max(current, previous + 1)).toISOString(),
    });
  }

  async function createOperation(spec) {
    const createdAt = new Date(now()).toISOString();
    return persist({
      version: STORE_VERSION,
      id: idFactory(),
      serverId: spec.serverId,
      apiKeyRevision: spec.apiKeyRevision,
      secondaryDns: spec.secondaryDns,
      status: 'applying',
      result: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  async function inspect(rawIntent) {
    const spec = powerDnsAuthoritativeManagerInternals.normalizeIntent(rawIntent);
    return manager.inspect(spec);
  }

  async function operation() {
    const current = await readOperation();
    const projection = publicOperation(current);
    if (!projection || typeof manager.rollbackStatus !== 'function') return projection;
    const snapshot = await manager.rollbackStatus({
      operationId: current.id,
      serverId: current.serverId,
      credentialRevision: current.apiKeyRevision,
    });
    const completed = current.status === 'rolled_back';
    const eligible = ['succeeded', 'rolling_back', 'rollback_failed'].includes(current.status);
    return Object.freeze({
      ...projection,
      rollback: Object.freeze({
        status: current.status === 'rolling_back'
          ? 'applying'
          : completed
            ? 'succeeded'
            : current.status === 'rollback_failed'
              ? 'failed'
              : 'idle',
        available: snapshot.available === true && eligible,
        reason: completed ? 'powerdns_rollback_already_completed' : snapshot.reason,
        snapshotDigest: snapshot.snapshotDigest ?? null,
        previousSecondaryDns: snapshot.previousSecondaryDns ?? null,
        snapshotCreatedAt: snapshot.createdAt ?? null,
        automaticReplayBlocked: current.status === 'rolling_back',
      }),
    });
  }

  async function recoveryTarget(rawIntent, { operationId, expectedUpdatedAt } = {}) {
    const spec = powerDnsAuthoritativeManagerInternals.normalizeIntent(rawIntent);
    if (typeof operationId !== 'string' || !operationId
      || typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_recovery_request_invalid',
        'PowerDNS recovery requires an exact operation identity and journal revision',
      );
    }
    const existing = await readOperation();
    if (!existing || existing.status !== 'applying') {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_recovery_not_required',
        'PowerDNS authoritative operation does not require recovery',
      );
    }
    if (existing.id !== operationId || existing.updatedAt !== expectedUpdatedAt) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_recovery_stale',
        'PowerDNS recovery request does not match the current operation journal',
      );
    }
    if (!operationMatches(existing, spec)) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_operation_conflict',
        'Interrupted PowerDNS apply intent changed and cannot be recovered with current credentials or settings',
      );
    }
    return Object.freeze({ operation: existing, spec });
  }

  async function resolveOnce(rawIntent, recovery) {
    const { operation: existing, spec } = await recoveryTarget(rawIntent, recovery);
    return recoverInterrupted(existing, spec);
  }

  function resolve(rawIntent, recovery) {
    return serializeMutation(() => resolveOnce(rawIntent, recovery));
  }

  async function recoverInterrupted(operation, spec) {
    let inspected;
    try { inspected = await manager.inspect(spec); }
    catch {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_recovery_inspection_unavailable',
        'Interrupted PowerDNS apply cannot be replayed because current host state could not be inspected',
      );
    }
    if (inspected?.satisfied === true) {
      const result = evidenceFromInspection(spec, inspected);
      await mutate(operation, { status: 'succeeded', result, lastError: null });
      return inspected;
    }
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_recovery_pending',
      'Interrupted PowerDNS apply was inspected but is not proven complete; automatic mutation replay is blocked',
    );
  }

  async function executeApply(operation, spec) {
    let applied;
    try { applied = await manager.apply(spec, { operationId: operation.id }); }
    catch (error) {
      let after = null;
      let inspectionAvailable = true;
      try { after = await manager.inspect(spec); }
      catch { inspectionAvailable = false; }
      if (after?.satisfied === true) {
        const result = evidenceFromInspection(spec, after);
        await mutate(operation, { status: 'succeeded', result, lastError: null });
        return after;
      }
      const failure = safeFailure(error);
      if (DETERMINISTIC_FAILURE_CODES.has(failure.code)) {
        await mutate(operation, { status: 'failed', result: null, lastError: failure });
        throw error;
      }
      await mutate(operation, { status: 'applying', result: null, lastError: failure });
      throw new PowerDnsAuthoritativeManagerError(
        inspectionAvailable ? 'powerdns_apply_outcome_uncertain' : 'powerdns_recovery_inspection_unavailable',
        inspectionAvailable
          ? 'PowerDNS apply failed without a proven post-condition; operation remains applying and automatic replay is blocked'
          : 'PowerDNS apply failed and current host state cannot be inspected; operation remains applying and automatic replay is blocked',
      );
    }

    const result = evidenceFromInspection(spec, applied);
    await mutate(operation, { status: 'succeeded', result, lastError: null });
    return applied;
  }

  async function retryOnce(rawIntent, recovery) {
    const { operation: existing, spec } = await recoveryTarget(rawIntent, recovery);
    let before;
    try { before = await manager.inspect(spec); }
    catch {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_recovery_inspection_unavailable',
        'Interrupted PowerDNS apply cannot be retried because current host state could not be inspected',
      );
    }
    if (before?.satisfied === true) {
      const result = evidenceFromInspection(spec, before);
      await mutate(existing, { status: 'succeeded', result, lastError: null });
      return before;
    }
    const operation = await mutate(existing, {
      status: 'applying',
      result: null,
      lastError: Object.freeze({
        code: 'powerdns_explicit_retry_started',
        message: 'Operator-authorized PowerDNS retry started after current-state inspection',
      }),
    });
    return executeApply(operation, spec);
  }

  function retry(rawIntent, recovery) {
    return serializeMutation(() => retryOnce(rawIntent, recovery));
  }

  async function rollbackOnce(rawIntent, recovery = {}) {
    if (typeof manager.rollback !== 'function' || typeof manager.rollbackStatus !== 'function') {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_unavailable',
        'PowerDNS durable rollback dependency is unavailable',
      );
    }
    const fields = new Set(['operationId', 'expectedUpdatedAt', 'snapshotDigest']);
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)
      || Object.keys(recovery).length !== fields.size
      || Object.keys(recovery).some((field) => !fields.has(field))
      || typeof recovery.operationId !== 'string' || !OPERATION_ID_PATTERN.test(recovery.operationId)
      || typeof recovery.expectedUpdatedAt !== 'string' || !recovery.expectedUpdatedAt
      || typeof recovery.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(recovery.snapshotDigest)) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_request_invalid',
        'PowerDNS rollback requires exact operation, journal revision and snapshot digest',
      );
    }
    const spec = powerDnsAuthoritativeManagerInternals.normalizeIntent(rawIntent);
    const existing = await readOperation();
    if (!existing || !['succeeded', 'rolling_back', 'rolled_back', 'rollback_failed'].includes(existing.status)) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_not_available',
        'PowerDNS operation is not in a rollback-capable state',
      );
    }
    if (existing.id !== recovery.operationId || existing.updatedAt !== recovery.expectedUpdatedAt) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_stale',
        'PowerDNS rollback request does not match the current operation journal',
      );
    }
    if (!operationMatches(existing, spec)) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_operation_conflict',
        'PowerDNS rollback intent changed after the selected apply operation',
      );
    }
    const snapshot = await manager.rollbackStatus({
      operationId: existing.id,
      serverId: existing.serverId,
      credentialRevision: existing.apiKeyRevision,
    });
    if (snapshot.available !== true || snapshot.snapshotDigest !== recovery.snapshotDigest) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_snapshot_stale',
        'PowerDNS rollback snapshot is unavailable or no longer matches the request',
      );
    }
    const previousSpec = powerDnsAuthoritativeManagerInternals.normalizeIntent({
      ...spec,
      secondaryDns: snapshot.previousSecondaryDns,
    });
    if (existing.status === 'rolled_back') {
      const inspected = await manager.inspect(previousSpec);
      if (inspected?.satisfied !== true) {
        throw new PowerDnsAuthoritativeManagerError(
          'powerdns_rollback_recovery_unverified',
          'Completed PowerDNS rollback no longer matches current host state',
        );
      }
      return inspected;
    }

    const rollingBack = existing.status === 'rolling_back'
      ? existing
      : await mutate(existing, {
        status: 'rolling_back',
        result: existing.result,
        lastError: Object.freeze({
          code: 'powerdns_explicit_rollback_started',
          message: 'Operator-authorized PowerDNS rollback started from an exact snapshot',
        }),
      });
    try {
      const restored = await manager.rollback(spec, {
        operationId: rollingBack.id,
        snapshotDigest: recovery.snapshotDigest,
      });
      const result = evidenceFromInspection(previousSpec, restored);
      await mutate(rollingBack, { status: 'rolled_back', result, lastError: null });
      return restored;
    } catch (error) {
      const failure = safeFailure(error);
      await mutate(rollingBack, { status: 'rollback_failed', result: rollingBack.result, lastError: failure });
      throw error;
    }
  }

  function rollback(rawIntent, recovery) {
    return serializeMutation(() => rollbackOnce(rawIntent, recovery));
  }

  async function applyOnce(rawIntent) {
    const spec = powerDnsAuthoritativeManagerInternals.normalizeIntent(rawIntent);
    const existing = await readOperation();
    if (existing?.status === 'rolling_back') {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_recovery_pending',
        'Interrupted PowerDNS rollback must be explicitly resolved before applying authoritative intent',
      );
    }
    if (existing?.status === 'rollback_failed'
      && existing.lastError?.code === 'powerdns_rollback_compensation_failed') {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_recovery_pending',
        'PowerDNS rollback compensation failed; explicit recovery is required before another apply',
      );
    }
    if (existing?.status === 'applying') {
      if (!operationMatches(existing, spec)) {
        throw new PowerDnsAuthoritativeManagerError(
          'powerdns_operation_conflict',
          'A different interrupted PowerDNS apply must be resolved before changing authoritative DNS intent',
        );
      }
      return recoverInterrupted(existing, spec);
    }

    const before = await manager.inspect(spec);
    if (before?.satisfied === true) return before;

    const operation = await createOperation(spec);
    return executeApply(operation, spec);
  }

  function apply(rawIntent) {
    return serializeMutation(() => applyOnce(rawIntent));
  }

  return Object.freeze({ inspect, apply, operation, resolve, retry, rollback });
}

export const powerDnsAuthoritativeDurableManagerInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  legacyStoreVersion: LEGACY_STORE_VERSION,
  operationPath: DEFAULT_OPERATION_PATH,
  statuses: Object.freeze([...STATUSES]),
  deterministicFailureCodes: Object.freeze([...DETERMINISTIC_FAILURE_CODES]),
  persistedOperation,
  safeFailure,
  operationMatches,
  evidenceFromInspection,
  publicOperation,
});
