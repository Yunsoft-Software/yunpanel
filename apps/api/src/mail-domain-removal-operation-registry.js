import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';

const STORE_VERSION = 1;
const PHASES = new Set(['pending', 'disabling', 'cleaning', 'deleting_data', 'finalizing', 'removed']);
const STATUSES = new Set([...PHASES, 'blocked', 'failed']);
const INTERRUPTED_STATUSES = new Set(['disabling', 'cleaning', 'deleting_data', 'finalizing']);
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,160}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_STATUSES = new Set(['disabled', 'enabled']);
const EXTERNAL_STATUSES = new Set(['unverified', 'ready', 'degraded']);
const EVIDENCE_FIELDS = Object.freeze([
  'disableJobId', 'finalRevision', 'cleanupEvidenceDigest', 'dataDeleteJobId', 'backupId',
]);

export class MailDomainRemovalOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainRemovalOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) {
  return new MailDomainRemovalOperationRegistryError(
    'mail_domain_removal_operation_state_invalid',
    message,
    409,
  );
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw invalid(`${field} is invalid`);
  return value;
}

function optionalId(value, field) {
  return value === null ? null : safeId(value, field);
}

function safeDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw invalid(`${field} is invalid`);
  return value;
}

function optionalDigest(value, field) {
  return value === null ? null : safeDigest(value, field);
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw invalid(`${field} is invalid`);
  return value;
}

function canonicalDomainName(value) {
  let canonical;
  try { canonical = normalizeDomainSet(value, []).primary; }
  catch { throw invalid('domainName is invalid'); }
  if (canonical !== value) throw invalid('domainName is not canonical');
  return canonical;
}

function safeError(value) {
  if (value === null) return null;
  const fields = new Set(['code', 'message']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    throw invalid('Mail Domain removal failure evidence is invalid');
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== EVIDENCE_FIELDS.length
    || Object.keys(value).some((field) => !EVIDENCE_FIELDS.includes(field))) {
    throw invalid('Mail Domain removal phase evidence is invalid');
  }
  return Object.freeze({
    disableJobId: optionalId(value.disableJobId, 'disableJobId'),
    finalRevision: value.finalRevision,
    cleanupEvidenceDigest: optionalDigest(value.cleanupEvidenceDigest, 'cleanupEvidenceDigest'),
    dataDeleteJobId: optionalId(value.dataDeleteJobId, 'dataDeleteJobId'),
    backupId: optionalId(value.backupId, 'backupId'),
  });
}

function emptyEvidence() {
  return Object.freeze({
    disableJobId: null,
    finalRevision: null,
    cleanupEvidenceDigest: null,
    dataDeleteJobId: null,
    backupId: null,
  });
}

function expectedRemovalMethod(managementMode) {
  return managementMode === 'local'
    ? 'local_verified_data_finalize'
    : 'external_metadata_unlink';
}

function effectivePhase(operation) {
  return operation.resumeStatus ?? operation.status;
}

function validatePhaseEvidence(operation) {
  const phase = effectivePhase(operation);
  const local = operation.managementMode === 'local';
  const expectedFinalRevision = operation.sourceRevision
    + (local && operation.sourceStatus === 'enabled' ? 1 : 0);
  const jobEvidenceReady = operation.finalRevision === expectedFinalRevision
    && (operation.sourceStatus === 'enabled'
      ? operation.disableJobId !== null
      : operation.disableJobId === null);
  if (local) {
    if (phase === 'pending') {
      if (EVIDENCE_FIELDS.some((field) => operation[field] !== null)) throw invalid('Pending local removal contains phase evidence');
      return;
    }
    if (phase === 'disabling') {
      if (operation.sourceStatus !== 'enabled' || operation.finalRevision !== null
        || operation.cleanupEvidenceDigest !== null || operation.dataDeleteJobId !== null
        || operation.backupId !== null) throw invalid('Local disable phase evidence is inconsistent');
      return;
    }
    if (!jobEvidenceReady) throw invalid('Local removal final revision evidence is inconsistent');
    if (phase === 'cleaning') {
      if (operation.cleanupEvidenceDigest !== null || operation.dataDeleteJobId !== null
        || operation.backupId !== null) throw invalid('Local cleanup phase evidence is inconsistent');
      return;
    }
    if (phase === 'deleting_data') {
      if (operation.cleanupEvidenceDigest === null || operation.backupId === null) {
        throw invalid('Local data deletion phase lacks cleanup or backup evidence');
      }
      return;
    }
    if (phase === 'finalizing' || phase === 'removed') {
      if (operation.cleanupEvidenceDigest === null || operation.dataDeleteJobId === null
        || operation.backupId === null) throw invalid('Local finalization evidence is incomplete');
      return;
    }
    throw invalid('Local removal phase is invalid');
  }
  if (!['pending', 'finalizing', 'removed'].includes(phase)
    || operation.disableJobId !== null || operation.dataDeleteJobId !== null
    || operation.backupId !== null) throw invalid('External removal contains local lifecycle evidence');
  if (phase === 'pending') {
    if (operation.finalRevision !== null || operation.cleanupEvidenceDigest !== null) {
      throw invalid('Pending external removal contains phase evidence');
    }
    return;
  }
  if (operation.finalRevision !== operation.sourceRevision
    || operation.cleanupEvidenceDigest === null) {
    throw invalid('External removal finalization evidence is incomplete');
  }
}

function safeResult(value, operation) {
  if (value === null) return null;
  const fields = new Set([
    'removed', 'mailDomainId', 'webDomainId', 'domainName', 'managementMode', 'removalMethod',
    'finalRevision', 'disableJobId', 'dataDeleteJobId', 'backupId', 'cleanupEvidenceDigest',
    'deletedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || value.removed !== true
    || value.mailDomainId !== operation.mailDomainId
    || value.webDomainId !== operation.webDomainId
    || value.domainName !== operation.domainName
    || value.managementMode !== operation.managementMode
    || value.removalMethod !== operation.removalMethod
    || value.finalRevision !== operation.finalRevision
    || value.disableJobId !== operation.disableJobId
    || value.dataDeleteJobId !== operation.dataDeleteJobId
    || value.backupId !== operation.backupId
    || value.cleanupEvidenceDigest !== operation.cleanupEvidenceDigest) {
    throw invalid('Mail Domain removal result evidence is invalid');
  }
  return Object.freeze({
    removed: true,
    mailDomainId: operation.mailDomainId,
    webDomainId: operation.webDomainId,
    domainName: operation.domainName,
    managementMode: operation.managementMode,
    removalMethod: operation.removalMethod,
    finalRevision: operation.finalRevision,
    disableJobId: operation.disableJobId,
    dataDeleteJobId: operation.dataDeleteJobId,
    backupId: operation.backupId,
    cleanupEvidenceDigest: operation.cleanupEvidenceDigest,
    deletedAt: timestamp(value.deletedAt, 'deletedAt'),
  });
}

function persistedOperation(value) {
  const fields = new Set([
    'id', 'parentOperationId', 'mailDomainId', 'webDomainId', 'domainName', 'managementMode',
    'sourceStatus', 'sourceRevision', 'sourceUpdatedAt', 'removalMethod', 'previewDigest',
    'confirmation', 'status', 'resumeStatus', ...EVIDENCE_FIELDS, 'result', 'error',
    'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || !['local', 'external'].includes(value.managementMode)
    || !STATUSES.has(value.status)
    || (value.resumeStatus !== null && !PHASES.has(value.resumeStatus))
    || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 1
    || typeof value.confirmation !== 'string' || value.confirmation.length < 1
    || value.confirmation.length > 1000) throw invalid('Mail Domain removal operation state is invalid');
  const validSourceStatus = value.managementMode === 'local'
    ? LOCAL_STATUSES.has(value.sourceStatus)
    : EXTERNAL_STATUSES.has(value.sourceStatus);
  if (!validSourceStatus || value.removalMethod !== expectedRemovalMethod(value.managementMode)) {
    throw invalid('Mail Domain removal source lifecycle is invalid');
  }
  const normalizedEvidence = evidence(Object.fromEntries(
    EVIDENCE_FIELDS.map((field) => [field, value[field]]),
  ));
  const operation = {
    id: safeId(value.id, 'operationId'),
    parentOperationId: safeId(value.parentOperationId, 'parentOperationId'),
    mailDomainId: safeId(value.mailDomainId, 'mailDomainId'),
    webDomainId: safeId(value.webDomainId, 'webDomainId'),
    domainName: canonicalDomainName(value.domainName),
    managementMode: value.managementMode,
    sourceStatus: value.sourceStatus,
    sourceRevision: value.sourceRevision,
    sourceUpdatedAt: timestamp(value.sourceUpdatedAt, 'sourceUpdatedAt'),
    removalMethod: value.removalMethod,
    previewDigest: safeDigest(value.previewDigest, 'previewDigest'),
    confirmation: value.confirmation,
    status: value.status,
    resumeStatus: value.resumeStatus,
    ...normalizedEvidence,
    result: null,
    error: safeError(value.error),
    createdAt: timestamp(value.createdAt, 'createdAt'),
    updatedAt: timestamp(value.updatedAt, 'updatedAt'),
  };
  if (Date.parse(operation.updatedAt) < Date.parse(operation.createdAt)
    || (['blocked', 'failed'].includes(operation.status)) !== (operation.resumeStatus !== null)
    || (['blocked', 'failed'].includes(operation.status)) !== (operation.error !== null)
    || (!['blocked', 'failed'].includes(operation.status) && operation.resumeStatus !== null)) {
    throw invalid('Mail Domain removal lifecycle metadata is inconsistent');
  }
  validatePhaseEvidence(operation);
  operation.result = safeResult(value.result, operation);
  if ((operation.status === 'removed') !== (operation.result !== null)
    || (operation.status === 'removed' && operation.resumeStatus !== null)) {
    throw invalid('Mail Domain removal completion evidence is inconsistent');
  }
  if (operation.result && Date.parse(operation.result.deletedAt) < Date.parse(operation.createdAt)) {
    throw invalid('Mail Domain removal completion timestamp is invalid');
  }
  return Object.freeze(operation);
}

function operationFromCapture(capture, now, idFactory) {
  if (!capture || capture.version !== 1 || capture.operation !== 'mail_domain_remove'
    || capture.readyToStart !== true || !Array.isArray(capture.blockers)
    || capture.blockers.length !== 0 || capture.sideEffects !== false
    || !capture.mailDomain || typeof capture.mailDomain !== 'object'
    || typeof capture.parentOperationId !== 'string'
    || typeof capture.previewDigest !== 'string'
    || typeof capture.confirmation !== 'string') {
    throw new MailDomainRemovalOperationRegistryError(
      'mail_domain_removal_operation_capture_invalid',
      'Mail Domain removal preview cannot be journaled',
      409,
    );
  }
  const createdAt = new Date(now()).toISOString();
  return persistedOperation({
    id: idFactory(),
    parentOperationId: capture.parentOperationId,
    mailDomainId: capture.mailDomain.id,
    webDomainId: capture.mailDomain.webDomainId,
    domainName: capture.mailDomain.domainName,
    managementMode: capture.mailDomain.managementMode,
    sourceStatus: capture.mailDomain.status,
    sourceRevision: capture.mailDomain.revision,
    sourceUpdatedAt: capture.mailDomain.updatedAt,
    removalMethod: capture.removalMethod,
    previewDigest: capture.previewDigest,
    confirmation: capture.confirmation,
    status: 'pending',
    resumeStatus: null,
    ...emptyEvidence(),
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function mailDomainRemovalOperationPublicView(operation) {
  if (!operation) return null;
  const retryable = operation.status !== 'removed';
  return Object.freeze({
    id: operation.id,
    parentOperationId: operation.parentOperationId,
    mailDomainId: operation.mailDomainId,
    webDomainId: operation.webDomainId,
    domainName: operation.domainName,
    managementMode: operation.managementMode,
    sourceStatus: operation.sourceStatus,
    sourceRevision: operation.sourceRevision,
    sourceUpdatedAt: operation.sourceUpdatedAt,
    removalMethod: operation.removalMethod,
    previewDigest: operation.previewDigest,
    status: operation.status,
    result: operation.result,
    error: operation.error,
    recovery: Object.freeze({
      required: retryable,
      automaticReplayBlocked: INTERRUPTED_STATUSES.has(operation.status),
      reason: INTERRUPTED_STATUSES.has(operation.status)
        ? `mail_domain_removal_interrupted_${operation.status}`
        : null,
      retryable,
      retryConfirmation: retryable
        ? `retry-mail-domain-remove:${operation.id}:${operation.updatedAt}:${operation.previewDigest}`
        : null,
    }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createMailDomainRemovalOperationRegistry({
  filePath = null,
  now = () => Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new MailDomainRemovalOperationRegistryError(
      'mail_domain_removal_operation_dependencies_invalid',
      'Mail Domain removal operation registry dependencies are invalid',
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
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.operations)
        || Object.keys(parsed).length !== 2
        || Object.keys(parsed).some((field) => !['version', 'operations'].includes(field))) {
        throw invalid('Mail Domain removal operation store is invalid');
      }
      const operations = parsed.operations.map(persistedOperation);
      if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
        throw invalid('Mail Domain removal operation IDs are not unique');
      }
      state = { version: STORE_VERSION, operations };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await persist();
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function create(capture) {
    await ensureInitialized();
    const candidate = operationFromCapture(capture, now, idFactory);
    const sameParent = state.operations.find((operation) => (
      operation.parentOperationId === candidate.parentOperationId
      && operation.mailDomainId === candidate.mailDomainId
    ));
    if (sameParent) {
      const sameIntent = [
        'webDomainId', 'domainName', 'managementMode', 'sourceStatus', 'sourceRevision',
        'sourceUpdatedAt', 'removalMethod', 'previewDigest', 'confirmation',
      ].every((field) => sameParent[field] === candidate[field]);
      if (!sameIntent) {
        throw new MailDomainRemovalOperationRegistryError(
          'mail_domain_removal_operation_intent_conflict',
          'Parent operation already owns a different Mail Domain removal intent',
          409,
        );
      }
      return sameParent;
    }
    const active = state.operations.find((operation) => (
      operation.mailDomainId === candidate.mailDomainId && operation.status !== 'removed'
    ));
    if (active) {
      throw new MailDomainRemovalOperationRegistryError(
        'mail_domain_removal_operation_active',
        'Mail Domain already has an active removal operation',
        409,
      );
    }
    state.operations.push(candidate);
    await persist();
    return candidate;
  }

  async function get(operationId) {
    await ensureInitialized();
    const id = safeId(operationId, 'operationId');
    return state.operations.find((operation) => operation.id === id) ?? null;
  }

  async function listForMailDomain(mailDomainId) {
    await ensureInitialized();
    const id = safeId(mailDomainId, 'mailDomainId');
    return Object.freeze(state.operations
      .filter((operation) => operation.mailDomainId === id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  async function listIncomplete() {
    await ensureInitialized();
    return Object.freeze(state.operations.filter((operation) => operation.status !== 'removed'));
  }

  async function mutate(operation, update) {
    const index = state.operations.findIndex((candidate) => candidate.id === operation.id);
    if (index < 0) {
      throw new MailDomainRemovalOperationRegistryError(
        'mail_domain_removal_operation_not_found',
        'Mail Domain removal operation was not found',
        404,
      );
    }
    const timestampMs = Math.max(now(), Date.parse(operation.updatedAt) + 1);
    const next = persistedOperation({
      ...operation,
      ...update,
      updatedAt: new Date(timestampMs).toISOString(),
    });
    state.operations[index] = next;
    await persist();
    return next;
  }

  async function requireCurrent(operationId, expectedUpdatedAt) {
    const current = await get(operationId);
    if (!current) {
      throw new MailDomainRemovalOperationRegistryError(
        'mail_domain_removal_operation_not_found',
        'Mail Domain removal operation was not found',
        404,
      );
    }
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new MailDomainRemovalOperationRegistryError(
        'mail_domain_removal_operation_stale',
        'Mail Domain removal operation changed before transition',
        409,
      );
    }
    return current;
  }

  function transitionAllowed(operation, target) {
    const transitions = operation.managementMode === 'local'
      ? operation.sourceStatus === 'enabled'
        ? {
          pending: ['disabling'],
          disabling: ['disabling', 'cleaning'],
          cleaning: ['deleting_data'],
          deleting_data: ['deleting_data', 'finalizing'],
          finalizing: ['finalizing'],
        }
        : {
          pending: ['cleaning'],
          cleaning: ['deleting_data'],
          deleting_data: ['deleting_data', 'finalizing'],
          finalizing: ['finalizing'],
        }
      : { pending: ['finalizing'], finalizing: ['finalizing'] };
    return transitions[operation.status]?.includes(target) === true;
  }

  async function advance(operationId, { expectedUpdatedAt, status, evidence: requestedEvidence } = {}) {
    const current = await requireCurrent(operationId, expectedUpdatedAt);
    if (!PHASES.has(status) || status === 'pending' || status === 'removed'
      || !transitionAllowed(current, status)) {
      throw new MailDomainRemovalOperationRegistryError(
        'mail_domain_removal_operation_transition_invalid',
        'Mail Domain removal phase transition is invalid',
        409,
      );
    }
    const normalizedEvidence = evidence(requestedEvidence);
    return mutate(current, {
      status,
      resumeStatus: null,
      ...normalizedEvidence,
      result: null,
      error: null,
    });
  }

  async function interrupt(operationId, expectedUpdatedAt, error, status) {
    const current = await requireCurrent(operationId, expectedUpdatedAt);
    if (!PHASES.has(current.status) || current.status === 'removed') {
      throw new MailDomainRemovalOperationRegistryError(
        'mail_domain_removal_operation_not_mutable',
        'Mail Domain removal operation cannot be interrupted from its current state',
        409,
      );
    }
    return mutate(current, {
      status,
      resumeStatus: current.status,
      result: null,
      error: safeError(error),
    });
  }

  const block = (operationId, { expectedUpdatedAt, error } = {}) => (
    interrupt(operationId, expectedUpdatedAt, error, 'blocked')
  );
  const fail = (operationId, { expectedUpdatedAt, error } = {}) => (
    interrupt(operationId, expectedUpdatedAt, error, 'failed')
  );

  async function retry(operationId, { expectedUpdatedAt } = {}) {
    const current = await requireCurrent(operationId, expectedUpdatedAt);
    if (!['blocked', 'failed'].includes(current.status) || !current.resumeStatus) {
      throw new MailDomainRemovalOperationRegistryError(
        'mail_domain_removal_operation_not_retryable',
        'Mail Domain removal operation does not require retry',
        409,
      );
    }
    return mutate(current, {
      status: current.resumeStatus,
      resumeStatus: null,
      result: null,
      error: null,
    });
  }

  async function succeed(operationId, { expectedUpdatedAt, deletedAt } = {}) {
    const current = await requireCurrent(operationId, expectedUpdatedAt);
    if (current.status === 'removed') return current;
    if (current.status !== 'finalizing') {
      throw new MailDomainRemovalOperationRegistryError(
        'mail_domain_removal_operation_not_finalizing',
        'Mail Domain removal operation is not finalizing',
        409,
      );
    }
    return mutate(current, {
      status: 'removed',
      resumeStatus: null,
      result: {
        removed: true,
        mailDomainId: current.mailDomainId,
        webDomainId: current.webDomainId,
        domainName: current.domainName,
        managementMode: current.managementMode,
        removalMethod: current.removalMethod,
        finalRevision: current.finalRevision,
        disableJobId: current.disableJobId,
        dataDeleteJobId: current.dataDeleteJobId,
        backupId: current.backupId,
        cleanupEvidenceDigest: current.cleanupEvidenceDigest,
        deletedAt: timestamp(deletedAt, 'deletedAt'),
      },
      error: null,
    });
  }

  return Object.freeze({
    init,
    create,
    get,
    listForMailDomain,
    listIncomplete,
    advance,
    block,
    fail,
    retry,
    succeed,
  });
}

export const mailDomainRemovalOperationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  statuses: Object.freeze([...STATUSES]),
  phases: Object.freeze([...PHASES]),
  persistedOperation,
  operationFromCapture,
  safeError,
  evidence,
  emptyEvidence,
  expectedRemovalMethod,
  validatePhaseEvidence,
});
