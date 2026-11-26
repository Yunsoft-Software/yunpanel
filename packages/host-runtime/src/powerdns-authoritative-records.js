// Pure validation and serialization for PowerDNS authoritative state files:
// host intent, apply receipt, operation journal, rollback snapshot and compensation.
import { createHash } from 'node:crypto';
import { renderManagedPowerDnsConfig } from '@yunpanel/config-templates/powerdns';

const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const SNAPSHOT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_JOURNAL_VERSION = 1;
export const JOURNAL_VERSION = 2;
const ROLLBACK_SNAPSHOT_VERSION = 1;
const ROLLBACK_COMPENSATION_VERSION = 1;
const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024;
const OPERATION_STATUSES = new Set(['applying', 'succeeded', 'failed', 'rolling_back', 'rolled_back', 'rollback_failed']);
export const ROLLBACK_CAPABLE_STATUSES = Object.freeze(['succeeded', 'rolling_back', 'rolled_back', 'rollback_failed']);
const UNAVAILABLE_ROLLBACK_REASONS = Object.freeze([
  'powerdns_rollback_previous_config_missing',
  'powerdns_rollback_previous_receipt_missing',
  'powerdns_rollback_previous_credential_unavailable',
]);

export class PowerDnsAuthoritativeManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PowerDnsAuthoritativeManagerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PowerDnsAuthoritativeManagerError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isoTimestamp(value, code, message) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(code, message);
  }
  return value;
}

// ---- Host intent, config and receipt ----

export function normalizeIntent(value) {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['serverId', 'apiKey', 'apiKeyRevision', 'secondaryDns'].includes(key))
    || typeof value.serverId !== 'string' || !UUID_PATTERN.test(value.serverId)
    || typeof value.apiKey !== 'string' || !API_KEY_PATTERN.test(value.apiKey)
    || !Number.isSafeInteger(value.apiKeyRevision) || value.apiKeyRevision < 1
    || !Array.isArray(value.secondaryDns)) {
    fail('powerdns_intent_invalid', 'PowerDNS authoritative intent is invalid');
  }
  try { renderManagedPowerDnsConfig({ apiKeyHash: 'placeholder-hash-value-00000000000000000000', secondaryDns: value.secondaryDns }); }
  catch { fail('powerdns_intent_invalid', 'PowerDNS authoritative secondary DNS settings are invalid'); }
  return Object.freeze({
    serverId: value.serverId.toLowerCase(),
    apiKey: value.apiKey,
    apiKeyRevision: value.apiKeyRevision,
    secondaryDns: Object.freeze([...value.secondaryDns].sort()),
  });
}

export function packageStatus(output) {
  const [status = '', version = ''] = String(output ?? '').trim().split('\t');
  const installed = status === 'install ok installed';
  return Object.freeze({ installed, version: installed && version ? version : null });
}

export function includeDirConfigured(content) {
  return String(content ?? '').split(/\r?\n/).some((line) => /^\s*include-dir\s*=\s*\/etc\/powerdns\/pdns\.d\s*$/.test(line));
}

export function apiKeyHashFromConfig(content) {
  const match = String(content ?? '').match(/^api-key=([^\r\n]+)$/m);
  if (!match || match[1].length < 20 || match[1].length > 512 || /[\u0000-\u001f\u007f]/.test(match[1])) return null;
  return match[1];
}

export function fileIdentity(output) {
  const [owner, group, mode] = String(output ?? '').trim().split(':');
  return Object.freeze({ owner, group, mode });
}

export function sameSecondaryDns(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// The managed config is valid for a spec only when it is exactly the template for its own API key hash.
export function configMatchesSpec(config, spec) {
  const hash = apiKeyHashFromConfig(config);
  return Boolean(hash) && renderManagedPowerDnsConfig({ apiKeyHash: hash, secondaryDns: spec.secondaryDns }) === config;
}

export function buildReceipt(spec, config, appliedAt) {
  return {
    version: 1,
    serverId: spec.serverId,
    apiKeyRevision: spec.apiKeyRevision,
    secondaryDns: [...spec.secondaryDns],
    configLength: Buffer.byteLength(config, 'utf8'),
    appliedAt,
  };
}

export function receiptValue(value, spec, configContent) {
  if (!isRecord(value)
    || value.version !== 1 || value.serverId !== spec.serverId || value.apiKeyRevision !== spec.apiKeyRevision
    || !sameSecondaryDns(value.secondaryDns, spec.secondaryDns)
    || value.configLength !== Buffer.byteLength(configContent, 'utf8')
    || typeof value.appliedAt !== 'string' || !Number.isFinite(Date.parse(value.appliedAt))) {
    fail('powerdns_receipt_invalid', 'PowerDNS authoritative receipt is invalid');
  }
  return Object.freeze({ ...value, secondaryDns: Object.freeze([...value.secondaryDns]) });
}

// Restored files are activated only when they are exactly the rollback intent's config and receipt.
export function assertRestoredState(spec, config, receiptRaw) {
  if (config === null) fail('powerdns_rollback_config_missing', 'Restored PowerDNS managed configuration is missing');
  if (!configMatchesSpec(config, spec)) {
    fail('powerdns_rollback_config_invalid', 'Restored PowerDNS managed configuration does not match rollback intent');
  }
  if (receiptRaw === null) fail('powerdns_rollback_receipt_missing', 'Restored PowerDNS authoritative receipt is missing');
  try { receiptValue(JSON.parse(receiptRaw), spec, config); }
  catch {
    fail('powerdns_rollback_receipt_invalid', 'Restored PowerDNS authoritative receipt does not match rollback intent');
  }
}

// ---- Operation journal ----

function journalTimestamp(value) {
  return isoTimestamp(value, 'powerdns_operation_state_invalid', 'PowerDNS authoritative operation timestamp is invalid');
}

function safeError(value) {
  if (value === null) return null;
  if (!isRecord(value)
    || typeof value.code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    fail('powerdns_operation_state_invalid', 'PowerDNS authoritative operation error evidence is invalid');
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function safePackages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.some((entry) => !entry || typeof entry !== 'object'
    || entry.installed !== true || typeof entry.version !== 'string' || !entry.version)) {
    fail('powerdns_operation_evidence_invalid', 'PowerDNS package evidence is invalid');
  }
  return Object.freeze(value.map((entry) => Object.freeze({ installed: true, version: entry.version })));
}

function normalizeSecondaryDns(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    fail('powerdns_operation_state_invalid', 'PowerDNS secondary DNS operation evidence is invalid');
  }
  return Object.freeze([...value].sort());
}

function resultEvidence(value) {
  if (value === null) return null;
  if (!isRecord(value)
    || value.satisfied !== true || typeof value.serverId !== 'string' || !value.serverId
    || !Number.isSafeInteger(value.apiKeyRevision) || value.apiKeyRevision < 1
    || typeof value.receiptAppliedAt !== 'string') {
    fail('powerdns_operation_evidence_invalid', 'PowerDNS authoritative operation result evidence is invalid');
  }
  return Object.freeze({
    satisfied: true,
    serverId: value.serverId,
    apiKeyRevision: value.apiKeyRevision,
    secondaryDns: normalizeSecondaryDns(value.secondaryDns),
    packages: safePackages(value.packages),
    receiptAppliedAt: journalTimestamp(value.receiptAppliedAt),
  });
}

const JOURNAL_FIELDS = Object.freeze([
  'version', 'id', 'serverId', 'apiKeyRevision', 'secondaryDns', 'status', 'result', 'lastError', 'createdAt', 'updatedAt',
]);

export function persistedOperation(value) {
  if (!isRecord(value) || !hasExactFields(value, JOURNAL_FIELDS)
    || ![LEGACY_JOURNAL_VERSION, JOURNAL_VERSION].includes(value.version)
    || typeof value.id !== 'string' || !OPERATION_ID_PATTERN.test(value.id)
    || typeof value.serverId !== 'string' || !value.serverId
    || !Number.isSafeInteger(value.apiKeyRevision) || value.apiKeyRevision < 1
    || !OPERATION_STATUSES.has(value.status)) {
    fail('powerdns_operation_state_invalid', 'PowerDNS authoritative operation state is invalid');
  }
  const operation = Object.freeze({
    version: JOURNAL_VERSION,
    id: value.id,
    serverId: value.serverId,
    apiKeyRevision: value.apiKeyRevision,
    secondaryDns: normalizeSecondaryDns(value.secondaryDns),
    status: value.status,
    result: resultEvidence(value.result),
    lastError: safeError(value.lastError),
    createdAt: journalTimestamp(value.createdAt),
    updatedAt: journalTimestamp(value.updatedAt),
  });
  if (['succeeded', 'rolling_back', 'rolled_back', 'rollback_failed'].includes(operation.status) && operation.result === null) {
    fail('powerdns_operation_state_invalid', 'Completed PowerDNS apply evidence is missing');
  }
  if (['applying', 'failed'].includes(operation.status) && operation.result !== null) {
    fail('powerdns_operation_state_invalid', 'Incomplete PowerDNS apply cannot contain result evidence');
  }
  if (operation.status === 'applying' && operation.lastError !== null && !operation.lastError.code.startsWith('powerdns_')) {
    fail('powerdns_operation_state_invalid', 'PowerDNS recovery error code is invalid');
  }
  return operation;
}

export function safeFailure(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code) ? error.code : 'powerdns_apply_failed';
  const message = typeof error?.message === 'string' && error.message.length > 0 && error.message.length <= 500
    ? error.message
    : 'PowerDNS authoritative apply failed';
  return Object.freeze({ code, message });
}

export function operationMatches(operation, spec) {
  return Boolean(operation
    && operation.serverId === spec.serverId
    && operation.apiKeyRevision === spec.apiKeyRevision
    && sameSecondaryDns(operation.secondaryDns, [...spec.secondaryDns].sort()));
}

export function evidenceFromInspection(spec, inspected) {
  if (!inspected || inspected.satisfied !== true
    || inspected.serverId !== spec.serverId
    || inspected.apiKeyRevision !== spec.apiKeyRevision
    || !sameSecondaryDns(normalizeSecondaryDns(inspected.secondaryDns), spec.secondaryDns)
    || typeof inspected.receipt?.appliedAt !== 'string') {
    fail('powerdns_operation_evidence_invalid', 'PowerDNS authoritative post-condition evidence does not match the requested intent');
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

function interrupted(operation) {
  return ['applying', 'rolling_back'].includes(operation.status);
}

function rollbackProjection(operation, snapshot) {
  const completed = operation.status === 'rolled_back';
  const statusByOperation = { rolling_back: 'applying', rolled_back: 'succeeded', rollback_failed: 'failed' };
  return Object.freeze({
    status: statusByOperation[operation.status] ?? 'idle',
    available: snapshot.available === true && ['succeeded', 'rolling_back', 'rollback_failed'].includes(operation.status),
    reason: completed ? 'powerdns_rollback_already_completed' : snapshot.reason,
    snapshotDigest: snapshot.snapshotDigest ?? null,
    previousSecondaryDns: snapshot.previousSecondaryDns ?? null,
    snapshotCreatedAt: snapshot.createdAt ?? null,
    automaticReplayBlocked: operation.status === 'rolling_back',
  });
}

export function publicOperation(operation, snapshot) {
  if (!operation) return null;
  const blocked = interrupted(operation);
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
      required: blocked,
      automaticReplayBlocked: blocked,
      reason: blocked
        ? operation.lastError?.code ?? (operation.status === 'rolling_back' ? 'powerdns_interrupted_rollback' : 'powerdns_interrupted_apply')
        : null,
    }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    rollback: rollbackProjection(operation, snapshot),
  });
}

// ---- Rollback snapshot and compensation files ----

function snapshotTimestamp(value) {
  return isoTimestamp(value, 'powerdns_rollback_snapshot_invalid', 'PowerDNS rollback snapshot timestamp is invalid');
}

function encodedFileSnapshot(value) {
  if (!isRecord(value) || !hasExactFields(value, ['content', 'uid', 'gid', 'mode'])
    || typeof value.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.content)
    || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.gid) || value.gid < 0
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777) {
    fail('powerdns_rollback_snapshot_invalid', 'PowerDNS rollback file snapshot is invalid');
  }
  const content = Buffer.from(value.content, 'base64');
  if (content.length < 1 || content.length > MAX_SNAPSHOT_FILE_BYTES || content.toString('base64') !== value.content) {
    fail('powerdns_rollback_snapshot_invalid', 'PowerDNS rollback file snapshot content is invalid');
  }
  return Object.freeze({ content: value.content, uid: value.uid, gid: value.gid, mode: value.mode });
}

export function encodeSnapshotFile(value) {
  if (!value?.exists || !Buffer.isBuffer(value.content)
    || value.content.length < 1 || value.content.length > MAX_SNAPSHOT_FILE_BYTES
    || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.gid) || value.gid < 0
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777) {
    fail('powerdns_rollback_snapshot_failed', 'PowerDNS rollback source file metadata is invalid');
  }
  return Object.freeze({ content: value.content.toString('base64'), uid: value.uid, gid: value.gid, mode: value.mode });
}

export function decodeSnapshotFile(value) {
  const normalized = encodedFileSnapshot(value);
  return Object.freeze({
    exists: true,
    content: Buffer.from(normalized.content, 'base64'),
    uid: normalized.uid,
    gid: normalized.gid,
    mode: normalized.mode,
  });
}

export function sameFileSnapshot(left, right) {
  if (left?.exists !== right?.exists) return false;
  if (!left?.exists) return true;
  return Buffer.isBuffer(left.content) && Buffer.isBuffer(right.content)
    && left.content.equals(right.content)
    && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
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

const SNAPSHOT_FIELDS = Object.freeze([
  'version', 'operationId', 'serverId', 'credentialRevision', 'available', 'reason',
  'previousSecondaryDns', 'snapshotDigest', 'config', 'receipt', 'createdAt',
]);

export function persistedRollbackSnapshot(value) {
  const invalid = (message) => fail('powerdns_rollback_snapshot_invalid', message);
  if (!isRecord(value) || !hasExactFields(value, SNAPSHOT_FIELDS)
    || value.version !== ROLLBACK_SNAPSHOT_VERSION
    || typeof value.operationId !== 'string' || !OPERATION_ID_PATTERN.test(value.operationId)
    || typeof value.serverId !== 'string' || !value.serverId
    || !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1
    || typeof value.available !== 'boolean') {
    invalid('PowerDNS rollback snapshot is invalid');
  }
  const createdAt = snapshotTimestamp(value.createdAt);
  if (!value.available) {
    if (!UNAVAILABLE_ROLLBACK_REASONS.includes(value.reason)
      || value.previousSecondaryDns !== null || value.snapshotDigest !== null
      || value.config !== null || value.receipt !== null) {
      invalid('Unavailable PowerDNS rollback snapshot state is invalid');
    }
    return Object.freeze({ ...value, createdAt });
  }
  if (value.reason !== null || !Array.isArray(value.previousSecondaryDns)
    || value.previousSecondaryDns.some((entry) => typeof entry !== 'string' || !entry)
    || typeof value.snapshotDigest !== 'string' || !SNAPSHOT_DIGEST_PATTERN.test(value.snapshotDigest)) {
    invalid('Available PowerDNS rollback snapshot state is invalid');
  }
  const snapshot = Object.freeze({
    ...value,
    previousSecondaryDns: Object.freeze([...value.previousSecondaryDns].sort()),
    config: encodedFileSnapshot(value.config),
    receipt: encodedFileSnapshot(value.receipt),
    createdAt,
  });
  if (digest(snapshotDigestPayload(snapshot)) !== snapshot.snapshotDigest) invalid('PowerDNS rollback snapshot digest is invalid');
  return snapshot;
}

export function publicRollbackSnapshot(value) {
  if (!value) return Object.freeze({ available: false, reason: 'powerdns_rollback_snapshot_missing' });
  return Object.freeze({
    available: value.available,
    reason: value.reason,
    snapshotDigest: value.snapshotDigest,
    previousSecondaryDns: value.previousSecondaryDns,
    createdAt: value.createdAt,
  });
}

const COMPENSATION_FIELDS = Object.freeze([
  'version', 'operationId', 'serverId', 'credentialRevision', 'rollbackSnapshotDigest',
  'config', 'receipt', 'createdAt', 'compensationDigest',
]);

export function persistedRollbackCompensation(value) {
  const invalid = (message) => fail('powerdns_rollback_compensation_invalid', message);
  if (!isRecord(value) || !hasExactFields(value, COMPENSATION_FIELDS)
    || value.version !== ROLLBACK_COMPENSATION_VERSION
    || typeof value.operationId !== 'string' || !OPERATION_ID_PATTERN.test(value.operationId)
    || typeof value.serverId !== 'string' || !value.serverId
    || !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1
    || typeof value.rollbackSnapshotDigest !== 'string' || !SNAPSHOT_DIGEST_PATTERN.test(value.rollbackSnapshotDigest)
    || typeof value.compensationDigest !== 'string' || !SNAPSHOT_DIGEST_PATTERN.test(value.compensationDigest)) {
    invalid('PowerDNS rollback compensation snapshot is invalid');
  }
  let content;
  try {
    content = {
      config: encodedFileSnapshot(value.config),
      receipt: encodedFileSnapshot(value.receipt),
      createdAt: snapshotTimestamp(value.createdAt),
    };
  } catch {
    invalid('PowerDNS rollback compensation snapshot content is invalid');
  }
  const snapshot = Object.freeze({ ...value, ...content });
  if (digest(compensationDigestPayload(snapshot)) !== snapshot.compensationDigest) {
    invalid('PowerDNS rollback compensation snapshot digest is invalid');
  }
  return snapshot;
}

export function buildRollbackCompensation({ operationId, spec, snapshotDigest, configSnapshot, receiptSnapshot, createdAt }) {
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
  return persistedRollbackCompensation({ ...payload, compensationDigest: digest(payload) });
}

export function buildRollbackSnapshot({ operationId, spec, configSnapshot, receiptSnapshot, createdAt }) {
  const scope = {
    version: ROLLBACK_SNAPSHOT_VERSION,
    operationId,
    serverId: spec.serverId,
    credentialRevision: spec.apiKeyRevision,
  };
  const unavailable = (reason) => persistedRollbackSnapshot({
    ...scope,
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
  try { rawReceipt = JSON.parse(receiptSnapshot.content.toString('utf8')); }
  catch { fail('powerdns_rollback_snapshot_failed', 'Previous PowerDNS authoritative receipt is invalid'); }
  if (rawReceipt?.serverId !== spec.serverId) {
    fail('powerdns_rollback_credential_mismatch', 'Previous PowerDNS state belongs to another server identity');
  }
  if (rawReceipt.apiKeyRevision !== spec.apiKeyRevision) return unavailable('powerdns_rollback_previous_credential_unavailable');
  const previousSpec = normalizeIntent({ ...spec, secondaryDns: rawReceipt.secondaryDns });
  const configContent = configSnapshot.content.toString('utf8');
  receiptValue(rawReceipt, previousSpec, configContent);
  if (!configMatchesSpec(configContent, previousSpec)) {
    fail('powerdns_rollback_snapshot_failed', 'Previous PowerDNS managed configuration does not match its receipt');
  }
  const payload = Object.freeze({
    ...scope,
    previousSecondaryDns: previousSpec.secondaryDns,
    config,
    receipt,
    createdAt,
  });
  return persistedRollbackSnapshot({ ...payload, available: true, reason: null, snapshotDigest: digest(payload) });
}
