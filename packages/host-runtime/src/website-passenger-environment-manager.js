import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
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
const MAX_INCLUDE_BYTES = 1024 * 1024;
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
    if (MANAGED_ENVIRONMENT_KEYS.has(rawKey)) {
      throw new WebsitePassengerEnvironmentError(
        'website_passenger_environment_reserved_key',
        'Passenger environment cannot override Passenger-managed application environment keys',
      );
    }
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

function decodeManagedInclude(content, applicationId) {
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > MAX_INCLUDE_BYTES) {
    throw new WebsitePassengerEnvironmentError('website_passenger_environment_include_drift', 'Passenger environment include is not canonical');
  }
  const lines = content.split('\n');
  const marker = lines.shift().match(/^# YunPanel Passenger environment ([a-f0-9-]{36}) revision (\d+)$/);
  if (!marker || marker[1] !== applicationId || lines.pop() !== '') {
    throw new WebsitePassengerEnvironmentError('website_passenger_environment_include_drift', 'Passenger environment include ownership marker is invalid');
  }
  const values = {};
  for (const line of lines) {
    const match = line.match(/^passenger_env_var ([A-Z_][A-Z0-9_]{0,127}) "((?:[^"\\]|\\["\\$])*)";$/);
    if (!match || Object.hasOwn(values, match[1])) {
      throw new WebsitePassengerEnvironmentError('website_passenger_environment_include_drift', 'Passenger environment include is not canonical');
    }
    values[match[1]] = match[2].replace(/\\(["\\$])/g, '$1');
  }
  const spec = normalizeSpec({ applicationId, environmentRevision: Number(marker[2]), values });
  if (spec.content !== content) throw new WebsitePassengerEnvironmentError('website_passenger_environment_include_drift', 'Passenger environment include is not canonical');
  return Object.freeze({ environmentRevision: spec.environmentRevision, values: spec.values });
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
  ownerUid = 0,
  ownerGid = 0,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (![includeRoot, receiptRoot].every((value) => typeof value === 'string' && path.posix.isAbsolute(value))
    || !Number.isSafeInteger(ownerUid) || ownerUid < 0 || !Number.isSafeInteger(ownerGid) || ownerGid < 0
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
    if (!stat?.isFile?.() || stat.isSymbolicLink?.() || stat.uid !== ownerUid || stat.gid !== ownerGid || modeOf(stat) !== INCLUDE_MODE) {
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

  const retirementError = (code = 'website_passenger_environment_retirement_drift') => new WebsitePassengerEnvironmentError(code, 'Passenger environment retirement could not be verified');
  const identity = info => Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(info[key])]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function trustedAncestors(target) {
    for (let directory = path.dirname(target); ; directory = path.dirname(directory)) {
      let info;
      try { info = await lstat(directory); }
      catch (error) { if (error?.code === 'ENOENT') { if (directory === '/') throw retirementError(); continue; } throw retirementError(); }
      const privateTempAncestor = ownerUid !== 0 && info.uid === 0 && (info.mode & 0o7777) === 0o1777;
      if (!info.isDirectory() || info.isSymbolicLink() || ![0, ownerUid].includes(info.uid)
        || !privateTempAncestor && (info.mode & 0o022) || await realpath(directory) !== directory) throw retirementError();
      if (directory === '/') break;
    }
  }

  async function boundedFile(target, root, limit) {
    await trustedAncestors(target);
    let handle; let parent;
    try {
      const directory = await lstat(root);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== ownerUid || directory.gid !== ownerGid
        || (directory.mode & 0o022) || await realpath(root) !== root) throw retirementError();
      parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const parentIdentity = info => ['dev', 'ino', 'mode', 'uid', 'gid'].map(key => String(info[key]));
      const initialParent = await parent.stat({ bigint: true });
      if (!same(parentIdentity(initialParent), parentIdentity(await lstat(root, { bigint: true })))) throw retirementError();
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const first = await handle.stat({ bigint: true });
      if (!first.isFile() || first.uid !== BigInt(ownerUid) || first.gid !== BigInt(ownerGid) || first.nlink !== 1n
        || Number(first.mode & 0o7777n) !== INCLUDE_MODE || first.size > BigInt(limit)) throw retirementError();
      const chunks = []; let length = 0;
      while (length <= limit) {
        const bytes = Buffer.alloc(Math.min(65536, limit + 1 - length));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
        if (!bytesRead) break;
        length += bytesRead; chunks.push(bytes.subarray(0, bytesRead));
      }
      if (length > limit || !same(identity(first), identity(await handle.stat({ bigint: true })))
        || !same(identity(first), identity(await lstat(target, { bigint: true })))
        || !same(parentIdentity(initialParent), parentIdentity(await parent.stat({ bigint: true })))
        || !same(parentIdentity(initialParent), parentIdentity(await lstat(root, { bigint: true })))) throw retirementError();
      const raw = Buffer.concat(chunks), content = raw.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(raw)) throw retirementError();
      return { exists: true, content, checksum: sha256(raw), identity: identity(first) };
    } catch (error) {
      if (error?.code === 'ENOENT' && !handle) return { exists: false, content: null, checksum: null, identity: null };
      if (error instanceof WebsitePassengerEnvironmentError) throw error;
      throw retirementError('website_passenger_environment_retirement_unavailable');
    } finally { await handle?.close(); await parent?.close(); }
  }

  async function inspectAbsence(applicationId) {
    const id = uuid(applicationId, 'applicationId', 'website_passenger_environment_application_invalid');
    const current = await boundedFile(includePath(id), includeRoot, MAX_INCLUDE_BYTES);
    return Object.freeze({ applicationId: id, includeAbsent: !current.exists, environmentInclude: includePath(id) });
  }

  function retirementAuthority(value) {
    if (!value || typeof value !== 'object' || !/^ws-rem-[a-f0-9-]{36}$/.test(value.removalId ?? '')) throw retirementError();
    const fields = ['websiteId', 'applicationId', 'serverId', 'sourceOperationId', 'removalId', 'releaseId', 'savedRevision', 'appliedRevision', 'appliedReleaseId', 'originalIncludeSha256', 'initialReleaseId'];
    if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw retirementError();
    for (const key of ['websiteId', 'applicationId', 'serverId', 'sourceOperationId']) uuid(value[key], key, 'website_passenger_environment_retirement_drift');
    uuid(value.removalId.slice(7), 'removalId', 'website_passenger_environment_retirement_drift');
    if (value.releaseId !== null) uuid(value.releaseId, 'releaseId', 'website_passenger_environment_retirement_drift');
    if (value.appliedReleaseId !== null) uuid(value.appliedReleaseId, 'appliedReleaseId', 'website_passenger_environment_retirement_drift');
    if (value.initialReleaseId !== null && value.initialReleaseId !== value.sourceOperationId) throw retirementError();
    revision(value.savedRevision);
    if (value.appliedRevision !== null && (revision(value.appliedRevision) > value.savedRevision)) throw retirementError();
    if (!CHECKSUM_PATTERN.test(value.originalIncludeSha256 ?? '')) throw retirementError();
    return Object.freeze({ ...value });
  }

  async function retirementState(rawAuthority, priorReceipt = null) {
    const authority = retirementAuthority(rawAuthority);
    const raw = await boundedFile(receiptPath(authority.sourceOperationId), receiptRoot, MAX_INCLUDE_BYTES * 2);
    if (!raw.exists) throw retirementError('website_passenger_environment_retirement_ownership_missing');
    let original;
    try { original = normalizeReceipt(JSON.parse(raw.content), { operationId: authority.sourceOperationId, applicationId: authority.applicationId }); }
    catch { throw retirementError('website_passenger_environment_retirement_ownership_missing'); }
    if (original.previous.exists || original.includeChecksum !== authority.originalIncludeSha256) throw retirementError('website_passenger_environment_retirement_ownership_missing');
    const current = await boundedFile(includePath(authority.applicationId), includeRoot, MAX_INCLUDE_BYTES);
    const binding = { version: 1, kind: 'passenger-environment-retirement', removalId: authority.removalId,
      websiteId: authority.websiteId, applicationId: authority.applicationId, serverId: authority.serverId,
      sourceOperationId: authority.sourceOperationId, provisioningReceiptSha256: raw.checksum,
      environmentInclude: includePath(authority.applicationId) };
    if (priorReceipt) {
      const fields = [...Object.keys(binding), 'state', 'hadInclude', 'environmentRevision', 'includeSha256', 'fileIdentity', 'authoritySnapshot'];
      const finalFields = ['satisfied', 'includeAbsent', 'retired'];
      const allowed = priorReceipt.state === 'retired' ? [...fields, ...finalFields] : fields;
      const snapshotFields = ['releaseId', 'savedRevision', 'appliedRevision', 'appliedReleaseId', 'originalIncludeSha256', 'initialReleaseId'];
      if (Object.keys(priorReceipt).length !== allowed.length || Object.keys(priorReceipt).some(key => !allowed.includes(key))
        || !priorReceipt.authoritySnapshot || Object.keys(priorReceipt.authoritySnapshot).length !== snapshotFields.length
        || Object.keys(priorReceipt.authoritySnapshot).some(key => !snapshotFields.includes(key))) throw retirementError();
      retirementAuthority({ ...authority, ...priorReceipt.authoritySnapshot });
      if (priorReceipt.authoritySnapshot.originalIncludeSha256 !== authority.originalIncludeSha256
        || priorReceipt.state === 'retired' && finalFields.some(key => priorReceipt[key] !== true)) throw retirementError();
      if (!['prepared', 'retired'].includes(priorReceipt.state)
        || Object.entries(binding).some(([key, value]) => priorReceipt[key] !== value)
        || typeof priorReceipt.hadInclude !== 'boolean'
        || priorReceipt.hadInclude && (!CHECKSUM_PATTERN.test(priorReceipt.includeSha256 ?? '') || !priorReceipt.fileIdentity)
        || !priorReceipt.hadInclude && (priorReceipt.includeSha256 !== null || priorReceipt.fileIdentity !== null)) throw retirementError();
      if (priorReceipt.hadInclude) {
        const identityFields = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
        if (!Number.isSafeInteger(priorReceipt.environmentRevision) || priorReceipt.environmentRevision < 0
          || Object.keys(priorReceipt.fileIdentity).length !== identityFields.length
          || identityFields.some(key => typeof priorReceipt.fileIdentity[key] !== 'string' || !/^\d+$/.test(priorReceipt.fileIdentity[key]))
          || priorReceipt.fileIdentity.uid !== String(ownerUid) || priorReceipt.fileIdentity.gid !== String(ownerGid)
          || priorReceipt.fileIdentity.mode !== String(0o100600) || priorReceipt.fileIdentity.nlink !== '1'
          || BigInt(priorReceipt.fileIdentity.size) > BigInt(MAX_INCLUDE_BYTES)) throw retirementError();
        const saved = priorReceipt.authoritySnapshot;
        const applied = saved.appliedRevision === priorReceipt.environmentRevision && saved.appliedReleaseId === saved.releaseId && saved.releaseId !== null;
        const initial = saved.appliedRevision === null && saved.appliedReleaseId === null && saved.initialReleaseId === authority.sourceOperationId
          && saved.releaseId === saved.initialReleaseId && priorReceipt.environmentRevision === original.environmentRevision && priorReceipt.includeSha256 === original.includeChecksum;
        if (!applied && !initial) throw retirementError();
      } else if (priorReceipt.environmentRevision !== null) throw retirementError();
      if (priorReceipt.state === 'prepared') {
        // A draft-only saved revision change does not change current applied authority.
        const currentFields = ['releaseId', 'appliedRevision', 'appliedReleaseId', 'initialReleaseId'];
        if (currentFields.some(key => authority[key] !== priorReceipt.authoritySnapshot[key])) throw retirementError();
      }
      if (current.exists && (priorReceipt.state === 'retired' || !priorReceipt.hadInclude
        || current.checksum !== priorReceipt.includeSha256 || !same(current.identity, priorReceipt.fileIdentity))) throw retirementError();
      return { authority, current, proof: priorReceipt };
    }
    let environmentRevision = null;
    if (current.exists) {
      if (original.state !== 'active') throw retirementError();
      environmentRevision = decodeManagedInclude(current.content, authority.applicationId).environmentRevision;
      const applied = authority.appliedRevision === environmentRevision && authority.appliedReleaseId === authority.releaseId && authority.releaseId !== null;
      const initial = authority.appliedRevision === null && authority.appliedReleaseId === null
        && authority.initialReleaseId === authority.sourceOperationId && authority.releaseId === authority.initialReleaseId
        && environmentRevision === original.environmentRevision && current.checksum === original.includeChecksum;
      if (!applied && !initial) throw retirementError();
    }
    return { authority, current, proof: Object.freeze({ ...binding, state: 'prepared', hadInclude: current.exists,
      environmentRevision, includeSha256: current.checksum, fileIdentity: current.identity,
      authoritySnapshot: Object.freeze(Object.fromEntries(['releaseId', 'savedRevision', 'appliedRevision', 'appliedReleaseId', 'originalIncludeSha256', 'initialReleaseId'].map(key => [key, authority[key]]))) }) };
  }

  async function inspectRetirement(authority, { priorReceipt = null } = {}) {
    const state = await retirementState(authority, priorReceipt);
    return Object.freeze({ ...state.proof, satisfied: !state.current.exists,
      includeAbsent: !state.current.exists, retired: state.proof.state === 'retired' && !state.current.exists });
  }

  async function retire(authority, { priorReceipt = null, checkpoint } = {}) {
    if (typeof checkpoint !== 'function') throw retirementError('website_passenger_environment_checkpoint_unavailable');
    let state = await retirementState(authority, priorReceipt);
    if (state.proof.state === 'retired') return Object.freeze({ ...state.proof, satisfied: true, includeAbsent: true, retired: true });
    if (!priorReceipt) await checkpoint(state.proof);
    state = await retirementState(authority, state.proof);
    if (state.current.exists) {
      // The caller holds App, Website and the existing Domain namespace. This check
      // does not claim a cross-process atomic compare-and-unlink primitive.
      await unlink(includePath(state.authority.applicationId));
      const directory = await open(includeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    const verified = await retirementState(authority, state.proof);
    if (verified.current.exists) throw retirementError();
    const result = Object.freeze({ ...state.proof, state: 'retired', satisfied: true, includeAbsent: true, retired: true });
    await checkpoint(result);
    return result;
  }

  return Object.freeze({ operation, inspect, apply, inspectCompensation, compensate, inspectAbsence, inspectRetirement, retire });
}

export const websitePassengerEnvironmentInternals = Object.freeze({
  normalizeSpec,
  normalizedValues,
  quoteNginxValue,
  renderInclude,
  decodeManagedInclude,
  includeRoot: INCLUDE_ROOT,
  receiptRoot: RECEIPT_ROOT,
  managedEnvironmentKeys: Object.freeze([...MANAGED_ENVIRONMENT_KEYS]),
});
