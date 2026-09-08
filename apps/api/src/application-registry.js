import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ApplicationValidationError,
  normalizeGithubRepositoryUrl,
  normalizeGitBranch,
  normalizeStaticBuildConfig,
} from '@yunpanel/shared';

const STORE_VERSION = 1;

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
    if (error instanceof ApplicationValidationError) {
      throw new ApplicationRegistryError(error.code, error.message);
    }
    throw error;
  }
}

function publicApplication(application) {
  return { ...application };
}

function requireApplication(state, applicationId) {
  const application = state.applications.find((candidate) => candidate.id === applicationId);
  if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
  return application;
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
      activeDeploymentId: null,
      lastDeploymentId: null,
      lastDeployedAt: null,
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
    const application = requireApplication(state, applicationId);
    if (application.activeDeploymentId) {
      throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active deployment', 409);
    }
    if (typeof deploymentId !== 'string' || !deploymentId) throw new ApplicationRegistryError('invalid_deployment_id', 'deploymentId is required');

    application.state = 'deploying';
    application.activeDeploymentId = deploymentId;
    application.lastDeploymentId = deploymentId;
    application.lastError = null;
    application.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicApplication(application);
  }

  async function markDeployed(applicationId, { deploymentId, releaseId, commitSha }) {
    await ensureInitialized();
    const application = requireApplication(state, applicationId);
    if (application.activeDeploymentId !== deploymentId) {
      throw new ApplicationRegistryError('deployment_mismatch', 'Deployment result does not match active application deployment', 409);
    }
    if (releaseId !== deploymentId) {
      throw new ApplicationRegistryError('release_mismatch', 'Static release must match deployment identity', 409);
    }
    if (typeof commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(commitSha)) {
      throw new ApplicationRegistryError('invalid_commit_sha', 'Deployment commit SHA is invalid');
    }

    const timestamp = new Date(now()).toISOString();
    application.previousReleaseId = application.currentReleaseId;
    application.currentReleaseId = releaseId;
    application.currentCommitSha = commitSha.toLowerCase();
    application.activeDeploymentId = null;
    application.state = 'active';
    application.lastDeployedAt = timestamp;
    application.lastError = null;
    application.updatedAt = timestamp;
    await persist();
    return publicApplication(application);
  }

  async function markFailed(applicationId, deploymentId, errorCode) {
    await ensureInitialized();
    const application = requireApplication(state, applicationId);
    if (application.activeDeploymentId && application.activeDeploymentId !== deploymentId) return publicApplication(application);

    application.activeDeploymentId = null;
    application.state = application.currentReleaseId ? 'active' : 'error';
    application.lastError = typeof errorCode === 'string' ? errorCode.slice(0, 120) : 'deployment_failed';
    application.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicApplication(application);
  }

  async function getApplication(applicationId) {
    await ensureInitialized();
    const application = state.applications.find((candidate) => candidate.id === applicationId);
    return application ? publicApplication(application) : null;
  }

  async function listApplications() {
    await ensureInitialized();
    return state.applications.map(publicApplication);
  }

  return {
    init,
    createApplication,
    markDeploying,
    markDeployed,
    markFailed,
    getApplication,
    listApplications,
  };
}
