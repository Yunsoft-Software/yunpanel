import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPowerDnsAuthoritativeSecureManager } from './powerdns-authoritative-secure-manager.js';
import {
  powerDnsAuthoritativeManagerInternals,
  PowerDnsAuthoritativeManagerError,
} from './powerdns-authoritative-manager.js';

const STORE_VERSION = 1;
const DEFAULT_OPERATION_PATH = '/var/lib/yunpanel/staging/powerdns/authoritative-operation.json';
const STATUSES = new Set(['applying', 'succeeded', 'failed']);
const DETERMINISTIC_FAILURE_CODES = new Set([
  'powerdns_recursor_conflict',
  'powerdns_include_dir_required',
  'powerdns_schema_missing',
  'powerdns_hash_failed',
  'powerdns_hash_invalid',
  'powerdns_config_invalid',
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
    || value.version !== STORE_VERSION || typeof value.id !== 'string' || !value.id
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
  if (operation.status === 'succeeded' && operation.result === null) {
    throw new PowerDnsAuthoritativeManagerError('powerdns_operation_state_invalid', 'Succeeded PowerDNS operation is missing result evidence');
  }
  if (operation.status !== 'succeeded' && operation.result !== null) {
    throw new PowerDnsAuthoritativeManagerError('powerdns_operation_state_invalid', 'Incomplete PowerDNS operation cannot contain result evidence');
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
    return persist({
      ...operation,
      ...update,
      version: STORE_VERSION,
      updatedAt: new Date(now()).toISOString(),
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

  async function apply(rawIntent) {
    const spec = powerDnsAuthoritativeManagerInternals.normalizeIntent(rawIntent);
    const existing = await readOperation();
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

    let operation = await createOperation(spec);
    let applied;
    try { applied = await manager.apply(spec); }
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
      operation = await mutate(operation, { status: 'applying', result: null, lastError: failure });
      void operation;
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

  return Object.freeze({ inspect, apply });
}

export const powerDnsAuthoritativeDurableManagerInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  operationPath: DEFAULT_OPERATION_PATH,
  statuses: Object.freeze([...STATUSES]),
  deterministicFailureCodes: Object.freeze([...DETERMINISTIC_FAILURE_CODES]),
  persistedOperation,
  safeFailure,
  operationMatches,
  evidenceFromInspection,
});
