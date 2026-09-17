import { createHash } from 'node:crypto';
import { chmod, chown, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { powerDnsTemplatePolicy, renderManagedPowerDnsConfig } from '@yunpanel/config-templates/powerdns';
import {
  createPowerDnsAuthoritativeManager,
  powerDnsAuthoritativeManagerInternals,
  PowerDnsAuthoritativeManagerError,
} from './powerdns-authoritative-manager.js';
import { createPowerDnsSocketHealthInspector } from './powerdns-socket-health-inspector.js';

const ROLLBACK_SNAPSHOT_VERSION = 1;
const ROLLBACK_COMPENSATION_VERSION = 1;
const DEFAULT_ROLLBACK_SNAPSHOT_PATH = '/var/lib/yunpanel/staging/powerdns/authoritative-rollback.json';
const DEFAULT_ROLLBACK_COMPENSATION_PATH = '/var/lib/yunpanel/staging/powerdns/authoritative-rollback-compensation.json';
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SNAPSHOT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_invalid',
      'PowerDNS rollback snapshot timestamp is invalid',
    );
  }
  return value;
}

function encodedFileSnapshot(value) {
  const fields = new Set(['content', 'uid', 'gid', 'mode']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.content)
    || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.gid) || value.gid < 0
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_invalid',
      'PowerDNS rollback file snapshot is invalid',
    );
  }
  const content = Buffer.from(value.content, 'base64');
  if (content.length < 1 || content.length > MAX_SNAPSHOT_FILE_BYTES
    || content.toString('base64') !== value.content) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_invalid',
      'PowerDNS rollback file snapshot content is invalid',
    );
  }
  return Object.freeze({ content: value.content, uid: value.uid, gid: value.gid, mode: value.mode });
}

function snapshotDigestPayload(value) {
  return Object.freeze({
    version: value.version,
    operationId: value.operationId,
    serverId: value.serverId,
    credentialRevision: value.credentialRevision,
    previousSecondaryDns: value.previousSecondaryDns,
    config: value.config,
    receipt: value.receipt,
    createdAt: value.createdAt,
  });
}

function compensationDigestPayload(value) {
  return Object.freeze({
    version: value.version,
    operationId: value.operationId,
    serverId: value.serverId,
    credentialRevision: value.credentialRevision,
    rollbackSnapshotDigest: value.rollbackSnapshotDigest,
    config: value.config,
    receipt: value.receipt,
    createdAt: value.createdAt,
  });
}

function persistedRollbackSnapshot(value) {
  const fields = new Set([
    'version', 'operationId', 'serverId', 'credentialRevision', 'available', 'reason',
    'previousSecondaryDns', 'snapshotDigest', 'config', 'receipt', 'createdAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.version !== ROLLBACK_SNAPSHOT_VERSION
    || typeof value.operationId !== 'string' || !OPERATION_ID_PATTERN.test(value.operationId)
    || typeof value.serverId !== 'string' || !value.serverId
    || !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1
    || typeof value.available !== 'boolean') {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_invalid',
      'PowerDNS rollback snapshot is invalid',
    );
  }
  const createdAt = timestamp(value.createdAt);
  if (!value.available) {
    if (![
      'powerdns_rollback_previous_config_missing',
      'powerdns_rollback_previous_receipt_missing',
      'powerdns_rollback_previous_credential_unavailable',
    ].includes(value.reason)
      || value.previousSecondaryDns !== null || value.snapshotDigest !== null
      || value.config !== null || value.receipt !== null) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_snapshot_invalid',
        'Unavailable PowerDNS rollback snapshot state is invalid',
      );
    }
    return Object.freeze({ ...value, createdAt });
  }
  if (value.reason !== null || !Array.isArray(value.previousSecondaryDns)
    || value.previousSecondaryDns.some((entry) => typeof entry !== 'string' || !entry)
    || typeof value.snapshotDigest !== 'string' || !SNAPSHOT_DIGEST_PATTERN.test(value.snapshotDigest)) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_invalid',
      'Available PowerDNS rollback snapshot state is invalid',
    );
  }
  const snapshot = Object.freeze({
    ...value,
    previousSecondaryDns: Object.freeze([...value.previousSecondaryDns].sort()),
    config: encodedFileSnapshot(value.config),
    receipt: encodedFileSnapshot(value.receipt),
    createdAt,
  });
  if (digest(snapshotDigestPayload(snapshot)) !== snapshot.snapshotDigest) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_invalid',
      'PowerDNS rollback snapshot digest is invalid',
    );
  }
  return snapshot;
}

function publicRollbackSnapshot(value) {
  if (!value) return Object.freeze({ available: false, reason: 'powerdns_rollback_snapshot_missing' });
  return Object.freeze({
    available: value.available,
    reason: value.reason,
    snapshotDigest: value.snapshotDigest,
    previousSecondaryDns: value.previousSecondaryDns,
    createdAt: value.createdAt,
  });
}

function persistedRollbackCompensation(value) {
  const fields = new Set([
    'version', 'operationId', 'serverId', 'credentialRevision', 'rollbackSnapshotDigest',
    'config', 'receipt', 'createdAt', 'compensationDigest',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.version !== ROLLBACK_COMPENSATION_VERSION
    || typeof value.operationId !== 'string' || !OPERATION_ID_PATTERN.test(value.operationId)
    || typeof value.serverId !== 'string' || !value.serverId
    || !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1
    || typeof value.rollbackSnapshotDigest !== 'string' || !SNAPSHOT_DIGEST_PATTERN.test(value.rollbackSnapshotDigest)
    || typeof value.compensationDigest !== 'string' || !SNAPSHOT_DIGEST_PATTERN.test(value.compensationDigest)) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_compensation_invalid',
      'PowerDNS rollback compensation snapshot is invalid',
    );
  }
  let config;
  let receipt;
  let createdAt;
  try {
    config = encodedFileSnapshot(value.config);
    receipt = encodedFileSnapshot(value.receipt);
    createdAt = timestamp(value.createdAt);
  } catch {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_compensation_invalid',
      'PowerDNS rollback compensation snapshot content is invalid',
    );
  }
  const snapshot = Object.freeze({ ...value, config, receipt, createdAt });
  if (digest(compensationDigestPayload(snapshot)) !== snapshot.compensationDigest) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_compensation_invalid',
      'PowerDNS rollback compensation snapshot digest is invalid',
    );
  }
  return snapshot;
}

function buildRollbackCompensation({ operationId, spec, snapshotDigest, configSnapshot, receiptSnapshot, createdAt }) {
  const payload = Object.freeze({
    version: ROLLBACK_COMPENSATION_VERSION,
    operationId,
    serverId: spec.serverId,
    credentialRevision: spec.apiKeyRevision,
    rollbackSnapshotDigest: snapshotDigest,
    config: encodeSnapshotFile(configSnapshot),
    receipt: encodeSnapshotFile(receiptSnapshot),
    createdAt,
  });
  return persistedRollbackCompensation({
    ...payload,
    compensationDigest: digest(payload),
  });
}

async function regularFileState(target, lstatFn) {
  try {
    const info = await lstatFn(target);
    return Object.freeze({
      exists: true,
      regular: Boolean(info?.isFile?.()) && !Boolean(info?.isSymbolicLink?.()),
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ exists: false, regular: false });
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_managed_path_inspection_failed',
      'PowerDNS managed filesystem state could not be inspected',
    );
  }
}

async function managedConfigSnapshot({ lstatFn, readFileFn }) {
  let info;
  try { info = await lstatFn(powerDnsTemplatePolicy.configPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ exists: false });
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_config_snapshot_failed',
      'PowerDNS managed configuration could not be snapshotted before apply',
    );
  }
  if (!info?.isFile?.() || info?.isSymbolicLink?.()) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_config_path_drift',
      'Managed PowerDNS configuration path must be a regular file when it already exists',
    );
  }
  try {
    const content = await readFileFn(powerDnsTemplatePolicy.configPath);
    return Object.freeze({
      exists: true,
      content,
      uid: info.uid,
      gid: info.gid,
      mode: info.mode & 0o777,
    });
  } catch {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_config_snapshot_failed',
      'PowerDNS managed configuration could not be snapshotted before apply',
    );
  }
}

async function managedReceiptSnapshot({ lstatFn, readFileFn }) {
  const target = powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH;
  let info;
  try { info = await lstatFn(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ exists: false });
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_failed',
      'PowerDNS authoritative receipt could not be snapshotted before apply',
    );
  }
  if (!info?.isFile?.() || info?.isSymbolicLink?.()) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_failed',
      'PowerDNS authoritative receipt must be a regular file before apply',
    );
  }
  try {
    const content = await readFileFn(target);
    return Object.freeze({
      exists: true,
      content,
      uid: info.uid,
      gid: info.gid,
      mode: info.mode & 0o777,
    });
  } catch {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_failed',
      'PowerDNS authoritative receipt could not be snapshotted before apply',
    );
  }
}

function encodeSnapshotFile(value) {
  if (!value?.exists || !Buffer.isBuffer(value.content)
    || value.content.length < 1 || value.content.length > MAX_SNAPSHOT_FILE_BYTES
    || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.gid) || value.gid < 0
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_failed',
      'PowerDNS rollback source file metadata is invalid',
    );
  }
  return Object.freeze({
    content: value.content.toString('base64'),
    uid: value.uid,
    gid: value.gid,
    mode: value.mode,
  });
}

function decodeSnapshotFile(value) {
  const normalized = encodedFileSnapshot(value);
  return Object.freeze({
    exists: true,
    content: Buffer.from(normalized.content, 'base64'),
    uid: normalized.uid,
    gid: normalized.gid,
    mode: normalized.mode,
  });
}

function sameFileSnapshot(left, right) {
  if (left?.exists !== right?.exists) return false;
  if (!left?.exists) return true;
  return Buffer.isBuffer(left.content) && Buffer.isBuffer(right.content)
    && left.content.equals(right.content)
    && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}

function buildRollbackSnapshot({ operationId, spec, configSnapshot, receiptSnapshot, createdAt }) {
  const unavailable = (reason) => persistedRollbackSnapshot({
    version: ROLLBACK_SNAPSHOT_VERSION,
    operationId,
    serverId: spec.serverId,
    credentialRevision: spec.apiKeyRevision,
    available: false,
    reason,
    previousSecondaryDns: null,
    snapshotDigest: null,
    config: null,
    receipt: null,
    createdAt,
  });
  if (!configSnapshot.exists) return unavailable('powerdns_rollback_previous_config_missing');
  if (!receiptSnapshot.exists) return unavailable('powerdns_rollback_previous_receipt_missing');

  const config = encodeSnapshotFile(configSnapshot);
  const receipt = encodeSnapshotFile(receiptSnapshot);
  let rawReceipt;
  try { rawReceipt = JSON.parse(Buffer.from(receipt.content, 'base64').toString('utf8')); }
  catch {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_failed',
      'Previous PowerDNS authoritative receipt is invalid',
    );
  }
  if (rawReceipt?.serverId !== spec.serverId) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_credential_mismatch',
      'Previous PowerDNS state belongs to another server identity',
    );
  }
  if (rawReceipt.apiKeyRevision !== spec.apiKeyRevision) {
    return unavailable('powerdns_rollback_previous_credential_unavailable');
  }
  const previousSpec = powerDnsAuthoritativeManagerInternals.normalizeIntent({
    ...spec,
    secondaryDns: rawReceipt.secondaryDns,
  });
  const configContent = Buffer.from(config.content, 'base64').toString('utf8');
  const previousReceipt = powerDnsAuthoritativeManagerInternals.receiptValue(rawReceipt, previousSpec, configContent);
  const apiKeyHash = powerDnsAuthoritativeManagerInternals.apiKeyHashFromConfig(configContent);
  if (!apiKeyHash || renderManagedPowerDnsConfig({
    apiKeyHash,
    secondaryDns: previousSpec.secondaryDns,
  }) !== configContent) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_rollback_snapshot_failed',
      'Previous PowerDNS managed configuration does not match its receipt',
    );
  }
  void previousReceipt;
  const payload = Object.freeze({
    version: ROLLBACK_SNAPSHOT_VERSION,
    operationId,
    serverId: spec.serverId,
    credentialRevision: spec.apiKeyRevision,
    previousSecondaryDns: previousSpec.secondaryDns,
    config,
    receipt,
    createdAt,
  });
  return persistedRollbackSnapshot({
    ...payload,
    available: true,
    reason: null,
    snapshotDigest: digest(payload),
  });
}

async function restoreManagedFile(target, snapshot, {
  chmodFn,
  chownFn,
  renameFn,
  rmFn,
  writeFileFn,
}, label = 'rollback') {
  if (!snapshot.exists) {
    await rmFn(target, { force: true });
    return;
  }
  if (!Number.isInteger(snapshot.uid) || !Number.isInteger(snapshot.gid)
    || !Number.isInteger(snapshot.mode)) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_config_snapshot_invalid',
      'PowerDNS managed configuration snapshot metadata is invalid',
    );
  }
  const temporary = `${target}.${process.pid}.${label}.tmp`;
  try {
    await writeFileFn(temporary, snapshot.content, { mode: snapshot.mode });
    await chownFn(temporary, snapshot.uid, snapshot.gid);
    await chmodFn(temporary, snapshot.mode);
    await renameFn(temporary, target);
  } finally {
    try { await rmFn(temporary, { force: true }); } catch { /* ignored */ }
  }
}

async function restoreManagedConfig(snapshot, dependencies) {
  return restoreManagedFile(powerDnsTemplatePolicy.configPath, snapshot, dependencies);
}

async function restoreManagedReceipt(snapshot, dependencies) {
  return restoreManagedFile(
    powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH,
    snapshot,
    dependencies,
    'receipt-rollback',
  );
}

export function createPowerDnsAuthoritativeSecureManager({
  manager = createPowerDnsAuthoritativeManager(),
  rollbackSnapshotPath = DEFAULT_ROLLBACK_SNAPSHOT_PATH,
  rollbackCompensationPath = DEFAULT_ROLLBACK_COMPENSATION_PATH,
  socketInspector = createPowerDnsSocketHealthInspector(),
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
  now = () => Date.now(),
} = {}) {
  if (!manager || typeof manager.inspect !== 'function' || typeof manager.apply !== 'function'
    || typeof rollbackSnapshotPath !== 'string' || !rollbackSnapshotPath
    || typeof rollbackCompensationPath !== 'string' || !rollbackCompensationPath
    || !socketInspector || typeof socketInspector.inspect !== 'function'
    || typeof chmodFn !== 'function' || typeof chownFn !== 'function' || typeof lstatFn !== 'function'
    || typeof mkdirFn !== 'function' || typeof readFileFn !== 'function' || typeof renameFn !== 'function'
    || typeof rmFn !== 'function' || typeof writeFileFn !== 'function' || typeof now !== 'function') {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_secure_manager_dependencies_invalid',
      'PowerDNS secure manager dependencies are unavailable',
    );
  }

  function operationId(value) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || typeof value.operationId !== 'string'
      || !OPERATION_ID_PATTERN.test(value.operationId)) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_context_invalid',
        'PowerDNS durable apply operation context is invalid',
      );
    }
    return value.operationId;
  }

  function rollbackContext(value) {
    const fields = new Set(['operationId', 'snapshotDigest']);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
      || typeof value.operationId !== 'string' || !OPERATION_ID_PATTERN.test(value.operationId)
      || typeof value.snapshotDigest !== 'string' || !SNAPSHOT_DIGEST_PATTERN.test(value.snapshotDigest)) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_context_invalid',
        'PowerDNS rollback requires an exact operation and snapshot digest',
      );
    }
    return Object.freeze({ operationId: value.operationId, snapshotDigest: value.snapshotDigest });
  }

  async function readRollbackSnapshot() {
    let info;
    try { info = await lstatFn(rollbackSnapshotPath); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_snapshot_unavailable',
        'PowerDNS rollback snapshot could not be inspected',
      );
    }
    if (!info?.isFile?.() || info?.isSymbolicLink?.()
      || info.uid !== 0 || (info.mode & 0o777) !== 0o600) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_snapshot_unsafe',
        'PowerDNS rollback snapshot must be a root-owned private regular file',
      );
    }
    try { return persistedRollbackSnapshot(JSON.parse(await readFileFn(rollbackSnapshotPath, 'utf8'))); }
    catch (error) {
      if (error instanceof PowerDnsAuthoritativeManagerError) throw error;
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_snapshot_invalid',
        'PowerDNS rollback snapshot content is invalid',
      );
    }
  }

  async function readRollbackCompensation() {
    let info;
    try { info = await lstatFn(rollbackCompensationPath); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_compensation_unavailable',
        'PowerDNS rollback compensation snapshot could not be inspected',
      );
    }
    if (!info?.isFile?.() || info?.isSymbolicLink?.()
      || info.uid !== 0 || (info.mode & 0o777) !== 0o600) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_compensation_unsafe',
        'PowerDNS rollback compensation snapshot must be a root-owned private regular file',
      );
    }
    try {
      return persistedRollbackCompensation(JSON.parse(await readFileFn(rollbackCompensationPath, 'utf8')));
    } catch (error) {
      if (error instanceof PowerDnsAuthoritativeManagerError) throw error;
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_compensation_invalid',
        'PowerDNS rollback compensation snapshot content is invalid',
      );
    }
  }

  async function persistRollbackSnapshot(snapshot) {
    const normalized = persistedRollbackSnapshot(snapshot);
    const directory = path.dirname(rollbackSnapshotPath);
    const temporary = `${rollbackSnapshotPath}.${process.pid}.tmp`;
    try {
      await mkdirFn(directory, { recursive: true, mode: 0o700 });
      await chmodFn(directory, 0o700);
      await writeFileFn(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await renameFn(temporary, rollbackSnapshotPath);
      await chmodFn(rollbackSnapshotPath, 0o600);
    } catch {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_snapshot_failed',
        'PowerDNS rollback snapshot could not be persisted before apply',
      );
    } finally {
      try { await rmFn(temporary, { force: true }); } catch { /* ignored */ }
    }
    return normalized;
  }

  async function persistRollbackCompensation(snapshot) {
    const normalized = persistedRollbackCompensation(snapshot);
    const directory = path.dirname(rollbackCompensationPath);
    const temporary = `${rollbackCompensationPath}.${process.pid}.tmp`;
    try {
      await mkdirFn(directory, { recursive: true, mode: 0o700 });
      await chmodFn(directory, 0o700);
      await writeFileFn(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await renameFn(temporary, rollbackCompensationPath);
      await chmodFn(rollbackCompensationPath, 0o600);
    } catch {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_compensation_persist_failed',
        'PowerDNS rollback compensation snapshot could not be persisted before mutation',
      );
    } finally {
      try { await rmFn(temporary, { force: true }); } catch { /* ignored */ }
    }
    return normalized;
  }

  function compensationMatches(value, request, spec) {
    return value?.operationId === request.operationId
      && value.serverId === spec.serverId
      && value.credentialRevision === spec.apiKeyRevision
      && value.rollbackSnapshotDigest === request.snapshotDigest;
  }

  async function verifiedSocketState(message) {
    const sockets = await socketInspector.inspect();
    if (!sockets || typeof sockets !== 'object') {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_socket_health_invalid',
        'PowerDNS socket health inspector returned invalid evidence',
      );
    }
    if (sockets.satisfied !== true) {
      throw new PowerDnsAuthoritativeManagerError(
        sockets.reason ?? 'powerdns_socket_unhealthy',
        message,
      );
    }
    return sockets;
  }

  async function prepareRollbackSnapshot(spec, currentOperationId, configSnapshot) {
    const existing = await readRollbackSnapshot();
    if (existing?.operationId === currentOperationId) {
      if (existing.serverId !== spec.serverId || existing.credentialRevision !== spec.apiKeyRevision) {
        throw new PowerDnsAuthoritativeManagerError(
          'powerdns_rollback_snapshot_conflict',
          'PowerDNS rollback snapshot belongs to a different operation intent',
        );
      }
      return existing;
    }
    const receiptSnapshot = await managedReceiptSnapshot({ lstatFn, readFileFn });
    const snapshot = buildRollbackSnapshot({
      operationId: currentOperationId,
      spec,
      configSnapshot,
      receiptSnapshot,
      createdAt: new Date(now()).toISOString(),
    });
    return persistRollbackSnapshot(snapshot);
  }

  async function rollbackStatus({ operationId: requestedOperationId, serverId, credentialRevision } = {}) {
    if (typeof requestedOperationId !== 'string' || !OPERATION_ID_PATTERN.test(requestedOperationId)
      || typeof serverId !== 'string' || !serverId
      || !Number.isSafeInteger(credentialRevision) || credentialRevision < 1) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_context_invalid',
        'PowerDNS rollback status scope is invalid',
      );
    }
    const snapshot = await readRollbackSnapshot();
    if (!snapshot || snapshot.operationId !== requestedOperationId
      || snapshot.serverId !== serverId || snapshot.credentialRevision !== credentialRevision) {
      return Object.freeze({ available: false, reason: 'powerdns_rollback_snapshot_mismatch' });
    }
    return publicRollbackSnapshot(snapshot);
  }

  async function assertManagedPaths() {
    for (const [target, code, message] of [
      [
        powerDnsTemplatePolicy.configPath,
        'powerdns_config_path_drift',
        'Managed PowerDNS configuration path must be a regular file when it already exists',
      ],
      [
        powerDnsTemplatePolicy.databasePath,
        'powerdns_database_path_drift',
        'Managed PowerDNS SQLite database path must be a regular file when it already exists',
      ],
    ]) {
      const state = await regularFileState(target, lstatFn);
      if (state.exists && !state.regular) throw new PowerDnsAuthoritativeManagerError(code, message);
    }
  }

  async function inspect(intent) {
    await assertManagedPaths();
    return manager.inspect(intent);
  }

  async function apply(intent, context) {
    await assertManagedPaths();
    const configSnapshot = await managedConfigSnapshot({ lstatFn, readFileFn });
    const currentOperationId = operationId(context);
    if (currentOperationId) {
      const spec = powerDnsAuthoritativeManagerInternals.normalizeIntent(intent);
      await prepareRollbackSnapshot(spec, currentOperationId, configSnapshot);
    }
    let result;
    try { result = await manager.apply(intent); }
    catch (error) {
      if (error?.code === 'powerdns_config_invalid') {
        try {
          await restoreManagedConfig(configSnapshot, {
            chmodFn,
            chownFn,
            renameFn,
            rmFn,
            writeFileFn,
          });
        } catch (rollbackError) {
          if (rollbackError instanceof PowerDnsAuthoritativeManagerError
            && rollbackError.code === 'powerdns_config_snapshot_invalid') throw rollbackError;
          throw new PowerDnsAuthoritativeManagerError(
            'powerdns_config_rollback_failed',
            'PowerDNS rejected the candidate configuration and the previous managed configuration could not be restored',
          );
        }
      }
      throw error;
    }
    await assertManagedPaths();
    return result;
  }

  async function rollback(intent, context) {
    if (typeof manager.activateRestored !== 'function') {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_activation_unavailable',
        'PowerDNS rollback activation dependency is unavailable',
      );
    }
    const request = rollbackContext(context);
    const spec = powerDnsAuthoritativeManagerInternals.normalizeIntent(intent);
    const snapshot = await readRollbackSnapshot();
    if (!snapshot || snapshot.operationId !== request.operationId
      || snapshot.serverId !== spec.serverId || snapshot.credentialRevision !== spec.apiKeyRevision) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_snapshot_mismatch',
        'PowerDNS rollback snapshot does not match the requested operation and credential scope',
      );
    }
    if (!snapshot.available) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_unavailable',
        `PowerDNS rollback snapshot is unavailable (${snapshot.reason})`,
      );
    }
    if (snapshot.snapshotDigest !== request.snapshotDigest) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_snapshot_stale',
        'PowerDNS rollback snapshot digest is stale',
      );
    }

    await assertManagedPaths();
    const previousSpec = powerDnsAuthoritativeManagerInternals.normalizeIntent({
      ...spec,
      secondaryDns: snapshot.previousSecondaryDns,
    });
    const previousConfig = decodeSnapshotFile(snapshot.config);
    const previousReceipt = decodeSnapshotFile(snapshot.receipt);
    const currentConfig = await managedConfigSnapshot({ lstatFn, readFileFn });
    const currentReceipt = await managedReceiptSnapshot({ lstatFn, readFileFn });
    let compensation = await readRollbackCompensation();
    if (!compensationMatches(compensation, request, spec)) {
      if (sameFileSnapshot(currentConfig, previousConfig) && sameFileSnapshot(currentReceipt, previousReceipt)) {
        compensation = null;
      } else {
        let inspected;
        try { inspected = await manager.inspect(spec); }
        catch {
          throw new PowerDnsAuthoritativeManagerError(
            'powerdns_rollback_current_state_unverified',
            'Current PowerDNS state could not be verified before rollback',
          );
        }
        if (inspected?.satisfied !== true) {
          throw new PowerDnsAuthoritativeManagerError(
            'powerdns_rollback_current_state_unverified',
            'Current PowerDNS state is not safe to replace with the rollback snapshot',
          );
        }
        const fencedConfig = await managedConfigSnapshot({ lstatFn, readFileFn });
        const fencedReceipt = await managedReceiptSnapshot({ lstatFn, readFileFn });
        if (!sameFileSnapshot(currentConfig, fencedConfig) || !sameFileSnapshot(currentReceipt, fencedReceipt)) {
          throw new PowerDnsAuthoritativeManagerError(
            'powerdns_rollback_current_state_changed',
            'Current PowerDNS files changed during rollback preflight',
          );
        }
        compensation = await persistRollbackCompensation(buildRollbackCompensation({
          operationId: request.operationId,
          spec,
          snapshotDigest: request.snapshotDigest,
          configSnapshot: currentConfig,
          receiptSnapshot: currentReceipt,
          createdAt: new Date(now()).toISOString(),
        }));
      }
    }

    const compensatingConfig = compensation ? decodeSnapshotFile(compensation.config) : null;
    const compensatingReceipt = compensation ? decodeSnapshotFile(compensation.receipt) : null;
    const liveConfig = await managedConfigSnapshot({ lstatFn, readFileFn });
    const liveReceipt = await managedReceiptSnapshot({ lstatFn, readFileFn });
    const configIsPrevious = sameFileSnapshot(liveConfig, previousConfig);
    const receiptIsPrevious = sameFileSnapshot(liveReceipt, previousReceipt);
    const configIsCurrent = compensation ? sameFileSnapshot(liveConfig, compensatingConfig) : false;
    const receiptIsCurrent = compensation ? sameFileSnapshot(liveReceipt, compensatingReceipt) : false;
    if ((!configIsPrevious && !configIsCurrent) || (!receiptIsPrevious && !receiptIsCurrent)) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_rollback_current_state_changed',
        'PowerDNS files no longer match the exact rollback or compensation snapshots',
      );
    }

    const restorationDependencies = { chmodFn, chownFn, renameFn, rmFn, writeFileFn };
    try {
      if (!configIsPrevious) await restoreManagedConfig(previousConfig, restorationDependencies);
      if (!receiptIsPrevious) await restoreManagedReceipt(previousReceipt, restorationDependencies);
      let verified = null;
      if (configIsPrevious && receiptIsPrevious) {
        try { verified = await manager.inspect(previousSpec); } catch { /* activation performs the authoritative check */ }
      }
      if (verified?.satisfied !== true) verified = await manager.activateRestored(previousSpec);
      if (verified?.satisfied !== true) {
        throw new PowerDnsAuthoritativeManagerError(
          'powerdns_rollback_unverified',
          'PowerDNS rollback activation did not produce a verified authoritative state',
        );
      }
      const sockets = await verifiedSocketState(
        'PowerDNS rollback completed with unhealthy DNS socket or recursion policy evidence',
      );
      return Object.freeze({
        ...verified,
        sockets,
        rollback: Object.freeze({
          operationId: snapshot.operationId,
          snapshotDigest: snapshot.snapshotDigest,
          alreadyRestored: configIsPrevious && receiptIsPrevious,
        }),
      });
    } catch (error) {
      if (!compensation) throw error;
      try {
        await restoreManagedConfig(compensatingConfig, restorationDependencies);
        await restoreManagedReceipt(compensatingReceipt, restorationDependencies);
        const compensated = await manager.activateRestored(spec);
        if (compensated?.satisfied !== true) throw new Error('compensation unverified');
        await verifiedSocketState(
          'PowerDNS rollback compensation restored unhealthy DNS socket or recursion policy evidence',
        );
      } catch {
        throw new PowerDnsAuthoritativeManagerError(
          'powerdns_rollback_compensation_failed',
          'PowerDNS rollback failed and the current authoritative state could not be recovered',
        );
      }
      throw error;
    }
  }

  return Object.freeze({ inspect, apply, rollbackStatus, rollback });
}

export const powerDnsAuthoritativeSecureManagerInternals = Object.freeze({
  regularFileState,
  managedConfigSnapshot,
  managedReceiptSnapshot,
  encodeSnapshotFile,
  decodeSnapshotFile,
  sameFileSnapshot,
  buildRollbackSnapshot,
  restoreManagedFile,
  restoreManagedConfig,
  restoreManagedReceipt,
  persistedRollbackSnapshot,
  persistedRollbackCompensation,
  buildRollbackCompensation,
  publicRollbackSnapshot,
  rollbackSnapshotPath: DEFAULT_ROLLBACK_SNAPSHOT_PATH,
  rollbackCompensationPath: DEFAULT_ROLLBACK_COMPENSATION_PATH,
});
