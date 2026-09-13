import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BackupExecutionStateError,
  normalizeBackupExecutionPlan,
} from './backup-execution-state.js';

const STORE_VERSION = 1;
const OPERATION_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed']);
const STEP_STATUSES = new Set(['pending', 'dispatched', 'succeeded', 'failed']);
const WORK_KINDS = new Set(['job', 'local']);
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;
const STORE_KEYS = new Set(['version', 'operations']);
const OPERATION_KEYS = new Set([
  'id', 'serverId', 'executionDigest', 'idempotencyKey', 'previewDigest', 'status', 'plan', 'steps',
  'createdAt', 'startedAt', 'finishedAt', 'error',
]);
const STEP_KEYS = new Set(['stepId', 'status', 'workRef', 'evidence', 'error', 'updatedAt']);
const WORK_REF_KEYS = new Set(['kind', 'id']);
const EVIDENCE_KEYS = new Set(['artifactId', 'contentSha256', 'bytes', 'createdAt']);
const ERROR_KEYS = new Set(['code', 'message']);

export class BackupOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message, code = 'backup_operation_state_invalid') {
  throw new BackupOperationRegistryError(code, message, 409);
}

function exactObject(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.size
    || Object.keys(value).some((key) => !keys.has(key))) invalid(message);
  return value;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(`${label} is invalid`);
  return value.toLowerCase();
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) invalid(`${label} is invalid`);
  return value;
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`${label} is invalid`);
  return new Date(value).toISOString();
}

function normalizeError(value, { nullable = true } = {}) {
  if (nullable && value === null) return null;
  exactObject(value, ERROR_KEYS, 'Backup operation error is invalid');
  if (typeof value.code !== 'string' || !ERROR_CODE_PATTERN.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 240
    || /[\u0000-\u001f\u007f]/.test(value.message)) invalid('Backup operation error is invalid');
  return Object.freeze({ code: value.code, message: value.message });
}

function normalizeWorkRef(value, { nullable = true } = {}) {
  if (nullable && value === null) return null;
  exactObject(value, WORK_REF_KEYS, 'Backup step work reference is invalid');
  if (!WORK_KINDS.has(value.kind)) invalid('Backup step work kind is invalid');
  return Object.freeze({ kind: value.kind, id: safeId(value.id, 'Backup step work id') });
}

function normalizeEvidence(value, { nullable = true } = {}) {
  if (nullable && value === null) return null;
  exactObject(value, EVIDENCE_KEYS, 'Backup step evidence is invalid');
  if (typeof value.contentSha256 !== 'string' || !SHA256_PATTERN.test(value.contentSha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0) invalid('Backup step evidence is invalid');
  return Object.freeze({
    artifactId: safeId(value.artifactId, 'Backup artifact id'),
    contentSha256: value.contentSha256,
    bytes: value.bytes,
    createdAt: timestamp(value.createdAt, 'Backup artifact timestamp'),
  });
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeStep(value, planStep) {
  exactObject(value, STEP_KEYS, 'Backup operation step state is invalid');
  if (value.stepId !== planStep.stepId || !STEP_STATUSES.has(value.status)) invalid('Backup operation step identity is invalid');
  const workRef = normalizeWorkRef(value.workRef);
  const evidence = normalizeEvidence(value.evidence);
  const error = normalizeError(value.error);
  const updatedAt = timestamp(value.updatedAt, 'Backup step update timestamp');
  if (value.status === 'pending' && (workRef || evidence || error)) invalid('Pending backup step contains execution state');
  if (value.status === 'dispatched' && (!workRef || evidence || error)) invalid('Dispatched backup step state is inconsistent');
  if (value.status === 'succeeded' && (!workRef || !evidence || error)) invalid('Succeeded backup step state is inconsistent');
  if (value.status === 'failed' && (!workRef || evidence || !error)) invalid('Failed backup step state is inconsistent');
  return Object.freeze({ stepId: value.stepId, status: value.status, workRef, evidence, error, updatedAt });
}

function normalizePlan(value) {
  try { return normalizeBackupExecutionPlan(value); }
  catch (error) {
    if (error instanceof BackupExecutionStateError) invalid('Backup execution plan state is invalid');
    throw error;
  }
}

function normalizeOperation(value) {
  exactObject(value, OPERATION_KEYS, 'Backup operation state is invalid');
  const plan = normalizePlan(value.plan);
  const id = uuid(value.id, 'Backup operation id');
  const serverId = uuid(value.serverId, 'Backup operation server id');
  if (serverId !== plan.serverId
    || value.executionDigest !== plan.executionDigest
    || value.idempotencyKey !== plan.idempotencyKey
    || value.previewDigest !== plan.previewDigest
    || !OPERATION_STATUSES.has(value.status)
    || !Array.isArray(value.steps) || value.steps.length !== plan.steps.length) {
    invalid('Backup operation metadata does not match its execution plan');
  }
  const steps = value.steps.map((step, index) => normalizeStep(step, plan.steps[index]));
  const createdAt = timestamp(value.createdAt, 'Backup operation creation timestamp');
  const startedAt = timestamp(value.startedAt, 'Backup operation start timestamp', { nullable: true });
  const finishedAt = timestamp(value.finishedAt, 'Backup operation finish timestamp', { nullable: true });
  const error = normalizeError(value.error);
  const succeeded = steps.filter((step) => step.status === 'succeeded').length;
  const failed = steps.filter((step) => step.status === 'failed').length;
  if (value.status === 'queued' && (startedAt || finishedAt || error || steps.some((step) => step.status !== 'pending'))) {
    invalid('Queued backup operation lifecycle is inconsistent');
  }
  if (value.status === 'running' && (!startedAt || finishedAt || error || failed > 0 || succeeded === steps.length)) {
    invalid('Running backup operation lifecycle is inconsistent');
  }
  if (value.status === 'succeeded' && (!startedAt || !finishedAt || error || succeeded !== steps.length)) {
    invalid('Succeeded backup operation lifecycle is inconsistent');
  }
  if (value.status === 'failed' && (!startedAt || !finishedAt || !error || failed < 1)) {
    invalid('Failed backup operation lifecycle is inconsistent');
  }
  return Object.freeze({
    id,
    serverId,
    executionDigest: plan.executionDigest,
    idempotencyKey: plan.idempotencyKey,
    previewDigest: plan.previewDigest,
    status: value.status,
    plan,
    steps: Object.freeze(steps),
    createdAt,
    startedAt,
    finishedAt,
    error,
  });
}

function normalizeStore(value) {
  exactObject(value, STORE_KEYS, 'Backup operation store is invalid');
  if (value.version !== STORE_VERSION || !Array.isArray(value.operations)) {
    throw new BackupOperationRegistryError('backup_operation_store_invalid', 'Backup operation store is invalid', 409);
  }
  let operations;
  try { operations = value.operations.map(normalizeOperation); }
  catch (error) {
    if (error instanceof BackupOperationRegistryError) {
      throw new BackupOperationRegistryError('backup_operation_store_invalid', 'Backup operation store contains invalid state', 409);
    }
    throw error;
  }
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length
    || new Set(operations.map((operation) => operation.idempotencyKey)).size !== operations.length) {
    throw new BackupOperationRegistryError('backup_operation_store_invalid', 'Backup operation store contains duplicate identities', 409);
  }
  return { version: STORE_VERSION, operations };
}

function publicOperation(operation) {
  return Object.freeze({
    ...operation,
    steps: Object.freeze(operation.steps.map((step) => Object.freeze({ ...step }))),
  });
}

export function createBackupOperationRegistry({ filePath = null, now = () => Date.now(), randomId = randomUUID } = {}) {
  if (filePath !== null && (typeof filePath !== 'string' || filePath.length < 1)) {
    throw new BackupOperationRegistryError('backup_operation_store_path_invalid', 'Backup operation store path is invalid');
  }
  if (typeof now !== 'function' || typeof randomId !== 'function') {
    throw new BackupOperationRegistryError('backup_operation_dependencies_invalid', 'Backup operation registry dependencies are invalid');
  }
  let state = { version: STORE_VERSION, operations: [] };
  let initialized = false;
  let mutationTail = Promise.resolve();

  async function persist(next) {
    if (filePath !== null) {
      const directory = path.dirname(filePath);
      const temporary = `${filePath}.${process.pid}.tmp`;
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
    }
    state = next;
  }

  async function init() {
    if (initialized) return;
    if (filePath !== null) {
      try { state = normalizeStore(JSON.parse(await readFile(filePath, 'utf8'))); }
      catch (error) {
        if (error?.code !== 'ENOENT') {
          if (error instanceof BackupOperationRegistryError) throw error;
          throw new BackupOperationRegistryError('backup_operation_store_invalid', 'Backup operation store could not be read', 409);
        }
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  function mutate(transform) {
    const task = mutationTail.catch(() => {}).then(async () => {
      await ensureInitialized();
      const { state: nextState, result } = await transform(state);
      if (nextState !== state) await persist(nextState);
      return result;
    });
    mutationTail = task;
    return task;
  }

  async function create(planValue) {
    const plan = normalizePlan(planValue);
    return mutate((current) => {
      const existing = current.operations.find((operation) => operation.idempotencyKey === plan.idempotencyKey) ?? null;
      if (existing) return { state: current, result: publicOperation(existing) };
      if (current.operations.some((operation) => operation.serverId === plan.serverId && ['queued', 'running'].includes(operation.status))) {
        throw new BackupOperationRegistryError('backup_operation_conflict', 'Another general backup is already active for this Server', 409);
      }
      const createdAt = new Date(now()).toISOString();
      const operation = normalizeOperation({
        id: randomId(),
        serverId: plan.serverId,
        executionDigest: plan.executionDigest,
        idempotencyKey: plan.idempotencyKey,
        previewDigest: plan.previewDigest,
        status: 'queued',
        plan,
        steps: plan.steps.map((step) => ({
          stepId: step.stepId,
          status: 'pending',
          workRef: null,
          evidence: null,
          error: null,
          updatedAt: createdAt,
        })),
        createdAt,
        startedAt: null,
        finishedAt: null,
        error: null,
      });
      return {
        state: { version: STORE_VERSION, operations: [...current.operations, operation] },
        result: publicOperation(operation),
      };
    });
  }

  async function start(operationId) {
    const id = uuid(operationId, 'Backup operation id');
    return mutate((current) => {
      const index = current.operations.findIndex((operation) => operation.id === id);
      if (index < 0) throw new BackupOperationRegistryError('backup_operation_not_found', 'Backup operation was not found', 404);
      const operation = current.operations[index];
      if (operation.status === 'running') return { state: current, result: publicOperation(operation) };
      if (operation.status !== 'queued') {
        throw new BackupOperationRegistryError('backup_operation_not_startable', 'Backup operation cannot be started from its current state', 409);
      }
      return replaceOperation(current, index, normalizeOperation({
        ...operation,
        status: 'running',
        startedAt: new Date(now()).toISOString(),
      }));
    });
  }

  function replaceOperation(current, index, operation) {
    const operations = [...current.operations];
    operations[index] = operation;
    return { state: { version: STORE_VERSION, operations }, result: publicOperation(operation) };
  }

  async function linkStep({ operationId, stepId, workRef } = {}) {
    const id = uuid(operationId, 'Backup operation id');
    const normalizedStepId = safeId(stepId, 'Backup step id');
    const normalizedWorkRef = normalizeWorkRef(workRef, { nullable: false });
    return mutate((current) => {
      const index = current.operations.findIndex((operation) => operation.id === id);
      if (index < 0) throw new BackupOperationRegistryError('backup_operation_not_found', 'Backup operation was not found', 404);
      const operation = current.operations[index];
      if (operation.status !== 'running') throw new BackupOperationRegistryError('backup_operation_not_running', 'Backup operation is not running', 409);
      const stepIndex = operation.steps.findIndex((step) => step.stepId === normalizedStepId);
      if (stepIndex < 0) throw new BackupOperationRegistryError('backup_step_not_found', 'Backup operation step was not found', 404);
      const step = operation.steps[stepIndex];
      if (step.status === 'dispatched' && same(step.workRef, normalizedWorkRef)) {
        return { state: current, result: publicOperation(operation) };
      }
      if (step.status !== 'pending') {
        throw new BackupOperationRegistryError('backup_step_already_dispatched', 'Backup step already has durable execution state', 409);
      }
      const steps = [...operation.steps];
      steps[stepIndex] = normalizeStep({
        ...step,
        status: 'dispatched',
        workRef: normalizedWorkRef,
        updatedAt: new Date(now()).toISOString(),
      }, operation.plan.steps[stepIndex]);
      return replaceOperation(current, index, normalizeOperation({ ...operation, steps }));
    });
  }

  async function succeedStep({ operationId, stepId, workRef, evidence } = {}) {
    const id = uuid(operationId, 'Backup operation id');
    const normalizedStepId = safeId(stepId, 'Backup step id');
    const normalizedWorkRef = normalizeWorkRef(workRef, { nullable: false });
    const normalizedEvidence = normalizeEvidence(evidence, { nullable: false });
    return mutate((current) => {
      const index = current.operations.findIndex((operation) => operation.id === id);
      if (index < 0) throw new BackupOperationRegistryError('backup_operation_not_found', 'Backup operation was not found', 404);
      const operation = current.operations[index];
      const stepIndex = operation.steps.findIndex((step) => step.stepId === normalizedStepId);
      if (stepIndex < 0) throw new BackupOperationRegistryError('backup_step_not_found', 'Backup operation step was not found', 404);
      const step = operation.steps[stepIndex];
      if (step.status === 'succeeded') {
        if (same(step.workRef, normalizedWorkRef) && same(step.evidence, normalizedEvidence)) {
          return { state: current, result: publicOperation(operation) };
        }
        throw new BackupOperationRegistryError('backup_step_completion_conflict', 'Backup step already completed with different evidence', 409);
      }
      if (operation.status !== 'running' || step.status !== 'dispatched' || !same(step.workRef, normalizedWorkRef)) {
        throw new BackupOperationRegistryError('backup_step_completion_conflict', 'Backup step completion does not match dispatched work', 409);
      }
      const completedAt = new Date(now()).toISOString();
      const steps = [...operation.steps];
      steps[stepIndex] = normalizeStep({
        ...step,
        status: 'succeeded',
        evidence: normalizedEvidence,
        updatedAt: completedAt,
      }, operation.plan.steps[stepIndex]);
      const allSucceeded = steps.every((candidate) => candidate.status === 'succeeded');
      return replaceOperation(current, index, normalizeOperation({
        ...operation,
        status: allSucceeded ? 'succeeded' : 'running',
        steps,
        finishedAt: allSucceeded ? completedAt : null,
      }));
    });
  }

  async function failStep({ operationId, stepId, workRef, error } = {}) {
    const id = uuid(operationId, 'Backup operation id');
    const normalizedStepId = safeId(stepId, 'Backup step id');
    const normalizedWorkRef = normalizeWorkRef(workRef, { nullable: false });
    const normalizedError = normalizeError(error, { nullable: false });
    return mutate((current) => {
      const index = current.operations.findIndex((operation) => operation.id === id);
      if (index < 0) throw new BackupOperationRegistryError('backup_operation_not_found', 'Backup operation was not found', 404);
      const operation = current.operations[index];
      const stepIndex = operation.steps.findIndex((step) => step.stepId === normalizedStepId);
      if (stepIndex < 0) throw new BackupOperationRegistryError('backup_step_not_found', 'Backup operation step was not found', 404);
      const step = operation.steps[stepIndex];
      if (step.status === 'failed') {
        if (same(step.workRef, normalizedWorkRef) && same(step.error, normalizedError)) {
          return { state: current, result: publicOperation(operation) };
        }
        throw new BackupOperationRegistryError('backup_step_completion_conflict', 'Backup step already failed with different evidence', 409);
      }
      if (operation.status !== 'running' || step.status !== 'dispatched' || !same(step.workRef, normalizedWorkRef)) {
        throw new BackupOperationRegistryError('backup_step_completion_conflict', 'Backup step failure does not match dispatched work', 409);
      }
      const finishedAt = new Date(now()).toISOString();
      const steps = [...operation.steps];
      steps[stepIndex] = normalizeStep({
        ...step,
        status: 'failed',
        error: normalizedError,
        updatedAt: finishedAt,
      }, operation.plan.steps[stepIndex]);
      return replaceOperation(current, index, normalizeOperation({
        ...operation,
        status: 'failed',
        steps,
        finishedAt,
        error: normalizedError,
      }));
    });
  }

  async function getOperation(operationId) {
    await ensureInitialized();
    const id = uuid(operationId, 'Backup operation id');
    const operation = state.operations.find((candidate) => candidate.id === id);
    return operation ? publicOperation(operation) : null;
  }

  async function listOperations({ serverId = null, status = null } = {}) {
    await ensureInitialized();
    const scopedServerId = serverId === null ? null : uuid(serverId, 'Server id');
    if (status !== null && !OPERATION_STATUSES.has(status)) {
      throw new BackupOperationRegistryError('backup_operation_status_invalid', 'Backup operation status filter is invalid');
    }
    return state.operations
      .filter((operation) => scopedServerId === null || operation.serverId === scopedServerId)
      .filter((operation) => status === null || operation.status === status)
      .map(publicOperation);
  }

  return Object.freeze({ init, create, start, linkStep, succeedStep, failStep, getOperation, listOperations });
}

export const backupOperationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  operationStatuses: Object.freeze([...OPERATION_STATUSES]),
  stepStatuses: Object.freeze([...STEP_STATUSES]),
  normalizeEvidence,
  normalizeOperation,
  normalizeStore,
});
