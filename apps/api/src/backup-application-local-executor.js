import path from 'node:path';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const STATIC_RELEASE_ROOT = '/var/www/yunpanel/apps';
const NODE_RELEASE_ROOT = '/var/lib/yunpanel/apps';

export class BackupApplicationLocalExecutorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupApplicationLocalExecutorError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new BackupApplicationLocalExecutorError(code, message, status);
}

function normalizeStep(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.executorKind !== 'application_snapshot'
    || value.resourceType !== 'application'
    || typeof value.stepDigest !== 'string' || !SHA256_PATTERN.test(value.stepDigest)
    || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) {
    fail('backup_application_step_invalid', 'Application backup step is invalid');
  }
  const input = value.input;
  if (typeof input.applicationId !== 'string' || !UUID_PATTERN.test(input.applicationId)
    || !['static', 'node'].includes(input.applicationType)
    || !Number.isSafeInteger(input.desiredRevision) || input.desiredRevision < 1
    || !Number.isSafeInteger(input.appliedRevision) || input.appliedRevision < 0
    || (input.currentReleaseId !== null && (typeof input.currentReleaseId !== 'string' || !UUID_PATTERN.test(input.currentReleaseId)))
    || (input.currentCommitSha !== null && (typeof input.currentCommitSha !== 'string' || !COMMIT_PATTERN.test(input.currentCommitSha)))
    || !input.environment || typeof input.environment !== 'object' || Array.isArray(input.environment)
    || !Number.isSafeInteger(input.environment.savedRevision) || input.environment.savedRevision < 0
    || (input.environment.appliedRevision !== null
      && (!Number.isSafeInteger(input.environment.appliedRevision) || input.environment.appliedRevision < 0))
    || (input.environment.appliedReleaseId !== null
      && (typeof input.environment.appliedReleaseId !== 'string' || !UUID_PATTERN.test(input.environment.appliedReleaseId)))
    || (input.environment.appliedRevision === null) !== (input.environment.appliedReleaseId === null)) {
    fail('backup_application_step_invalid', 'Application backup step snapshot is invalid');
  }
  return value;
}

function workRef(step) {
  return Object.freeze({ kind: 'local', id: `application-backup:${step.stepDigest}` });
}

function sameSnapshot(application, environment, serverId, step) {
  const input = step.input;
  return application?.id === input.applicationId
    && application.serverId === serverId
    && application.type === input.applicationType
    && application.desiredRevision === input.desiredRevision
    && application.appliedRevision === input.appliedRevision
    && (application.currentReleaseId ?? null) === input.currentReleaseId
    && (application.currentCommitSha ?? null) === input.currentCommitSha
    && application.activeDeploymentId === null
    && environment?.applicationId === input.applicationId
    && environment.savedRevision === input.environment.savedRevision
    && environment.appliedRevision === input.environment.appliedRevision
    && environment.appliedReleaseId === input.environment.appliedReleaseId;
}

function sortedEnvironment(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    fail('backup_application_environment_invalid', 'Application environment materialization is invalid', 503);
  }
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
}

function controlDocument(serverId, application, step) {
  const input = step.input;
  const control = {
    version: 1,
    serverId,
    applicationId: input.applicationId,
    name: application.name,
    type: input.applicationType,
    repositoryUrl: application.repositoryUrl,
    branch: application.branch,
    retention: application.retention,
    desiredRevision: input.desiredRevision,
    appliedRevision: input.appliedRevision,
    currentReleaseId: input.currentReleaseId,
    previousReleaseId: application.previousReleaseId ?? null,
    currentCommitSha: input.currentCommitSha,
    currentGitTarget: application.currentGitTarget ?? null,
    build: input.applicationType === 'static' ? application.build ?? null : null,
    runtime: input.applicationType === 'node' ? application.runtime ?? null : null,
    activeRuntime: input.applicationType === 'node' ? application.activeRuntime ?? null : null,
    environment: {
      savedRevision: input.environment.savedRevision,
      appliedRevision: input.environment.appliedRevision,
      appliedReleaseId: input.environment.appliedReleaseId,
    },
  };
  return `${JSON.stringify(control, null, 2)}\n`;
}

function releaseEntry(step) {
  if (step.input.currentReleaseId === null) return [];
  const applicationRoot = step.input.applicationType === 'static' ? STATIC_RELEASE_ROOT : NODE_RELEASE_ROOT;
  return [{
    directory: path.join(applicationRoot, step.input.applicationId, 'releases'),
    name: step.input.currentReleaseId,
  }];
}

export function createBackupApplicationLocalExecutor({
  applicationRegistry,
  applicationEnvironmentRegistry,
  localBackupArtifactManager,
} = {}) {
  if (!applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !applicationEnvironmentRegistry
    || typeof applicationEnvironmentRegistry.environmentStatus !== 'function'
    || typeof applicationEnvironmentRegistry.materialize !== 'function'
    || !localBackupArtifactManager || typeof localBackupArtifactManager.archive !== 'function') {
    throw new BackupApplicationLocalExecutorError(
      'backup_application_dependencies_invalid',
      'Application backup executor dependencies are unavailable',
      503,
    );
  }

  async function sourceState(serverId, stepValue) {
    const step = normalizeStep(stepValue);
    let application;
    let environment;
    try {
      application = await applicationRegistry.getApplication(step.input.applicationId);
      if (!application) fail('backup_application_not_found', 'Application backup source was not found', 404);
      environment = await applicationEnvironmentRegistry.environmentStatus(step.input.applicationId, {
        currentReleaseId: application.currentReleaseId ?? null,
      });
    } catch (error) {
      if (error instanceof BackupApplicationLocalExecutorError) throw error;
      fail('backup_application_state_unavailable', 'Application backup source state could not be verified', 503);
    }
    if (!sameSnapshot(application, environment, serverId, step)) {
      fail('backup_application_preview_stale', 'Application backup source changed after preview', 409);
    }
    return Object.freeze({ step, application, environment });
  }

  async function prepare(serverId, stepValue) {
    const { step } = await sourceState(serverId, stepValue);
    return Object.freeze({ workRef: workRef(step) });
  }

  async function executePrepared(serverId, stepValue, requestedWorkRef) {
    const { step, application } = await sourceState(serverId, stepValue);
    const expectedWorkRef = workRef(step);
    if (!requestedWorkRef || requestedWorkRef.kind !== expectedWorkRef.kind || requestedWorkRef.id !== expectedWorkRef.id) {
      fail('backup_application_dispatch_intent_invalid', 'Application backup dispatch intent does not match the execution step', 409);
    }

    let environmentValues;
    try {
      environmentValues = await applicationEnvironmentRegistry.materialize(step.input.applicationId, {
        expectedRevision: step.input.environment.savedRevision,
      });
    } catch (error) {
      if (error?.status === 409) throw error;
      fail('backup_application_environment_unavailable', 'Application environment could not be materialized for backup', 503);
    }
    const environment = sortedEnvironment(environmentValues);
    const inlineFiles = [
      { name: 'control.json', content: controlDocument(serverId, application, step) },
      { name: 'environment.json', content: `${JSON.stringify(environment, null, 2)}\n` },
    ];
    let evidence;
    try {
      evidence = await localBackupArtifactManager.archive({
        artifactId: step.stepDigest,
        sourceDigest: step.stepDigest,
        entries: releaseEntry(step),
        inlineFiles,
      });
    } catch (error) {
      if (error?.code && String(error.code).startsWith('backup_artifact_')) throw error;
      fail('backup_application_archive_failed', 'Application backup artifact could not be created', 503);
    }
    return Object.freeze({ evidence });
  }

  return Object.freeze({ prepare, executePrepared });
}

export const backupApplicationLocalExecutorInternals = Object.freeze({
  staticReleaseRoot: STATIC_RELEASE_ROOT,
  nodeReleaseRoot: NODE_RELEASE_ROOT,
  normalizeStep,
  workRef,
  sameSnapshot,
  sortedEnvironment,
  controlDocument,
  releaseEntry,
});
