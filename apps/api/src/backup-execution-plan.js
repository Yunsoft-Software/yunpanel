import { createHash } from 'node:crypto';

const EXECUTION_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const RESOURCE_TYPES = new Set(['application', 'database', 'docker_storage', 'mail_data']);
const EXECUTOR_KINDS = Object.freeze({
  application: 'application_snapshot',
  database: 'database_backup',
  docker_storage: 'docker_storage_backup',
  mail_data: 'mail_data_backup',
});
const MAX_STEPS = 8192;

export class BackupExecutionPlanError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupExecutionPlanError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value, code = 'backup_execution_digest_invalid') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new BackupExecutionPlanError(code, 'Backup execution digest is invalid');
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BackupExecutionPlanError('backup_execution_resource_invalid', `${label} is invalid`, 409);
  }
  return value.toLowerCase();
}

function resourceIdentity(value) {
  if (typeof value !== 'string' || !RESOURCE_ID_PATTERN.test(value)) {
    throw new BackupExecutionPlanError('backup_execution_resource_invalid', 'Backup resource identity is invalid', 409);
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeStorage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.kind !== 'string'
    || !['named_volume', 'bind'].includes(value.kind)
    || typeof value.source !== 'string' || value.source.length < 1 || value.source.length > 4096
    || typeof value.sourceScope !== 'string' || !['project', 'host'].includes(value.sourceScope)
    || typeof value.target !== 'string' || !value.target.startsWith('/') || value.target.length > 4096
    || typeof value.readOnly !== 'boolean') {
    throw new BackupExecutionPlanError('backup_execution_resource_invalid', 'Docker storage execution source is invalid', 409);
  }
  if (value.kind === 'named_volume' && value.sourceScope !== 'project') {
    throw new BackupExecutionPlanError('backup_execution_resource_invalid', 'Docker named-volume execution scope is invalid', 409);
  }
  if (value.kind === 'bind' && value.sourceScope !== 'project') {
    throw new BackupExecutionPlanError('backup_execution_resource_not_selectable', 'Arbitrary host bind cannot be executed by general backup', 409);
  }
  return Object.freeze({
    kind: value.kind,
    source: value.source,
    sourceScope: value.sourceScope,
    target: value.target,
    readOnly: value.readOnly,
  });
}

function applicationInput(resource) {
  const snapshot = resource.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || !Number.isSafeInteger(snapshot.desiredRevision) || snapshot.desiredRevision < 1
    || !Number.isSafeInteger(snapshot.appliedRevision) || snapshot.appliedRevision < 0
    || !snapshot.environment || typeof snapshot.environment !== 'object' || Array.isArray(snapshot.environment)) {
    throw new BackupExecutionPlanError('backup_execution_resource_invalid', 'Application execution snapshot is invalid', 409);
  }
  return Object.freeze({
    applicationId: uuid(resource.applicationId, 'applicationId'),
    applicationType: resource.applicationType,
    desiredRevision: snapshot.desiredRevision,
    appliedRevision: snapshot.appliedRevision,
    currentReleaseId: snapshot.currentReleaseId,
    currentCommitSha: snapshot.currentCommitSha,
    environment: Object.freeze({
      savedRevision: snapshot.environment.savedRevision,
      appliedRevision: snapshot.environment.appliedRevision,
      appliedReleaseId: snapshot.environment.appliedReleaseId,
    }),
  });
}

function databaseInput(resource) {
  const snapshot = resource.snapshot;
  if (typeof resource.databaseName !== 'string' || resource.databaseName.length < 1 || resource.databaseName.length > 64
    || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || !['mariadb', 'mysql'].includes(snapshot.engine)
    || typeof snapshot.databaseVersion !== 'string' || snapshot.databaseVersion.length < 1 || snapshot.databaseVersion.length > 120
    || !Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 0) {
    throw new BackupExecutionPlanError('backup_execution_resource_invalid', 'Database execution snapshot is invalid', 409);
  }
  return Object.freeze({
    databaseName: resource.databaseName,
    engine: snapshot.engine,
    databaseVersion: snapshot.databaseVersion,
    sizeBytes: snapshot.sizeBytes,
    inventoryJobId: uuid(snapshot.inventoryJobId, 'database inventory job id'),
    inventoryRefreshedAt: snapshot.inventoryRefreshedAt,
  });
}

function dockerInput(resource) {
  if (!Number.isSafeInteger(resource.projectRevision) || resource.projectRevision < 1
    || typeof resource.serviceName !== 'string' || resource.serviceName.length < 1 || resource.serviceName.length > 63) {
    throw new BackupExecutionPlanError('backup_execution_resource_invalid', 'Docker storage execution snapshot is invalid', 409);
  }
  return Object.freeze({
    projectId: uuid(resource.projectId, 'docker project id'),
    projectRevision: resource.projectRevision,
    serviceName: resource.serviceName,
    storage: normalizeStorage(resource.storage),
  });
}

function mailInput(resource) {
  const snapshot = resource.snapshot;
  if (resource.scope !== 'domain'
    || resource.resourceId !== resource.mailDomainId
    || typeof resource.sourceIdentity !== 'string' || resource.sourceIdentity.length < 1 || resource.sourceIdentity.length > 320
    || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
    || typeof snapshot.snapshotSha256 !== 'string' || !SHA256_PATTERN.test(snapshot.snapshotSha256)
    || snapshot.sourcePresent !== true
    || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 0) {
    throw new BackupExecutionPlanError('backup_execution_resource_invalid', 'Mail data execution snapshot is invalid', 409);
  }
  const mailDomainId = uuid(resource.mailDomainId, 'mailDomainId');
  return Object.freeze({
    mailDomainId,
    scope: 'domain',
    resourceId: mailDomainId,
    identity: resource.sourceIdentity,
    expectedRevision: snapshot.revision,
    expectedSnapshotSha256: snapshot.snapshotSha256,
    bytes: snapshot.bytes,
  });
}

function executionInput(resource) {
  if (resource.type === 'application') return applicationInput(resource);
  if (resource.type === 'database') return databaseInput(resource);
  if (resource.type === 'docker_storage') return dockerInput(resource);
  if (resource.type === 'mail_data') return mailInput(resource);
  throw new BackupExecutionPlanError('backup_execution_resource_invalid', 'Backup execution resource type is invalid', 409);
}

function normalizeCurrentPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || plan.version !== 1 || plan.sideEffects !== false
    || typeof plan.serverId !== 'string' || !UUID_PATTERN.test(plan.serverId)
    || typeof plan.previewDigest !== 'string' || !SHA256_PATTERN.test(plan.previewDigest)
    || typeof plan.confirmation !== 'string'
    || !Array.isArray(plan.resources) || !Array.isArray(plan.selectedResourceIdentities)
    || plan.resources.length > MAX_STEPS || plan.selectedResourceIdentities.length > MAX_STEPS) {
    throw new BackupExecutionPlanError('backup_execution_plan_invalid', 'Current backup preview is invalid', 409);
  }
  const resources = [...plan.resources].sort((left, right) => String(left?.identity).localeCompare(String(right?.identity)));
  const selected = [...plan.selectedResourceIdentities].sort();
  if (new Set(resources.map((resource) => resource?.identity)).size !== resources.length
    || new Set(selected).size !== selected.length) {
    throw new BackupExecutionPlanError('backup_execution_plan_invalid', 'Current backup preview contains duplicate identities', 409);
  }
  return Object.freeze({
    serverId: plan.serverId.toLowerCase(),
    previewDigest: plan.previewDigest,
    confirmation: plan.confirmation,
    selectionMode: plan.selectionMode,
    resources,
    selected,
  });
}

export function createBackupExecutionPlan({
  plan,
  expectedPreviewDigest,
  confirmation,
} = {}) {
  const current = normalizeCurrentPlan(plan);
  const requestedDigest = sha256(expectedPreviewDigest, 'backup_execution_preview_digest_invalid');
  if (current.previewDigest !== requestedDigest) {
    throw new BackupExecutionPlanError('backup_execution_preview_stale', 'Backup preview is stale', 409);
  }
  const expectedConfirmation = `backup:${current.serverId}:${current.previewDigest}`;
  if (current.confirmation !== expectedConfirmation || confirmation !== expectedConfirmation) {
    throw new BackupExecutionPlanError('backup_execution_confirmation_invalid', 'Backup confirmation is invalid', 409);
  }

  const selected = new Set(current.selected);
  const resourcesByIdentity = new Map(current.resources.map((resource) => [resource.identity, resource]));
  const steps = [];
  for (const identity of current.selected) {
    const resource = resourcesByIdentity.get(identity);
    if (!resource
      || typeof resource.type !== 'string' || !RESOURCE_TYPES.has(resource.type)
      || resource.serverId !== current.serverId
      || resource.policy?.disposition !== 'include') {
      throw new BackupExecutionPlanError('backup_execution_resource_not_selectable', 'Backup resource is no longer selectable', 409);
    }
    const normalizedIdentity = resourceIdentity(resource.identity);
    const input = executionInput(resource);
    const stepCore = Object.freeze({
      resourceIdentity: normalizedIdentity,
      resourceType: resource.type,
      executorKind: EXECUTOR_KINDS[resource.type],
      input,
    });
    const stepDigest = digest({
      version: EXECUTION_VERSION,
      serverId: current.serverId,
      previewDigest: current.previewDigest,
      ...stepCore,
    });
    steps.push(Object.freeze({
      stepId: `backup-step:${stepDigest}`,
      stepDigest,
      ...stepCore,
    }));
  }
  if (steps.length === 0 || steps.length !== selected.size) {
    throw new BackupExecutionPlanError('backup_execution_empty', 'Backup execution does not contain work', 409);
  }

  const executionIdentity = Object.freeze({
    version: EXECUTION_VERSION,
    serverId: current.serverId,
    previewDigest: current.previewDigest,
    selectionMode: current.selectionMode,
    steps: Object.freeze(steps),
  });
  const executionDigest = digest(executionIdentity);
  return Object.freeze({
    ...executionIdentity,
    executionDigest,
    idempotencyKey: `general-backup:${executionDigest}`,
    sideEffects: true,
  });
}

export const backupExecutionPlanInternals = Object.freeze({
  executionVersion: EXECUTION_VERSION,
  maxSteps: MAX_STEPS,
  executorKinds: EXECUTOR_KINDS,
  digest,
  executionInput,
  normalizeCurrentPlan,
});
