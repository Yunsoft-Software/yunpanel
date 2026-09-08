import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ApplicationValidationError,
  assertUuid,
  normalizeGithubRepositoryUrl,
  normalizeGitBranch,
  normalizeStaticBuildConfig,
} from '@yunpanel/shared';

const STORE_VERSION = 1;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

export class ApplicationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApplicationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return { version: STORE_VERSION, applications: [] };
}

function validateName(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApplicationRegistryError('invalid_application_name', 'Application name must be a printable string up to 80 characters');
  }
  return value.trim();
}

function normalizeConfig({ repositoryUrl, branch, build, retention }) {
  try {
    return {
      repositoryUrl: normalizeGithubRepositoryUrl(repositoryUrl),
      branch: normalizeGitBranch(branch ?? 'main'),
      build: normalizeStaticBuildConfig(build),
      retention: Number.isInteger(retention) && retention >= 2 && retention <= 20 ? retention : 5,
    };
  } catch (error) {
    if (error instanceof ApplicationValidationError) throw new ApplicationRegistryError(error.code, error.message);
    throw error;
  }
}

function publicApplication(application) {
  return {
    ...application,
    releases: Array.isArray(application.releases) ? application.releases.map((release) => ({ ...release })) : [],
  };
}

function requireApplication(state, applicationId) {
  const application = state.applications.find((candidate) => candidate.id === applicationId);
  if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
  return application;
}

function normalizeUuid(value, fieldName) {
  try {
    return assertUuid(value, fieldName);
  } catch {
    throw new ApplicationRegistryError('invalid_release_id', `${fieldName} is invalid`);
  }
}

function hydrateApplication(application) {
  if (!Array.isArray(application.releases)) application.releases = [];
  if (application.pendingRollbackReleaseId === undefined) application.pendingRollbackReleaseId = null;
  if (application.lastRolledBackAt === undefined) application.lastRolledBackAt = null;

  if (
    application.currentReleaseId
    && application.currentCommitSha
    && COMMIT_PATTERN.test(application.currentCommitSha)
    && !application.releases.some((release) => release.releaseId === application.currentReleaseId)
  ) {
    application.releases.push({
      releaseId: application.currentReleaseId,
      deploymentId: application.currentReleaseId,
      commitSha: application.currentCommitSha.toLowerCase(),
      artifactFiles: null,
      artifactBytes: null,
      deployedAt: application.lastDeployedAt ?? application.updatedAt ?? application.createdAt,
    });
  }
  return application;
}

function trimReleaseHistory(application) {
  const protectedIds = new Set([application.currentReleaseId, application.previousReleaseId].filter(Boolean));
  const retained = [];

  for (const release of application.releases) {
    if (protectedIds.has(release.releaseId) && !retained.some((entry) => entry.releaseId === release.releaseId)) {
      retained.push(release);
    }
  }
  for (const release of application.releases) {
    if (retained.length >= application.retention) break;
    if (!retained.some((entry) => entry.releaseId === release.releaseId)) retained.push(release);
  }

  application.releases = retained.slice(0, application.retention);
}

export function createApplicationRegistry({
  filePath = null,
  now = () => Date.now(),
  serverExists = async () => true,
} = {}) {
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.applications)) {
          throw new Error('unsupported or invalid application registry state');
        }
        state = parsed;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    state.applications.forEach(hydrateApplication);
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function createApplication({ serverId, name, repositoryUrl, branch = 'main', build = {}, retention = 5 }) {
    await ensureInitialized();
    if (typeof serverId !== 'string' || !serverId) throw new ApplicationRegistryError('invalid_server', 'serverId is required');
    if (!(await serverExists(serverId))) throw new ApplicationRegistryError('server_not_found', 'Target server does not exist', 404);

    const config = normalizeConfig({ repositoryUrl, branch, build, retention });
    const id = randomUUID();
    const timestamp = new Date(now()).toISOString();
    const application = {
      id,
      serverId,
      name: validateName(name),
      type: 'static',
      repositoryUrl: config.repositoryUrl,
      branch: config.branch,
      build: config.build,
      retention: config.retention,
      webRoot: `/var/www/yunpanel/apps/${id}/current`,
      state: 'draft',
      desiredRevision: 1,
      currentReleaseId: null,
      previousReleaseId: null,
      currentCommitSha: null,
      releases: [],
      activeDeploymentId: null,
      pendingRollbackReleaseId: null,
      lastDeploymentId: null,
      lastDeployedAt: null,
      lastRolledBackAt: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    state.applications.push(application);
    await persist();
    return publicApplication(application);
  }

  async function markDeploying(applicationId, deploymentId) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, applicationId));
    if (application.activeDeploymentId) throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);
    const normalizedDeploymentId = normalizeUuid(deploymentId, 'deploymentId');

    application.state = 'deploying';
    application.activeDeploymentId = normalizedDeploymentId;
    application.pendingRollbackReleaseId = null;
    application.lastDeploymentId = normalizedDeploymentId;
    application.lastError = null;
    application.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicApplication(application);
  }

  async function markDeployed(applicationId, {
    deploymentId,
    releaseId,
    commitSha,
    artifactFiles = null,
    artifactBytes = null,
  }) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, applicationId));
    const normalizedDeploymentId = normalizeUuid(deploymentId, 'deploymentId');
    const normalizedReleaseId = normalizeUuid(releaseId, 'releaseId');

    if (application.activeDeploymentId !== normalizedDeploymentId) throw new ApplicationRegistryError('deployment_mismatch', 'Deployment result does not match active application deployment', 409);
    if (normalizedReleaseId !== normalizedDeploymentId) throw new ApplicationRegistryError('release_mismatch', 'Static release must match deployment identity', 409);
    if (typeof commitSha !== 'string' || !COMMIT_PATTERN.test(commitSha)) throw new ApplicationRegistryError('invalid_commit_sha', 'Deployment commit SHA is invalid');
    if (artifactFiles != null && (!Number.isInteger(artifactFiles) || artifactFiles < 1 || artifactFiles > 100_000)) throw new ApplicationRegistryError('invalid_artifact_metadata', 'Artifact file count is invalid');
    if (artifactBytes != null && (!Number.isInteger(artifactBytes) || artifactBytes < 0 || artifactBytes > 2 * 1024 * 1024 * 1024)) throw new ApplicationRegistryError('invalid_artifact_metadata', 'Artifact byte size is invalid');

    const timestamp = new Date(now()).toISOString();
    application.previousReleaseId = application.currentReleaseId;
    application.currentReleaseId = normalizedReleaseId;
    application.currentCommitSha = commitSha.toLowerCase();
    application.activeDeploymentId = null;
    application.pendingRollbackReleaseId = null;
    application.state = 'active';
    application.lastDeployedAt = timestamp;
    application.lastError = null;
    application.updatedAt = timestamp;

    application.releases = application.releases.filter((release) => release.releaseId !== normalizedReleaseId);
    application.releases.unshift({
      releaseId: normalizedReleaseId,
      deploymentId: normalizedDeploymentId,
      commitSha: commitSha.toLowerCase(),
      artifactFiles,
      artifactBytes,
      deployedAt: timestamp,
    });
    trimReleaseHistory(application);

    await persist();
    return publicApplication(application);
  }

  async function markRollingBack(applicationId, operationId, releaseId) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, applicationId));
    if (application.activeDeploymentId) throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);
    if (!application.currentReleaseId) throw new ApplicationRegistryError('application_not_deployed', 'Application has no active release to roll back', 409);

    const normalizedOperationId = normalizeUuid(operationId, 'operationId');
    const normalizedReleaseId = normalizeUuid(releaseId, 'releaseId');
    if (normalizedReleaseId === application.currentReleaseId) throw new ApplicationRegistryError('rollback_target_current', 'Requested rollback release is already active', 409);
    if (!application.releases.some((release) => release.releaseId === normalizedReleaseId)) throw new ApplicationRegistryError('rollback_release_unknown', 'Rollback release is not in retained application history', 409);

    application.state = 'rolling_back';
    application.activeDeploymentId = normalizedOperationId;
    application.pendingRollbackReleaseId = normalizedReleaseId;
    application.lastError = null;
    application.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicApplication(application);
  }

  async function markRolledBack(applicationId, { operationId, releaseId }) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, applicationId));
    const normalizedOperationId = normalizeUuid(operationId, 'operationId');
    const normalizedReleaseId = normalizeUuid(releaseId, 'releaseId');

    if (application.activeDeploymentId !== normalizedOperationId || application.pendingRollbackReleaseId !== normalizedReleaseId) {
      throw new ApplicationRegistryError('rollback_mismatch', 'Rollback result does not match active application rollback', 409);
    }

    const target = application.releases.find((release) => release.releaseId === normalizedReleaseId);
    if (!target) throw new ApplicationRegistryError('rollback_release_unknown', 'Rollback release is not in retained application history', 409);

    const timestamp = new Date(now()).toISOString();
    application.previousReleaseId = application.currentReleaseId;
    application.currentReleaseId = normalizedReleaseId;
    application.currentCommitSha = target.commitSha;
    application.activeDeploymentId = null;
    application.pendingRollbackReleaseId = null;
    application.state = 'active';
    application.lastRolledBackAt = timestamp;
    application.lastError = null;
    application.updatedAt = timestamp;
    trimReleaseHistory(application);
    await persist();
    return publicApplication(application);
  }

  async function markFailed(applicationId, operationId, errorCode) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, applicationId));
    if (application.activeDeploymentId && application.activeDeploymentId !== operationId) return publicApplication(application);

    application.activeDeploymentId = null;
    application.pendingRollbackReleaseId = null;
    application.state = application.currentReleaseId ? 'active' : 'error';
    application.lastError = typeof errorCode === 'string' ? errorCode.slice(0, 120) : 'deployment_failed';
    application.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicApplication(application);
  }

  async function getApplication(applicationId) {
    await ensureInitialized();
    const application = state.applications.find((candidate) => candidate.id === applicationId);
    return application ? publicApplication(hydrateApplication(application)) : null;
  }

  async function listApplications() {
    await ensureInitialized();
    return state.applications.map((application) => publicApplication(hydrateApplication(application)));
  }

  return {
    init,
    createApplication,
    markDeploying,
    markDeployed,
    markRollingBack,
    markRolledBack,
    markFailed,
    getApplication,
    listApplications,
  };
}
