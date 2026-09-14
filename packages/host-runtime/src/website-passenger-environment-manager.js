import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertUuid,
  normalizeEnvironmentKey,
  normalizeEnvironmentValue,
} from '@yunpanel/shared';

const INCLUDE_ROOT = '/etc/yunpanel/passenger-env';
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/website-passenger-env';
const RECEIPT_VERSION = 1;
const INCLUDE_MODE = 0o600;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const MANAGED_ENVIRONMENT_KEYS = new Set([
  'NODE_ENV',
  'PASSENGER_APP_ENV',
  'RAILS_ENV',
  'RACK_ENV',
  'WSGI_ENV',
]);

export class WebsitePassengerEnvironmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsitePassengerEnvironmentError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function uuid(value, field, code) {
  try { return assertUuid(value, field); }
  catch { throw new WebsitePassengerEnvironmentError(code, `${field} is invalid`); }
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WebsitePassengerEnvironmentError('website_passenger_environment_revision_invalid', 'Passenger environment revision is invalid');
  }
  return value;
}

function normalizedValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) {
    throw new WebsitePassengerEnvironmentError('website_passenger_environment_values_invalid', 'Passenger environment values are invalid');
  }
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    let key;
    let environmentValue;
    try {
      key = normalizeEnvironmentKey(rawKey);
      environmentValue = normalizeEnvironmentValue(rawValue);
    } catch {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_values_invalid', 'Passenger environment contains an invalid variable');
    }
    if (MANAGED_ENVIRONMENT_KEYS.has(key) || Object.hasOwn(normalized, key)) {
      throw new WebsitePassengerEnvironmentError(
        'website_passenger_environment_reserved_key',
        'Passenger environment cannot override Passenger-managed application environment keys',
      );
    }
    normalized[key] = environmentValue;
  }
  return Object.freeze(Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right))));
}

function quoteNginxValue(value) {
  if (typeof value !== 'string' || value.includes('\u0000') || value.includes('\n') || value.includes('\r')) {
    throw new WebsitePassengerEnvironmentError('website_passenger_environment_values_invalid', 'Passenger environment value is invalid');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;
}

function renderInclude(applicationId, environmentRevision, values) {
  const lines = Object.entries(values).map(([key, value]) => `passenger_env_var ${key} ${quoteNginxValue(value)};`);
  return `# YunPanel Passenger environment ${applicationId} revision ${environmentRevision}\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

function normalizeSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsitePassengerEnvironmentError('website_passenger_environment_spec_invalid', 'Passenger environment specification is invalid');
  }
  const applicationId = uuid(value.applicationId, 'applicationId', 'website_passenger_environment_application_invalid');
  const environmentRevision = revision(value.environmentRevision);
  const values = normalizedValues(value.values ?? {});
  const content = renderInclude(applicationId, environmentRevision, values);
  return Object.freeze({
    applicationId,
    environmentRevision,
    values,
    content,
    checksum: sha256(content),
    bytes: Buffer.byteLength(content),
    variableCount: Object.keys(values).length,
  });
}

function fileState(content) {
  if (content === null) return Object.freeze({ exists: false, content: null, checksum: null });
  return Object.freeze({ exists: true, content, checksum: sha256(content) });
}

function modeOf(stat) {
  return Number(stat?.mode ?? 0) & 0o777;
}

function normalizePrevious(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.exists !== 'boolean') {
    throw new WebsitePassengerEnvironmentError('website_passenger_environment_receipt_invalid', 'Passenger environment receipt is invalid');
  }
  if (!value.exists) {
    if (value.content !== null || value.checksum !== null) {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_receipt_invalid', 'Passenger environment receipt is invalid');
    }
    return fileState(null);
  }
  if (typeof value.content !== 'string' || typeof value.checksum !== 'string'
    || !CHECKSUM_PATTERN.test(value.checksum) || sha256(value.content) !== value.checksum) {
    throw new WebsitePassengerEnvironmentError('website_passenger_environment_receipt_invalid', 'Passenger environment receipt is invalid');
  }
  return fileState(value.content);
}

export function createWebsitePassengerEnvironmentManager({
  includeRoot = INCLUDE_ROOT,
  receiptRoot = RECEIPT_ROOT,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (![includeRoot, receiptRoot].every((value) => typeof value === 'string' && path.posix.isAbsolute(value))
    || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function' || typeof readFileFn !== 'function'
    || typeof renameFn !== 'function' || typeof rmFn !== 'function' || typeof writeFileFn !== 'function') {
    throw new WebsitePassengerEnvironmentError('website_passenger_environment_dependencies_invalid', 'Passenger environment dependencies are invalid');
  }

  function includePath(applicationId) {
    return path.posix.join(includeRoot, `${applicationId}.conf`);
  }

  function receiptPath(operationId) {
    return path.posix.join(receiptRoot, `${operationId}.json`);
  }

  async function atomicWrite(targetPath, content, mode) {
    const temporary = `${targetPath}.${process.pid}.tmp`;
    await rmFn(temporary, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporary, content, { encoding: 'utf8', mode });
      await renameFn(temporary, targetPath);
    } finally {
      await rmFn(temporary, { force: true }).catch(() => {});
    }
  }

  async function capture(targetPath) {
    let stat;
    try { stat = await lstatFn(targetPath); }
    catch (error) {
      if (error?.code === 'ENOENT') return fileState(null);
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_inspection_failed', 'Passenger environment include could not be inspected');
    }
    if (!stat?.isFile?.() || stat.isSymbolicLink?.() || stat.uid !== 0 || stat.gid !== 0 || modeOf(stat) !== INCLUDE_MODE) {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_include_drift', 'Passenger environment include ownership or type has drifted');
    }
    try { return fileState(await readFileFn(targetPath, 'utf8')); }
    catch { throw new WebsitePassengerEnvironmentError('website_passenger_environment_inspection_failed', 'Passenger environment include could not be read'); }
  }

  function normalizeReceipt(value, { operationId, applicationId } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== RECEIPT_VERSION
      || value.operationId !== operationId || value.applicationId !== applicationId
      || !['active', 'compensated'].includes(value.state)
      || !Number.isSafeInteger(value.environmentRevision) || value.environmentRevision < 0
      || typeof value.includePath !== 'string' || value.includePath !== includePath(applicationId)
      || typeof value.includeChecksum !== 'string' || !CHECKSUM_PATTERN.test(value.includeChecksum)) {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_receipt_invalid', 'Passenger environment receipt is invalid');
    }
    return Object.freeze({
      version: RECEIPT_VERSION,
      operationId,
      applicationId,
      state: value.state,
      environmentRevision: value.environmentRevision,
      includePath: value.includePath,
      includeChecksum: value.includeChecksum,
      previous: normalizePrevious(value.previous),
    });
  }

  async function loadReceipt(operationId, applicationId) {
    let raw;
    try { raw = await readFileFn(receiptPath(operationId), 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_receipt_unavailable', 'Passenger environment receipt could not be read');
    }
    try { return normalizeReceipt(JSON.parse(raw), { operationId, applicationId }); }
    catch (error) {
      if (error instanceof WebsitePassengerEnvironmentError) throw error;
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_receipt_invalid', 'Passenger environment receipt is invalid');
    }
  }

  async function persistReceipt(receipt) {
    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    await atomicWrite(receiptPath(receipt.operationId), `${JSON.stringify(receipt)}\n`, 0o600);
    return normalizeReceipt(receipt, receipt);
  }

  function publicEvidence(spec, { ownedByOperation, receiptVersion = null, changed = false } = {}) {
    return Object.freeze({
      satisfied: true,
      adapter: 'passenger-environment',
      applicationId: spec.applicationId,
      environmentRevision: spec.environmentRevision,
      environmentInclude: includePath(spec.applicationId),
      includeSha256: spec.checksum,
      includeBytes: spec.bytes,
      variableCount: spec.variableCount,
      ownedByOperation: ownedByOperation === true,
      receiptVersion,
      changed: changed === true,
    });
  }

  async function operation(applicationId, operationId) {
    const normalizedApplicationId = uuid(applicationId, 'applicationId', 'website_passenger_environment_application_invalid');
    const normalizedOperationId = uuid(operationId, 'operationId', 'website_passenger_environment_operation_invalid');
    const receipt = await loadReceipt(normalizedOperationId, normalizedApplicationId);
    if (!receipt) return null;
    return Object.freeze({
      applicationId: receipt.applicationId,
      operationId: receipt.operationId,
      state: receipt.state,
      environmentRevision: receipt.environmentRevision,
      environmentInclude: receipt.includePath,
      includeSha256: receipt.includeChecksum,
      receiptVersion: receipt.version,
    });
  }

  async function inspect(rawSpec, { operationId = null } = {}) {
    const spec = normalizeSpec(rawSpec);
    const current = await capture(includePath(spec.applicationId));
    let receipt = null;
    if (operationId !== null) {
      const normalizedOperationId = uuid(operationId, 'operationId', 'website_passenger_environment_operation_invalid');
      receipt = await loadReceipt(normalizedOperationId, spec.applicationId);
      if (receipt && (receipt.environmentRevision !== spec.environmentRevision || receipt.includeChecksum !== spec.checksum)) {
        throw new WebsitePassengerEnvironmentError('website_passenger_environment_receipt_conflict', 'Passenger environment receipt conflicts with requested environment');
      }
    }
    if (!current.exists || current.checksum !== spec.checksum || current.content !== spec.content) {
      return Object.freeze({
        satisfied: false,
        reason: current.exists ? 'website_passenger_environment_include_drift' : 'website_passenger_environment_include_missing',
        applicationId: spec.applicationId,
        environmentRevision: spec.environmentRevision,
        environmentInclude: includePath(spec.applicationId),
      });
    }
    if (receipt?.state === 'compensated') {
      return Object.freeze({
        satisfied: false,
        reason: 'website_passenger_environment_compensated',
        applicationId: spec.applicationId,
        environmentRevision: spec.environmentRevision,
        environmentInclude: includePath(spec.applicationId),
      });
    }
    return publicEvidence(spec, {
      ownedByOperation: Boolean(receipt),
      receiptVersion: receipt?.version ?? null,
      changed: false,
    });
  }

  async function apply(rawSpec, { operationId } = {}) {
    const spec = normalizeSpec(rawSpec);
    const normalizedOperationId = uuid(operationId, 'operationId', 'website_passenger_environment_operation_invalid');
    await mkdirFn(includeRoot, { recursive: true, mode: 0o700 });
    const before = await capture(includePath(spec.applicationId));
    let receipt = await loadReceipt(normalizedOperationId, spec.applicationId);
    if (receipt?.state === 'compensated') {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_operation_compensated', 'Compensated Passenger environment operation cannot be re-applied');
    }
    if (receipt && (receipt.environmentRevision !== spec.environmentRevision || receipt.includeChecksum !== spec.checksum)) {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_receipt_conflict', 'Passenger environment receipt conflicts with current environment revision');
    }
    if (before.exists && before.checksum === spec.checksum && before.content === spec.content) {
      return publicEvidence(spec, {
        ownedByOperation: Boolean(receipt),
        receiptVersion: receipt?.version ?? null,
        changed: false,
      });
    }
    if (!receipt) {
      receipt = await persistReceipt({
        version: RECEIPT_VERSION,
        operationId: normalizedOperationId,
        applicationId: spec.applicationId,
        state: 'active',
        environmentRevision: spec.environmentRevision,
        includePath: includePath(spec.applicationId),
        includeChecksum: spec.checksum,
        previous: before,
      });
    }
    await atomicWrite(includePath(spec.applicationId), spec.content, INCLUDE_MODE);
    const verified = await inspect(spec, { operationId: normalizedOperationId });
    if (!verified.satisfied) {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_unverified', 'Passenger environment include could not be verified after write');
    }
    return Object.freeze({ ...verified, changed: true });
  }

  async function inspectCompensation(rawSpec, { operationId, ownedByOperation } = {}) {
    const spec = normalizeSpec(rawSpec);
    const normalizedOperationId = uuid(operationId, 'operationId', 'website_passenger_environment_operation_invalid');
    if (ownedByOperation !== true) {
      return Object.freeze({
        satisfied: true,
        adapter: 'passenger-environment',
        applicationId: spec.applicationId,
        environmentRevision: spec.environmentRevision,
        environmentInclude: includePath(spec.applicationId),
        ownedByOperation: false,
        restored: false,
      });
    }
    const receipt = await loadReceipt(normalizedOperationId, spec.applicationId);
    if (!receipt || receipt.environmentRevision !== spec.environmentRevision || receipt.includeChecksum !== spec.checksum) {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_receipt_unavailable', 'Passenger environment rollback receipt is unavailable or drifted');
    }
    const current = await capture(includePath(spec.applicationId));
    if (receipt.state === 'compensated') {
      if (receipt.previous.exists) {
        if (!current.exists || current.checksum !== receipt.previous.checksum || current.content !== receipt.previous.content) {
          throw new WebsitePassengerEnvironmentError('website_passenger_environment_compensation_drift', 'Passenger environment changed after compensation');
        }
      } else if (current.exists) {
        throw new WebsitePassengerEnvironmentError('website_passenger_environment_compensation_drift', 'Passenger environment include reappeared after compensation');
      }
      return Object.freeze({
        satisfied: true,
        adapter: 'passenger-environment',
        applicationId: spec.applicationId,
        environmentRevision: spec.environmentRevision,
        environmentInclude: includePath(spec.applicationId),
        ownedByOperation: true,
        restored: true,
      });
    }
    if (!current.exists || current.checksum !== spec.checksum || current.content !== spec.content) {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_compensation_drift', 'Passenger environment changed after provisioning');
    }
    return Object.freeze({
      satisfied: false,
      reason: 'website_passenger_environment_compensation_pending',
      applicationId: spec.applicationId,
      environmentRevision: spec.environmentRevision,
    });
  }

  async function compensate(rawSpec, { operationId, ownedByOperation } = {}) {
    const spec = normalizeSpec(rawSpec);
    const normalizedOperationId = uuid(operationId, 'operationId', 'website_passenger_environment_operation_invalid');
    const inspected = await inspectCompensation(spec, { operationId: normalizedOperationId, ownedByOperation });
    if (inspected.satisfied) return inspected;
    const receipt = await loadReceipt(normalizedOperationId, spec.applicationId);
    if (receipt.previous.exists) {
      await atomicWrite(includePath(spec.applicationId), receipt.previous.content, INCLUDE_MODE);
    } else {
      await rmFn(includePath(spec.applicationId), { force: true });
    }
    await persistReceipt({
      version: receipt.version,
      operationId: receipt.operationId,
      applicationId: receipt.applicationId,
      state: 'compensated',
      environmentRevision: receipt.environmentRevision,
      includePath: receipt.includePath,
      includeChecksum: receipt.includeChecksum,
      previous: receipt.previous,
    });
    return inspectCompensation(spec, { operationId: normalizedOperationId, ownedByOperation: true });
  }

  return Object.freeze({ operation, inspect, apply, inspectCompensation, compensate });
}

export const websitePassengerEnvironmentInternals = Object.freeze({
  normalizeSpec,
  normalizedValues,
  quoteNginxValue,
  renderInclude,
  includeRoot: INCLUDE_ROOT,
  receiptRoot: RECEIPT_ROOT,
  managedEnvironmentKeys: Object.freeze([...MANAGED_ENVIRONMENT_KEYS]),
});
