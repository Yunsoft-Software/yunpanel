import { createHash } from 'node:crypto';

const EXECUTION_VERSION = 1;
const MAX_STEPS = 8192;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const EXECUTOR_KINDS = Object.freeze({
  application: 'application_snapshot',
  database: 'database_backup',
  docker_storage: 'docker_storage_backup',
  mail_data: 'mail_data_backup',
});
const PLAN_KEYS = new Set([
  'version', 'serverId', 'previewDigest', 'selectionMode', 'steps', 'executionDigest', 'idempotencyKey', 'sideEffects',
]);
const STEP_KEYS = new Set(['stepId', 'stepDigest', 'resourceIdentity', 'resourceType', 'executorKind', 'input']);
const APPLICATION_INPUT_KEYS = new Set([
  'applicationId', 'applicationType', 'desiredRevision', 'appliedRevision', 'currentReleaseId', 'currentCommitSha', 'environment',
]);
const ENVIRONMENT_KEYS = new Set(['savedRevision', 'appliedRevision', 'appliedReleaseId']);
const DATABASE_INPUT_KEYS = new Set([
  'databaseName', 'engine', 'databaseVersion', 'sizeBytes', 'inventoryJobId', 'inventoryRefreshedAt',
]);
const DOCKER_INPUT_KEYS = new Set(['projectId', 'projectRevision', 'serviceName', 'storage']);
const STORAGE_KEYS = new Set(['kind', 'source', 'sourceScope', 'target', 'readOnly']);
const MAIL_INPUT_KEYS = new Set([
  'mailDomainId', 'scope', 'resourceId', 'identity', 'expectedRevision', 'expectedSnapshotSha256', 'bytes',
]);

export class BackupExecutionStateError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'BackupExecutionStateError';
    this.code = code;
    this.status = status;
  }
}

function exactObject(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.size
    || Object.keys(value).some((key) => !keys.has(key))) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', message);
  }
  return value;
}

function uuid(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', `${label} is invalid`);
  }
  return value.toLowerCase();
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', `${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', `${label} is invalid`);
  }
  return new Date(value).toISOString();
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeEnvironment(value) {
  exactObject(value, ENVIRONMENT_KEYS, 'Application environment execution state is invalid');
  if (!Number.isSafeInteger(value.savedRevision) || value.savedRevision < 0
    || (value.appliedRevision !== null && (!Number.isSafeInteger(value.appliedRevision)
      || value.appliedRevision < 0 || value.appliedRevision > value.savedRevision))) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Application environment revisions are invalid');
  }
  const appliedReleaseId = uuid(value.appliedReleaseId, 'Application environment release', { nullable: true });
  if ((value.appliedRevision === null) !== (appliedReleaseId === null)) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Application environment applied state is incomplete');
  }
  return Object.freeze({
    savedRevision: value.savedRevision,
    appliedRevision: value.appliedRevision,
    appliedReleaseId,
  });
}

function normalizeApplicationInput(value) {
  exactObject(value, APPLICATION_INPUT_KEYS, 'Application backup execution input is invalid');
  if (!['static', 'node'].includes(value.applicationType)
    || !Number.isSafeInteger(value.desiredRevision) || value.desiredRevision < 1
    || !Number.isSafeInteger(value.appliedRevision) || value.appliedRevision < 0
    || value.appliedRevision > value.desiredRevision) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Application backup revisions are invalid');
  }
  const currentReleaseId = uuid(value.currentReleaseId, 'Application release', { nullable: true });
  if (value.currentCommitSha !== null
    && (typeof value.currentCommitSha !== 'string' || !COMMIT_PATTERN.test(value.currentCommitSha))) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Application commit is invalid');
  }
  const currentCommitSha = value.currentCommitSha === null ? null : value.currentCommitSha.toLowerCase();
  if ((currentReleaseId === null) !== (currentCommitSha === null)
    || (currentReleaseId === null && value.appliedRevision !== 0)
    || (value.applicationType === 'node' && currentReleaseId !== null && value.appliedRevision < 1)) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Application release state is invalid');
  }
  return Object.freeze({
    applicationId: uuid(value.applicationId, 'Application id'),
    applicationType: value.applicationType,
    desiredRevision: value.desiredRevision,
    appliedRevision: value.appliedRevision,
    currentReleaseId,
    currentCommitSha,
    environment: normalizeEnvironment(value.environment),
  });
}

function normalizeDatabaseInput(value) {
  exactObject(value, DATABASE_INPUT_KEYS, 'Database backup execution input is invalid');
  if (typeof value.databaseName !== 'string' || !DATABASE_NAME_PATTERN.test(value.databaseName)
    || !['mariadb', 'mysql'].includes(value.engine)
    || typeof value.databaseVersion !== 'string' || value.databaseVersion.length < 1 || value.databaseVersion.length > 120
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Database backup execution metadata is invalid');
  }
  return Object.freeze({
    databaseName: value.databaseName,
    engine: value.engine,
    databaseVersion: value.databaseVersion,
    sizeBytes: value.sizeBytes,
    inventoryJobId: uuid(value.inventoryJobId, 'Database inventory job'),
    inventoryRefreshedAt: timestamp(value.inventoryRefreshedAt, 'Database inventory timestamp'),
  });
}

function normalizeStorage(value) {
  exactObject(value, STORAGE_KEYS, 'Docker storage execution input is invalid');
  if (!['named_volume', 'bind'].includes(value.kind)
    || typeof value.source !== 'string' || value.source.length < 1 || value.source.length > 4096
    || value.sourceScope !== 'project'
    || typeof value.target !== 'string' || !value.target.startsWith('/') || value.target.length > 4096
    || typeof value.readOnly !== 'boolean') {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Docker storage execution source is invalid');
  }
  return Object.freeze({ ...value });
}

function normalizeDockerInput(value) {
  exactObject(value, DOCKER_INPUT_KEYS, 'Docker backup execution input is invalid');
  if (!Number.isSafeInteger(value.projectRevision) || value.projectRevision < 1
    || typeof value.serviceName !== 'string' || !SERVICE_NAME_PATTERN.test(value.serviceName)) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Docker backup execution metadata is invalid');
  }
  return Object.freeze({
    projectId: uuid(value.projectId, 'Docker project id'),
    projectRevision: value.projectRevision,
    serviceName: value.serviceName,
    storage: normalizeStorage(value.storage),
  });
}

function normalizeMailInput(value) {
  exactObject(value, MAIL_INPUT_KEYS, 'Mail backup execution input is invalid');
  const mailDomainId = uuid(value.mailDomainId, 'Mail Domain id');
  const resourceId = uuid(value.resourceId, 'Mail resource id');
  if (value.scope !== 'domain' || resourceId !== mailDomainId
    || typeof value.identity !== 'string' || value.identity.length < 1 || value.identity.length > 320
    || value.identity !== value.identity.trim() || /[\u0000-\u001f\u007f]/.test(value.identity)
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Mail backup execution metadata is invalid');
  }
  return Object.freeze({
    mailDomainId,
    scope: 'domain',
    resourceId,
    identity: value.identity,
    expectedRevision: value.expectedRevision,
    expectedSnapshotSha256: sha256(value.expectedSnapshotSha256, 'Mail snapshot digest'),
    bytes: value.bytes,
  });
}

function normalizeInput(resourceType, value) {
  if (resourceType === 'application') return normalizeApplicationInput(value);
  if (resourceType === 'database') return normalizeDatabaseInput(value);
  if (resourceType === 'docker_storage') return normalizeDockerInput(value);
  if (resourceType === 'mail_data') return normalizeMailInput(value);
  throw new BackupExecutionStateError('backup_execution_state_invalid', 'Backup execution resource type is invalid');
}

function normalizeStep(value, { serverId, previewDigest } = {}) {
  exactObject(value, STEP_KEYS, 'Backup execution step is invalid');
  if (typeof value.resourceIdentity !== 'string' || !RESOURCE_ID_PATTERN.test(value.resourceIdentity)
    || !Object.hasOwn(EXECUTOR_KINDS, value.resourceType)
    || value.executorKind !== EXECUTOR_KINDS[value.resourceType]) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Backup execution step identity is invalid');
  }
  const input = normalizeInput(value.resourceType, value.input);
  const core = Object.freeze({
    resourceIdentity: value.resourceIdentity,
    resourceType: value.resourceType,
    executorKind: value.executorKind,
    input,
  });
  const expectedDigest = digest({ version: EXECUTION_VERSION, serverId, previewDigest, ...core });
  if (value.stepDigest !== expectedDigest || value.stepId !== `backup-step:${expectedDigest}`) {
    throw new BackupExecutionStateError('backup_execution_state_tampered', 'Backup execution step digest does not match persisted work');
  }
  return Object.freeze({ stepId: value.stepId, stepDigest: expectedDigest, ...core });
}

export function normalizeBackupExecutionPlan(value) {
  exactObject(value, PLAN_KEYS, 'Backup execution plan is invalid');
  if (value.version !== EXECUTION_VERSION || value.sideEffects !== true
    || !['all_managed', 'explicit'].includes(value.selectionMode)
    || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_STEPS) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Backup execution plan metadata is invalid');
  }
  const serverId = uuid(value.serverId, 'Server id');
  const previewDigest = sha256(value.previewDigest, 'Preview digest');
  const steps = value.steps.map((step) => normalizeStep(step, { serverId, previewDigest }));
  if (new Set(steps.map((step) => step.stepId)).size !== steps.length
    || new Set(steps.map((step) => step.resourceIdentity)).size !== steps.length
    || steps.some((step, index) => index > 0 && step.resourceIdentity.localeCompare(steps[index - 1].resourceIdentity) <= 0)) {
    throw new BackupExecutionStateError('backup_execution_state_invalid', 'Backup execution steps are duplicated or unordered');
  }
  const identity = Object.freeze({
    version: EXECUTION_VERSION,
    serverId,
    previewDigest,
    selectionMode: value.selectionMode,
    steps: Object.freeze(steps),
  });
  const executionDigest = digest(identity);
  if (value.executionDigest !== executionDigest || value.idempotencyKey !== `general-backup:${executionDigest}`) {
    throw new BackupExecutionStateError('backup_execution_state_tampered', 'Backup execution digest does not match persisted work');
  }
  return Object.freeze({
    ...identity,
    executionDigest,
    idempotencyKey: `general-backup:${executionDigest}`,
    sideEffects: true,
  });
}

export const backupExecutionStateInternals = Object.freeze({
  executionVersion: EXECUTION_VERSION,
  maxSteps: MAX_STEPS,
  executorKinds: EXECUTOR_KINDS,
  digest,
  normalizeStep,
});
