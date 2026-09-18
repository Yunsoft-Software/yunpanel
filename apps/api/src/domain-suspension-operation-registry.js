import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const STATUSES = new Set([
  'pending',
  'suspending',
  'suspended',
  'resuming',
  'resumed',
  'failed',
  'resume_failed',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class DomainSuspensionOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainSuspensionOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      `${field} is invalid`,
      409,
    );
  }
  return value;
}

function safeDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      `${field} is invalid`,
      409,
    );
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      'Domain suspension timestamp is invalid',
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
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      'Domain suspension failure evidence is invalid',
      409,
    );
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function suspendResult(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.suspended !== true || typeof value.hostChanged !== 'boolean'
    || typeof value.suspendedAt !== 'string') {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      'Domain suspension result evidence is invalid',
      409,
    );
  }
  return Object.freeze({
    suspended: true,
    hostChanged: value.hostChanged,
    suspendedAt: timestamp(value.suspendedAt),
  });
}

function resumeResult(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.resumed !== true || typeof value.hostChanged !== 'boolean'
    || typeof value.resumedAt !== 'string') {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      'Domain resume result evidence is invalid',
      409,
    );
  }
  return Object.freeze({
    resumed: true,
    hostChanged: value.hostChanged,
    resumedAt: timestamp(value.resumedAt),
  });
}

function persistedOperation(value) {
  const fields = new Set([
    'id', 'domainId', 'serverId', 'primaryDomain', 'domainRevision',
    'checksum', 'previewDigest', 'confirmation', 'status',
    'suspendResult', 'suspendError', 'resumeResult', 'resumeError',
    'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || !STATUSES.has(value.status)
    || typeof value.primaryDomain !== 'string' || value.primaryDomain.length < 1 || value.primaryDomain.length > 253
    || /[\u0000-\u001f\u007f]/.test(value.primaryDomain)
    || !Number.isSafeInteger(value.domainRevision) || value.domainRevision < 1
    || typeof value.confirmation !== 'string' || value.confirmation.length < 1 || value.confirmation.length > 1000) {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      'Domain suspension operation state is invalid',
      409,
    );
  }
  const operation = Object.freeze({
    id: safeId(value.id, 'operationId'),
    domainId: safeId(value.domainId, 'domainId'),
    serverId: safeId(value.serverId, 'serverId'),
    primaryDomain: value.primaryDomain,
    domainRevision: value.domainRevision,
    checksum: safeDigest(value.checksum, 'checksum'),
    previewDigest: safeDigest(value.previewDigest, 'previewDigest'),
    confirmation: value.confirmation,
    status: value.status,
    suspendResult: suspendResult(value.suspendResult),
    suspendError: safeError(value.suspendError),
    resumeResult: resumeResult(value.resumeResult),
    resumeError: safeError(value.resumeError),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });

  const suspendedPhase = ['suspended', 'resuming', 'resumed', 'resume_failed'].includes(operation.status);
  if (suspendedPhase !== (operation.suspendResult !== null)) {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      'Domain suspension result does not match lifecycle state',
      409,
    );
  }
  if ((operation.status === 'failed') !== (operation.suspendError !== null)) {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      'Domain suspension failure does not match lifecycle state',
      409,
    );
  }
  if ((operation.status === 'resumed') !== (operation.resumeResult !== null)) {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      'Domain resume result does not match lifecycle state',
      409,
    );
  }
  if ((operation.status === 'resume_failed') !== (operation.resumeError !== null)) {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_state_invalid',
      'Domain resume failure does not match lifecycle state',
      409,
    );
  }
  return operation;
}

function operationFromPreview(preview, now, idFactory) {
  if (!preview || preview.version !== 1 || preview.operation !== 'domain_suspend'
    || preview.readyToSuspend !== true || !Array.isArray(preview.blockers) || preview.blockers.length !== 0
    || !preview.domain || typeof preview.domain !== 'object' || Array.isArray(preview.domain)
    || typeof preview.domain.id !== 'string' || typeof preview.domain.serverId !== 'string'
    || typeof preview.domain.primaryDomain !== 'string'
    || !Number.isSafeInteger(preview.domain.desiredRevision) || preview.domain.desiredRevision < 1
    || preview.domain.stagedRevision !== preview.domain.desiredRevision
    || preview.domain.appliedRevision !== preview.domain.desiredRevision
    || typeof preview.domain.stagedChecksum !== 'string' || !SHA256_PATTERN.test(preview.domain.stagedChecksum)
    || typeof preview.previewDigest !== 'string' || !SHA256_PATTERN.test(preview.previewDigest)
    || typeof preview.confirmation !== 'string' || !preview.confirmation) {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_preview_invalid',
      'Domain suspension preview cannot be journaled',
      409,
    );
  }
  const createdAt = new Date(now()).toISOString();
  return persistedOperation({
    id: idFactory(),
    domainId: preview.domain.id,
    serverId: preview.domain.serverId,
    primaryDomain: preview.domain.primaryDomain,
    domainRevision: preview.domain.desiredRevision,
    checksum: preview.domain.stagedChecksum,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    status: 'pending',
    suspendResult: null,
    suspendError: null,
    resumeResult: null,
    resumeError: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function domainSuspensionOperationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    domainId: operation.domainId,
    serverId: operation.serverId,
    primaryDomain: operation.primaryDomain,
    domainRevision: operation.domainRevision,
    checksum: operation.checksum,
    previewDigest: operation.previewDigest,
    status: operation.status,
    suspendResult: operation.suspendResult,
    suspendError: operation.suspendError,
    resumeResult: operation.resumeResult,
    resumeError: operation.resumeError,
    recovery: Object.freeze({
      required: ['suspending', 'resuming'].includes(operation.status),
      phase: operation.status === 'suspending'
        ? 'suspend'
        : operation.status === 'resuming'
          ? 'resume'
          : null,
      automaticReplayBlocked: ['suspending', 'resuming'].includes(operation.status),
    }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createDomainSuspensionOperationRegistry({
  filePath = null,
  now = () => Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new DomainSuspensionOperationRegistryError(
      'domain_suspension_operation_dependencies_invalid',
      'Domain suspension operation registry dependencies are invalid',
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
          throw new DomainSuspensionOperationRegistryError(
            'domain_suspension_operation_state_invalid',
            'Domain suspension operation store is invalid',
            409,
          );
        }
        const operations = parsed.operations.map(persistedOperation);
        if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
          throw new DomainSuspensionOperationRegistryError(
            'domain_suspension_operation_state_invalid',
            'Domain suspension operation IDs are not unique',
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

  async function create(preview) {
    await ensureInitialized();
    const duplicate = state.operations.find((operation) => (
      operation.domainId === preview?.domain?.id
      && operation.domainRevision === preview?.domain?.desiredRevision
      && operation.checksum === preview?.domain?.stagedChecksum
      && operation.previewDigest === preview?.previewDigest
      && !['resumed'].includes(operation.status)
    ));
    if (duplicate) return duplicate;
    const operation = operationFromPreview(preview, now, idFactory);
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
    return Object.freeze(state.operations.filter((operation) => (
      operation.status === 'suspending' || operation.status === 'resuming'
    )));
  }

  async function mutate(operation, update) {
    const index = state.operations.findIndex((candidate) => candidate.id === operation.id);
    if (index < 0) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
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

  async function markSuspending(operationId) {
    const operation = await get(operationId);
    if (!operation) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    if (operation.status === 'suspending') return operation;
    if (!['pending', 'failed'].includes(operation.status)) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_suspendable',
        'Domain suspension operation cannot enter suspending state',
        409,
      );
    }
    return mutate(operation, {
      status: 'suspending',
      suspendResult: null,
      suspendError: null,
      resumeResult: null,
      resumeError: null,
    });
  }

  async function succeedSuspend(operationId, { hostChanged, suspendedAt } = {}) {
    const operation = await get(operationId);
    if (!operation) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    const result = suspendResult({ suspended: true, hostChanged, suspendedAt });
    if (operation.status === 'suspended') {
      if (JSON.stringify(operation.suspendResult) !== JSON.stringify(result)) {
        throw new DomainSuspensionOperationRegistryError(
          'domain_suspension_operation_result_conflict',
          'Domain suspension already completed with different evidence',
          409,
        );
      }
      return operation;
    }
    if (operation.status !== 'suspending') {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_suspending',
        'Domain suspension operation is not suspending',
        409,
      );
    }
    return mutate(operation, {
      status: 'suspended',
      suspendResult: result,
      suspendError: null,
      resumeResult: null,
      resumeError: null,
    });
  }

  async function failSuspend(operationId, error) {
    const operation = await get(operationId);
    if (!operation) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    if (operation.status === 'failed') return operation;
    if (!['pending', 'suspending'].includes(operation.status)) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_mutable',
        'Domain suspension operation cannot fail from current state',
        409,
      );
    }
    return mutate(operation, {
      status: 'failed',
      suspendResult: null,
      suspendError: safeError(error),
      resumeResult: null,
      resumeError: null,
    });
  }

  async function markResuming(operationId) {
    const operation = await get(operationId);
    if (!operation) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    if (operation.status === 'resuming') return operation;
    if (!['suspended', 'resume_failed'].includes(operation.status)) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_resumable',
        'Domain suspension operation cannot enter resuming state',
        409,
      );
    }
    return mutate(operation, {
      status: 'resuming',
      resumeResult: null,
      resumeError: null,
    });
  }

  async function succeedResume(operationId, { hostChanged, resumedAt } = {}) {
    const operation = await get(operationId);
    if (!operation) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    const result = resumeResult({ resumed: true, hostChanged, resumedAt });
    if (operation.status === 'resumed') {
      if (JSON.stringify(operation.resumeResult) !== JSON.stringify(result)) {
        throw new DomainSuspensionOperationRegistryError(
          'domain_resume_operation_result_conflict',
          'Domain resume already completed with different evidence',
          409,
        );
      }
      return operation;
    }
    if (operation.status !== 'resuming') {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_resuming',
        'Domain suspension operation is not resuming',
        409,
      );
    }
    return mutate(operation, {
      status: 'resumed',
      resumeResult: result,
      resumeError: null,
    });
  }

  async function failResume(operationId, error) {
    const operation = await get(operationId);
    if (!operation) {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    if (operation.status === 'resume_failed') return operation;
    if (operation.status !== 'resuming') {
      throw new DomainSuspensionOperationRegistryError(
        'domain_suspension_operation_not_resuming',
        'Domain suspension operation is not resuming',
        409,
      );
    }
    return mutate(operation, {
      status: 'resume_failed',
      resumeResult: null,
      resumeError: safeError(error),
    });
  }

  return Object.freeze({
    init,
    create,
    get,
    listForDomain,
    listInterrupted,
    markSuspending,
    succeedSuspend,
    failSuspend,
    markResuming,
    succeedResume,
    failResume,
  });
}

export const domainSuspensionOperationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  statuses: Object.freeze([...STATUSES]),
  persistedOperation,
  operationFromPreview,
  safeError,
  suspendResult,
  resumeResult,
});
