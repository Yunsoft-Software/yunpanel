import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid, normalizeNodeRuntimeConfig } from '@yunpanel/shared';

const SOURCE_ROOT = '/etc/yunpanel/apps';
const INCLUDE_ROOT = '/etc/yunpanel/passenger-env';
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/passenger-env';
const RECEIPT_VERSION = 1;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_ENVIRONMENT_VARIABLES = 104;
const INCLUDE_MODE = 0o600;

export class PassengerEnvironmentManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PassengerEnvironmentManagerError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeApplicationId(value) {
  try { return assertUuid(value, 'applicationId'); }
  catch { throw new PassengerEnvironmentManagerError('passenger_environment_application_invalid', 'Passenger environment Application identity is invalid'); }
}

function normalizeOperationId(value) {
  try { return assertUuid(value, 'operationId'); }
  catch { throw new PassengerEnvironmentManagerError('passenger_environment_operation_invalid', 'Passenger environment operation identity is invalid'); }
}

function normalizeExpectedChecksum(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) {
    throw new PassengerEnvironmentManagerError('passenger_environment_checksum_invalid', 'Passenger environment source checksum is invalid');
  }
  return value;
}

function parseManagedEnvironment(content) {
  if (typeof content !== 'string' || content.includes('\u0000')) {
    throw new PassengerEnvironmentManagerError('passenger_environment_source_invalid', 'Managed Node environment file is invalid');
  }
  const values = {};
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '' && index === lines.length - 1) continue;
    if (line === '') throw new PassengerEnvironmentManagerError('passenger_environment_source_invalid', 'Managed Node environment file contains an empty line');
    const match = line.match(/^([A-Z_][A-Z0-9_]{0,127})="((?:[^"\\]|\\["\\])*)"$/);
    if (!match || !ENV_KEY_PATTERN.test(match[1]) || Object.hasOwn(values, match[1])) {
      throw new PassengerEnvironmentManagerError('passenger_environment_source_invalid', 'Managed Node environment file contains an invalid or duplicate entry');
    }
    values[match[1]] = match[2].replace(/\\(["\\])/g, '$1');
    if (Object.keys(values).length > MAX_ENVIRONMENT_VARIABLES) {
      throw new PassengerEnvironmentManagerError('passenger_environment_source_invalid', 'Managed Node environment file contains too many entries');
    }
  }
  return Object.freeze(values);
}

function validateManagedEnvironment(values, { applicationId, runtime }) {
  const expected = {
    NODE_ENV: runtime.mode,
    HOST: '127.0.0.1',
    PORT: String(runtime.port),
    YUNPANEL_APPLICATION_ID: applicationId,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (values[key] !== value) {
      throw new PassengerEnvironmentManagerError('passenger_environment_source_drift', `Managed Node environment ${key} does not match runtime state`);
    }
  }
  return values;
}

function quoteNginxValue(value) {
  if (typeof value !== 'string' || value.includes('\u0000') || value.includes('\n') || value.includes('\r')) {
    throw new PassengerEnvironmentManagerError('passenger_environment_value_invalid', 'Passenger environment value is invalid');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;
}

function renderPassengerEnvironmentInclude(values) {
  return `${Object.keys(values)
    .filter((key) => key !== 'NODE_ENV')
    .sort()
    .map((key) => `passenger_env_var ${key} ${quoteNginxValue(values[key])};`)
    .join('\n')}\n`;
}

function modeOf(stat) {
  return Number(stat?.mode ?? 0) & 0o777;
}

function publicEvidence(evidence) {
  return Object.freeze({
    applicationId: evidence.applicationId,
    sourcePath: evidence.sourcePath,
    sourceSha256: evidence.sourceSha256,
    environmentInclude: evidence.environmentInclude,
    includeSha256: evidence.includeSha256,
    includeBytes: evidence.includeBytes,
    variableCount: evidence.variableCount,
  });
}

function normalizePrevious(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.exists !== 'boolean') {
    throw new PassengerEnvironmentManagerError('passenger_environment_receipt_invalid', 'Passenger environment rollback receipt is invalid');
  }
  if (!value.exists) {
    if (value.content !== null || value.checksum !== null) throw new PassengerEnvironmentManagerError('passenger_environment_receipt_invalid', 'Passenger environment rollback receipt is invalid');
    return Object.freeze({ exists: false, content: null, checksum: null });
  }
  if (typeof value.content !== 'string' || typeof value.checksum !== 'string'
    || !CHECKSUM_PATTERN.test(value.checksum) || sha256(value.content) !== value.checksum) {
    throw new PassengerEnvironmentManagerError('passenger_environment_receipt_invalid', 'Passenger environment rollback receipt is invalid');
  }
  return Object.freeze({ exists: true, content: value.content, checksum: value.checksum });
}

export function createPassengerEnvironmentManager({
  sourceRoot = SOURCE_ROOT,
  includeRoot = INCLUDE_ROOT,
  receiptRoot = RECEIPT_ROOT,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (![sourceRoot, includeRoot, receiptRoot].every((value) => typeof value === 'string' && path.posix.isAbsolute(value))
    || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function' || typeof readFileFn !== 'function'
    || typeof renameFn !== 'function' || typeof rmFn !== 'function' || typeof writeFileFn !== 'function') {
    throw new PassengerEnvironmentManagerError('passenger_environment_dependencies_invalid', 'Passenger environment manager dependencies are invalid');
  }

  function paths(applicationId) {
    return Object.freeze({
      sourcePath: path.posix.join(sourceRoot, `${applicationId}.env`),
      environmentInclude: path.posix.join(includeRoot, `${applicationId}.conf`),
    });
  }

  function receiptPath(operationId) {
    return path.posix.join(receiptRoot, `${operationId}.json`);
  }

  async function atomicWrite(targetPath, content, mode) {
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await rmFn(temporaryPath, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
      await renameFn(temporaryPath, targetPath);
    } finally {
      await rmFn(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async function sourceEvidence({ applicationId, runtime, expectedSourceSha256 = null }) {
    const normalizedRuntime = normalizeNodeRuntimeConfig(runtime);
    const expectedChecksum = normalizeExpectedChecksum(expectedSourceSha256);
    const managedPaths = paths(applicationId);
    let content;
    try { content = await readFileFn(managedPaths.sourcePath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new PassengerEnvironmentManagerError('passenger_environment_source_unavailable', 'Managed Node environment file could not be read');
    }
    const sourceSha256 = sha256(content);
    if (expectedChecksum && sourceSha256 !== expectedChecksum) {
      throw new PassengerEnvironmentManagerError('passenger_environment_source_changed', 'Managed Node environment changed after migration preview');
    }
    const values = validateManagedEnvironment(parseManagedEnvironment(content), { applicationId, runtime: normalizedRuntime });
    const includeContent = renderPassengerEnvironmentInclude(values);
    return Object.freeze({
      applicationId,
      ...managedPaths,
      sourceSha256,
      includeContent,
      includeSha256: sha256(includeContent),
      includeBytes: Buffer.byteLength(includeContent),
      variableCount: Object.keys(values).filter((key) => key !== 'NODE_ENV').length,
    });
  }

  async function captureInclude(targetPath) {
    let stat;
    try { stat = await lstatFn(targetPath); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ exists: false, content: null, checksum: null, safe: true });
      throw new PassengerEnvironmentManagerError('passenger_environment_include_unavailable', 'Passenger environment include could not be inspected');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || modeOf(stat) !== INCLUDE_MODE) {
      throw new PassengerEnvironmentManagerError('passenger_environment_include_drift', 'Passenger environment include ownership or file type has drifted');
    }
    let content;
    try { content = await readFileFn(targetPath, 'utf8'); }
    catch { throw new PassengerEnvironmentManagerError('passenger_environment_include_unavailable', 'Passenger environment include could not be read'); }
    return Object.freeze({ exists: true, content, checksum: sha256(content), safe: true });
  }

  async function inspect(rawSpec) {
    const applicationId = normalizeApplicationId(rawSpec?.applicationId);
    const evidence = await sourceEvidence({
      applicationId,
      runtime: rawSpec?.runtime,
      expectedSourceSha256: rawSpec?.expectedSourceSha256 ?? null,
    });
    if (!evidence) {
      const managedPaths = paths(applicationId);
      return Object.freeze({
        satisfied: false,
        reason: 'passenger_environment_source_missing',
        applicationId,
        sourcePath: managedPaths.sourcePath,
        environmentInclude: managedPaths.environmentInclude,
      });
    }
    const current = await captureInclude(evidence.environmentInclude);
    if (!current.exists) {
      return Object.freeze({
        satisfied: false,
        reason: 'passenger_environment_include_missing',
        ...publicEvidence(evidence),
      });
    }
    if (current.checksum !== evidence.includeSha256 || current.content !== evidence.includeContent) {
      return Object.freeze({
        satisfied: false,
        reason: 'passenger_environment_include_drift',
        ...publicEvidence(evidence),
      });
    }
    return Object.freeze({ satisfied: true, ...publicEvidence(evidence) });
  }

  function normalizeReceipt(value, { operationId, applicationId }) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== RECEIPT_VERSION || value.operationId !== operationId
      || value.applicationId !== applicationId || value.environmentInclude !== paths(applicationId).environmentInclude
      || typeof value.sourceSha256 !== 'string' || !CHECKSUM_PATTERN.test(value.sourceSha256)
      || typeof value.includeSha256 !== 'string' || !CHECKSUM_PATTERN.test(value.includeSha256)) {
      throw new PassengerEnvironmentManagerError('passenger_environment_receipt_invalid', 'Passenger environment rollback receipt is invalid');
    }
    return Object.freeze({
      version: RECEIPT_VERSION,
      operationId,
      applicationId,
      environmentInclude: value.environmentInclude,
      sourceSha256: value.sourceSha256,
      includeSha256: value.includeSha256,
      previous: normalizePrevious(value.previous),
    });
  }

  async function loadReceipt(operationId, applicationId) {
    let raw;
    try { raw = await readFileFn(receiptPath(operationId), 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new PassengerEnvironmentManagerError('passenger_environment_receipt_unavailable', 'Passenger environment rollback receipt could not be read');
    }
    try { return normalizeReceipt(JSON.parse(raw), { operationId, applicationId }); }
    catch (error) {
      if (error instanceof PassengerEnvironmentManagerError) throw error;
      throw new PassengerEnvironmentManagerError('passenger_environment_receipt_invalid', 'Passenger environment rollback receipt is invalid');
    }
  }

  async function persistReceipt(operationId, evidence, previous) {
    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    const receipt = {
      version: RECEIPT_VERSION,
      operationId,
      applicationId: evidence.applicationId,
      environmentInclude: evidence.environmentInclude,
      sourceSha256: evidence.sourceSha256,
      includeSha256: evidence.includeSha256,
      previous: {
        exists: previous.exists,
        content: previous.content,
        checksum: previous.checksum,
      },
    };
    await atomicWrite(receiptPath(operationId), `${JSON.stringify(receipt)}\n`, 0o600);
    return normalizeReceipt(receipt, { operationId, applicationId: evidence.applicationId });
  }

  async function apply(rawSpec, { operationId: rawOperationId } = {}) {
    const applicationId = normalizeApplicationId(rawSpec?.applicationId);
    const operationId = normalizeOperationId(rawOperationId);
    const evidence = await sourceEvidence({
      applicationId,
      runtime: rawSpec?.runtime,
      expectedSourceSha256: rawSpec?.expectedSourceSha256 ?? null,
    });
    if (!evidence) throw new PassengerEnvironmentManagerError('passenger_environment_source_missing', 'Managed Node environment file is missing');

    const before = await captureInclude(evidence.environmentInclude);
    let receipt = await loadReceipt(operationId, applicationId);
    if (receipt && (receipt.sourceSha256 !== evidence.sourceSha256 || receipt.includeSha256 !== evidence.includeSha256)) {
      throw new PassengerEnvironmentManagerError('passenger_environment_receipt_conflict', 'Passenger environment rollback receipt conflicts with current source state');
    }
    if (before.exists && before.checksum === evidence.includeSha256 && before.content === evidence.includeContent) {
      return Object.freeze({
        satisfied: true,
        changed: false,
        ownedByOperation: receipt !== null,
        ...(receipt ? { receiptVersion: receipt.version } : {}),
        ...publicEvidence(evidence),
      });
    }

    if (!receipt) receipt = await persistReceipt(operationId, evidence, before);

    const matchesPrevious = before.exists === receipt.previous.exists
      && before.checksum === receipt.previous.checksum
      && (!before.exists || before.content === receipt.previous.content);
    if (!matchesPrevious) {
      throw new PassengerEnvironmentManagerError('passenger_environment_apply_drift', 'Passenger environment apply refused because include state has drifted');
    }

    await mkdirFn(includeRoot, { recursive: true, mode: 0o700 });
    let writeCompleted = false;
    try {
      await atomicWrite(evidence.environmentInclude, evidence.includeContent, INCLUDE_MODE);
      writeCompleted = true;
      const verified = await inspect({ applicationId, runtime: rawSpec?.runtime, expectedSourceSha256: evidence.sourceSha256 });
      if (!verified.satisfied) throw new PassengerEnvironmentManagerError('passenger_environment_write_unverified', 'Passenger environment include could not be verified after write');
      return Object.freeze({ ...verified, changed: true, ownedByOperation: true, receiptVersion: receipt.version });
    } catch {
      try {
        if (receipt.previous.exists) await atomicWrite(evidence.environmentInclude, receipt.previous.content, INCLUDE_MODE);
        else await rmFn(evidence.environmentInclude, { force: true });
        const restored = await inspectCompensation({ applicationId }, { operationId });
        if (!restored.satisfied) throw new Error('rollback unverified');
      } catch {
        throw new PassengerEnvironmentManagerError('passenger_environment_rollback_failed', 'Passenger environment apply failed and previous include state could not be restored');
      }
      throw new PassengerEnvironmentManagerError(
        writeCompleted ? 'passenger_environment_write_unverified' : 'passenger_environment_write_failed',
        writeCompleted ? 'Passenger environment include could not be verified after write' : 'Passenger environment include could not be written',
      );
    }
  }

  async function inspectCompensation(rawSpec, { operationId: rawOperationId } = {}) {
    const applicationId = normalizeApplicationId(rawSpec?.applicationId);
    const operationId = normalizeOperationId(rawOperationId);
    const receipt = await loadReceipt(operationId, applicationId);
    if (!receipt) return Object.freeze({ satisfied: true, preservedUnownedState: true });
    const current = await captureInclude(receipt.environmentInclude);
    const matchesPrevious = current.exists === receipt.previous.exists
      && current.checksum === receipt.previous.checksum
      && (!current.exists || current.content === receipt.previous.content);
    if (matchesPrevious) return Object.freeze({ satisfied: true, restoredPrevious: receipt.previous.exists });
    if (current.exists && current.checksum === receipt.includeSha256) {
      return Object.freeze({ satisfied: false, reason: 'passenger_environment_compensation_pending' });
    }
    throw new PassengerEnvironmentManagerError('passenger_environment_compensation_drift', 'Passenger environment compensation refused because include state has drifted');
  }

  async function compensate(rawSpec, { operationId: rawOperationId } = {}) {
    const applicationId = normalizeApplicationId(rawSpec?.applicationId);
    const operationId = normalizeOperationId(rawOperationId);
    const receipt = await loadReceipt(operationId, applicationId);
    if (!receipt) throw new PassengerEnvironmentManagerError('passenger_environment_receipt_missing', 'Passenger environment rollback receipt is missing');
    const inspected = await inspectCompensation({ applicationId }, { operationId });
    if (inspected.satisfied) return inspected;

    try {
      if (receipt.previous.exists) await atomicWrite(receipt.environmentInclude, receipt.previous.content, INCLUDE_MODE);
      else await rmFn(receipt.environmentInclude, { force: true });
    } catch {
      throw new PassengerEnvironmentManagerError('passenger_environment_compensation_failed', 'Passenger environment include could not be restored');
    }
    const verified = await inspectCompensation({ applicationId }, { operationId });
    if (!verified.satisfied) throw new PassengerEnvironmentManagerError('passenger_environment_compensation_unverified', 'Passenger environment compensation could not be verified');
    return verified;
  }

  return Object.freeze({ inspect, apply, inspectCompensation, compensate });
}

export const passengerEnvironmentManager = createPassengerEnvironmentManager();
export const passengerEnvironmentManagerInternals = Object.freeze({
  sha256,
  parseManagedEnvironment,
  validateManagedEnvironment,
  quoteNginxValue,
  renderPassengerEnvironmentInclude,
  sourceRoot: SOURCE_ROOT,
  includeRoot: INCLUDE_ROOT,
  receiptRoot: RECEIPT_ROOT,
  receiptVersion: RECEIPT_VERSION,
  includeMode: INCLUDE_MODE,
});
