import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ApplicationValidationError,
  assertUuid,
  normalizeGithubRepositoryUrl,
  normalizeGitBranch,
  normalizeGitDeploymentTarget,
  normalizeNodeRuntimeConfig,
  normalizePythonRuntimeConfig,
  normalizeStaticBuildConfig,
} from '@yunpanel/shared';
import {
  pythonServiceName,
  pythonSocketPath,
} from '@yunpanel/config-templates';

const STORE_VERSION = 1;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const NODE_SERVICE_PATTERN = /^yunpanel-node-[a-f0-9]{16}\.service$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NODE_RUNTIME_ADAPTERS = new Set(['direct-systemd', 'passenger']);

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

function normalizeRetention(value) {
  return Number.isInteger(value) && value >= 2 && value <= 20 ? value : 5;
}

function normalizeRuntimeAdapter(value = 'passenger') {
  if (!NODE_RUNTIME_ADAPTERS.has(value)) {
    throw new ApplicationRegistryError('invalid_node_runtime_adapter', 'Node runtime adapter must be direct-systemd or passenger');
  }
  return value;
}

function normalizeStaticConfig({ repositoryUrl, branch, build, retention }) {
  try {
    return {
      repositoryUrl: normalizeGithubRepositoryUrl(repositoryUrl),
      branch: normalizeGitBranch(branch ?? 'main'),
      build: normalizeStaticBuildConfig(build),
      retention: normalizeRetention(retention),
    };
  } catch (error) {
    if (error instanceof ApplicationValidationError) throw new ApplicationRegistryError(error.code, error.message);
    throw error;
  }
}

function normalizeNodeConfig({ repositoryUrl, branch, runtime, retention, runtimeAdapter }) {
  const inferredAdapter = runtimeAdapter ?? (runtime?.port !== undefined && runtime?.port !== null ? 'direct-systemd' : 'passenger');
  const adapter = normalizeRuntimeAdapter(inferredAdapter);
  try {
    return {
      repositoryUrl: normalizeGithubRepositoryUrl(repositoryUrl),
      branch: normalizeGitBranch(branch ?? 'main'),
      runtime: normalizeNodeRuntimeConfig(runtime, { requirePort: adapter === 'direct-systemd' }),
      retention: normalizeRetention(retention),
      runtimeAdapter: adapter,
    };
  } catch (error) {
    if (error instanceof ApplicationValidationError) throw new ApplicationRegistryError(error.code, error.message);
    throw error;
  }
}

function normalizePythonConfig({ repositoryUrl, branch, runtime, retention }) {
  try {
    return {
      repositoryUrl: normalizeGithubRepositoryUrl(repositoryUrl),
      branch: normalizeGitBranch(branch ?? 'main'),
      runtime: normalizePythonRuntimeConfig(runtime),
      retention: normalizeRetention(retention),
    };
  } catch (error) {
    if (error instanceof ApplicationValidationError) throw new ApplicationRegistryError(error.code, error.message);
    throw error;
  }
}

function expectedNodeServiceName(applicationId) {
  const digest = createHash('sha256').update(applicationId).digest('hex').slice(0, 16);
  return `yunpanel-node-${digest}.service`;
}

function publicApplication(application) {
  const runtime = application.runtime ? structuredClone(application.runtime) : null;
  const activeRuntime = application.activeRuntime ? structuredClone(application.activeRuntime) : null;
  return Object.freeze({
    ...application,
    build: application.build ? Object.freeze({ ...application.build }) : null,
    runtime: runtime ? Object.freeze(runtime) : null,
    activeRuntime: activeRuntime ? Object.freeze(activeRuntime) : null,
    currentGitTarget: application.currentGitTarget ? Object.freeze({ ...application.currentGitTarget }) : null,
    configurationPending: (application.type === 'node' || application.type === 'python')
      && application.currentReleaseId !== null
      && !sameValue(runtime, activeRuntime),
    releases: Object.freeze(Array.isArray(application.releases)
      ? application.releases.map((release) => Object.freeze({
          ...release,
          gitTarget: release.gitTarget ? Object.freeze({ ...release.gitTarget }) : null,
          runtime: release.runtime ? Object.freeze(structuredClone(release.runtime)) : null,
        }))
      : []),
  });
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

function normalizeNullableUuid(value, fieldName) {
  return value == null ? null : normalizeUuid(value, fieldName);
}

function normalizeApplicationId(value) {
  try { return assertUuid(value, 'applicationId'); }
  catch { throw new ApplicationRegistryError('invalid_application_id', 'applicationId is invalid'); }
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function existingApplication(state, application, { idempotent }) {
  const existing = state.applications.find((candidate) => candidate.id === application.id) ?? null;
  if (!existing) return null;
  if (!idempotent) throw new ApplicationRegistryError('application_identity_conflict', 'Application identity already exists', 409);
  const fields = ['serverId', 'name', 'type', 'repositoryUrl', 'branch', 'retention', 'build', 'runtime', 'runtimeAdapter', 'webRoot'];
  if (fields.some((field) => !sameValue(existing[field] ?? null, application[field] ?? null))) {
    throw new ApplicationRegistryError('application_identity_conflict', 'Application identity conflicts with existing state', 409);
  }
  return publicApplication(hydrateApplication(existing));
}

function hydrateApplication(application) {
  if (!application.type) application.type = 'static';
  if (!['static', 'node', 'php', 'python'].includes(application.type)) {
    throw new ApplicationRegistryError('application_state_invalid', 'Application type is not supported by the current registry', 409);
  }
  if (application.type === 'node') {
    application.runtimeAdapter = normalizeRuntimeAdapter(
      application.runtimeAdapter ?? (application.runtime?.port ? 'direct-systemd' : 'passenger')
    );
  }
  else application.runtimeAdapter = null;
  if (!Array.isArray(application.releases)) application.releases = [];
  if (application.pendingRollbackReleaseId === undefined) application.pendingRollbackReleaseId = null;
  if (application.lastRolledBackAt === undefined) application.lastRolledBackAt = null;
  if (application.serviceName === undefined) application.serviceName = null;
  if (application.servicePort === undefined) {
    application.servicePort = application.runtimeAdapter === 'direct-systemd' ? application.runtime?.port ?? null : null;
  }
  if (application.healthPath === undefined) application.healthPath = application.runtime?.healthPath ?? null;
  if (application.proxyTarget === undefined) {
    application.proxyTarget = application.type === 'node' && application.runtimeAdapter === 'direct-systemd' && application.runtime?.port
      ? { host: '127.0.0.1', port: application.runtime.port }
      : null;
  }
  if (application.type === 'node' && application.runtimeAdapter === 'passenger'
    && (application.serviceName !== null || application.servicePort !== null || application.proxyTarget !== null)) {
    throw new ApplicationRegistryError('application_state_invalid', 'Passenger Node application must not persist systemd or localhost proxy state', 409);
  }
  if (application.type === 'php'
    && (application.repositoryUrl !== null || application.branch !== null || application.build !== null || application.runtime !== null
      || application.runtimeAdapter !== null || application.serviceName !== null || application.servicePort !== null
      || application.healthPath !== null || application.proxyTarget !== null)) {
    throw new ApplicationRegistryError('application_state_invalid', 'PHP application state contains unsupported runtime or deployment fields', 409);
  }
  if (application.type === 'php' && application.webRoot !== `/var/lib/yunpanel/apps/${application.id}/current/public`) {
    throw new ApplicationRegistryError('application_state_invalid', 'PHP application web root is outside the canonical current release', 409);
  }
  if (!Number.isSafeInteger(application.desiredRevision) || application.desiredRevision < 1) application.desiredRevision = 1;
  if (application.type === 'node') {
    const nodeConfig = normalizeNodeConfig({
      repositoryUrl: application.repositoryUrl,
      branch: application.branch,
      runtime: application.runtime,
      retention: application.retention,
      runtimeAdapter: application.runtimeAdapter,
    });
    application.runtime = nodeConfig.runtime;
    if (application.activeRuntime === undefined) {
      application.activeRuntime = application.currentReleaseId ? structuredClone(application.runtime) : null;
    } else if (application.activeRuntime !== null) {
      application.activeRuntime = normalizeNodeRuntimeConfig(application.activeRuntime, {
        requirePort: application.runtimeAdapter === 'direct-systemd',
      });
    }
    if (application.appliedRevision === undefined) {
      application.appliedRevision = application.currentReleaseId ? application.desiredRevision : 0;
    }
    if (!Number.isSafeInteger(application.appliedRevision) || application.appliedRevision < 0
      || (application.currentReleaseId === null && application.appliedRevision !== 0)
      || (application.currentReleaseId !== null && (application.activeRuntime === null || application.appliedRevision < 1))) {
      throw new ApplicationRegistryError('application_state_invalid', 'Node application configuration state is invalid', 409);
    }
    application.releases = application.releases.map((release) => {
      let rawRuntime = release.runtime ?? application.activeRuntime ?? application.runtime;
      if (application.runtimeAdapter === 'passenger' && rawRuntime?.port !== undefined && rawRuntime?.port !== null) {
        const { port: _p, ...withoutPort } = rawRuntime;
        rawRuntime = withoutPort;
      }
      return {
        ...release,
        runtime: normalizeNodeRuntimeConfig(rawRuntime, {
          requirePort: application.runtimeAdapter === 'direct-systemd',
        }),
        configurationRevision: Number.isSafeInteger(release.configurationRevision) && release.configurationRevision >= 1
          ? release.configurationRevision
          : application.appliedRevision || 1,
      };
    });
  } else if (application.type === 'python') {
    const pythonConfig = normalizePythonConfig({
      repositoryUrl: application.repositoryUrl,
      branch: application.branch,
      runtime: application.runtime,
      retention: application.retention,
    });
    application.runtime = pythonConfig.runtime;
    application.serviceName = pythonServiceName(application.id);
    application.socketPath = pythonSocketPath(application.id);
    application.servicePort = application.runtime?.port ?? null;
    application.healthPath = application.runtime?.healthPath ?? '/';
    application.proxyTarget = application.runtime?.port
      ? { host: '127.0.0.1', port: application.runtime.port }
      : null;
    if (application.activeRuntime === undefined) {
      application.activeRuntime = application.currentReleaseId ? structuredClone(application.runtime) : null;
    } else if (application.activeRuntime !== null) {
      application.activeRuntime = normalizePythonRuntimeConfig(application.activeRuntime);
    }
    if (application.appliedRevision === undefined) {
      application.appliedRevision = application.currentReleaseId ? application.desiredRevision : 0;
    }
    if (!Number.isSafeInteger(application.appliedRevision) || application.appliedRevision < 0
      || (application.currentReleaseId === null && application.appliedRevision !== 0)
      || (application.currentReleaseId !== null && (application.activeRuntime === null || application.appliedRevision < 1))) {
      throw new ApplicationRegistryError('application_state_invalid', 'Python application configuration state is invalid', 409);
    }
    application.releases = application.releases.map((release) => ({
      ...release,
      runtime: normalizePythonRuntimeConfig(release.runtime ?? application.activeRuntime ?? application.runtime),
      configurationRevision: Number.isSafeInteger(release.configurationRevision) && release.configurationRevision >= 1
        ? release.configurationRevision
        : application.appliedRevision || 1,
    }));
  } else {
    application.activeRuntime = null;
    if (application.appliedRevision === undefined) application.appliedRevision = application.currentReleaseId ? application.desiredRevision : 0;
    application.releases = application.releases.map((release) => ({ ...release, runtime: null, configurationRevision: null }));
  }

  if (application.type !== 'php') {
    try {
      application.releases = application.releases.map((release) => ({
        ...release,
        gitTarget: normalizeGitDeploymentTarget(release.gitTarget, { defaultBranch: application.branch }),
      }));
      if (application.currentGitTarget === undefined) {
        application.currentGitTarget = application.currentReleaseId
          ? application.releases.find((release) => release.releaseId === application.currentReleaseId)?.gitTarget
            ?? normalizeGitDeploymentTarget(null, { defaultBranch: application.branch })
          : null;
      } else if (application.currentGitTarget !== null) {
        application.currentGitTarget = normalizeGitDeploymentTarget(application.currentGitTarget);
      }
    } catch {
      throw new ApplicationRegistryError('application_state_invalid', 'Application Git deployment target state is invalid', 409);
    }
  } else {
    if (application.releases.length !== 0 || application.currentReleaseId !== null || application.previousReleaseId !== null
      || application.currentCommitSha !== null || application.currentGitTarget !== null || application.activeDeploymentId !== null
      || application.pendingRollbackReleaseId !== null || application.lastDeploymentId !== null || application.lastDeployedAt !== null
      || application.lastRolledBackAt !== null) {
      throw new ApplicationRegistryError('application_state_invalid', 'PHP bootstrap Application must not persist legacy Git deployment state', 409);
    }
    application.currentGitTarget = null;
    application.appliedRevision = 0;
  }

  if (
    application.type !== 'php'
    && application.currentReleaseId
    && application.currentCommitSha
    && COMMIT_PATTERN.test(application.currentCommitSha)
    && !application.releases.some((release) => release.releaseId === application.currentReleaseId)
  ) {
    application.releases.push({
      releaseId: application.currentReleaseId,
      deploymentId: application.currentReleaseId,
      commitSha: application.currentCommitSha.toLowerCase(),
      gitTarget: application.currentGitTarget,
      artifactFiles: null,
      artifactBytes: null,
      deployedAt: application.lastDeployedAt ?? application.updatedAt ?? application.createdAt,
      runtime: (application.type === 'node' || application.type === 'python') ? structuredClone(application.activeRuntime) : null,
      configurationRevision: (application.type === 'node' || application.type === 'python') ? application.appliedRevision : null,
    });
  }
  return application;
}

function trimReleaseHistory(application) {
  const protectedIds = new Set([application.currentReleaseId, application.previousReleaseId].filter(Boolean));
  const retained = [];
  for (const release of application.releases) {
    if (protectedIds.has(release.releaseId) && !retained.some((entry) => entry.releaseId === release.releaseId)) retained.push(release);
  }
  for (const release of application.releases) {
    if (retained.length >= application.retention) break;
    if (!retained.some((entry) => entry.releaseId === release.releaseId)) retained.push(release);
  }
  application.releases = retained.slice(0, application.retention);
}

function baseApplication({ id, serverId, name, type, repositoryUrl, branch, retention, runtimeAdapter = null, timestamp }) {
  return {
    id,
    serverId,
    name,
    type,
    repositoryUrl,
    branch,
    retention,
    runtimeAdapter,
    state: 'draft',
    desiredRevision: 1,
    appliedRevision: 0,
    currentReleaseId: null,
    previousReleaseId: null,
    currentCommitSha: null,
    currentGitTarget: null,
    releases: [],
    activeDeploymentId: null,
    pendingRollbackReleaseId: null,
    lastDeploymentId: null,
    lastDeployedAt: null,
    lastRolledBackAt: null,
    lastError: null,
    serviceName: null,
    servicePort: null,
    healthPath: null,
    proxyTarget: null,
    activeRuntime: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
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
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.applications)) throw new Error('unsupported or invalid application registry state');
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

  async function ensureServer(serverId) {
    if (typeof serverId !== 'string' || !serverId) throw new ApplicationRegistryError('invalid_server', 'serverId is required');
    if (!(await serverExists(serverId))) throw new ApplicationRegistryError('server_not_found', 'Target server does not exist', 404);
  }

  async function createApplication({ applicationId = null, serverId, name, repositoryUrl, branch = 'main', build = {}, retention = 5 }) {
    await ensureInitialized();
    await ensureServer(serverId);
    const config = normalizeStaticConfig({ repositoryUrl, branch, build, retention });
    const id = applicationId == null ? randomUUID() : normalizeApplicationId(applicationId);
    const timestamp = new Date(now()).toISOString();
    const application = {
      ...baseApplication({
        id,
        serverId,
        name: validateName(name),
        type: 'static',
        repositoryUrl: config.repositoryUrl,
        branch: config.branch,
        retention: config.retention,
        runtimeAdapter: null,
        timestamp,
      }),
      build: config.build,
      runtime: null,
      webRoot: `/var/www/yunpanel/apps/${id}/current`,
    };
    const existing = existingApplication(state, application, { idempotent: applicationId !== null });
    if (existing) return existing;
    state.applications.push(application);
    await persist();
    return publicApplication(application);
  }

  async function createNodeApplication({
    applicationId = null,
    serverId,
    name,
    repositoryUrl,
    branch = 'main',
    runtime,
    runtimeAdapter,
    retention = 5,
  }) {
    await ensureInitialized();
    await ensureServer(serverId);
    const config = normalizeNodeConfig({ repositoryUrl, branch, runtime, retention, runtimeAdapter });
    const id = applicationId == null ? randomUUID() : normalizeApplicationId(applicationId);
    const timestamp = new Date(now()).toISOString();
    const directSystemd = config.runtimeAdapter === 'direct-systemd';
    const application = {
      ...baseApplication({
        id,
        serverId,
        name: validateName(name),
        type: 'node',
        repositoryUrl: config.repositoryUrl,
        branch: config.branch,
        retention: config.retention,
        runtimeAdapter: config.runtimeAdapter,
        timestamp,
      }),
      build: null,
      runtime: config.runtime,
      webRoot: null,
      servicePort: directSystemd ? config.runtime.port : null,
      healthPath: config.runtime.healthPath,
      proxyTarget: directSystemd ? { host: '127.0.0.1', port: config.runtime.port } : null,
    };
    const existing = existingApplication(state, application, { idempotent: applicationId !== null });
    if (existing) return existing;
    if (directSystemd && state.applications.some((candidate) => candidate.serverId === serverId
      && candidate.type === 'node' && candidate.runtime?.port === config.runtime.port)) {
      throw new ApplicationRegistryError('node_port_conflict', 'Node application port is already allocated on this server', 409);
    }
    state.applications.push(application);
    await persist();
    return publicApplication(application);
  }

  async function createPhpApplication({ applicationId = null, serverId, name }) {
    await ensureInitialized();
    await ensureServer(serverId);
    const id = applicationId == null ? randomUUID() : normalizeApplicationId(applicationId);
    const timestamp = new Date(now()).toISOString();
    const application = {
      ...baseApplication({
        id,
        serverId,
        name: validateName(name),
        type: 'php',
        repositoryUrl: null,
        branch: null,
        retention: 2,
        runtimeAdapter: null,
        timestamp,
      }),
      build: null,
      runtime: null,
      webRoot: `/var/lib/yunpanel/apps/${id}/current/public`,
    };
    const existing = existingApplication(state, application, { idempotent: applicationId !== null });
    if (existing) return existing;
    state.applications.push(application);
    await persist();
    return publicApplication(application);
  }

  async function createPythonApplication({
    applicationId = null,
    serverId,
    name,
    repositoryUrl,
    branch = 'main',
    runtime = {},
    retention = 5,
  }) {
    await ensureInitialized();
    await ensureServer(serverId);
    const config = normalizePythonConfig({ repositoryUrl, branch, runtime, retention });
    const id = applicationId == null ? randomUUID() : normalizeApplicationId(applicationId);
    const timestamp = new Date(now()).toISOString();
    const serviceName = pythonServiceName(id);
    const socketPath = pythonSocketPath(id);
    const application = {
      ...baseApplication({
        id,
        serverId,
        name: validateName(name),
        type: 'python',
        repositoryUrl: config.repositoryUrl,
        branch: config.branch,
        retention: config.retention,
        runtimeAdapter: null,
        timestamp,
      }),
      build: null,
      runtime: config.runtime,
      webRoot: null,
      serviceName,
      socketPath,
      servicePort: config.runtime.port ?? null,
      healthPath: config.runtime.healthPath,
      proxyTarget: config.runtime.port ? { host: '127.0.0.1', port: config.runtime.port } : null,
    };
    const existing = existingApplication(state, application, { idempotent: applicationId !== null });
    if (existing) return existing;
    if (config.runtime.port && state.applications.some((candidate) => candidate.serverId === serverId
      && candidate.type === 'python' && candidate.runtime?.port === config.runtime.port)) {
      throw new ApplicationRegistryError('python_port_conflict', 'Python application port is already allocated on this server', 409);
    }
    state.applications.push(application);
    await persist();
    return publicApplication(application);
  }

  async function allocateNodePort({ serverId, reservedPorts = [], start = 3100, end = 49151 } = {}) {
    await ensureInitialized();
    await ensureServer(serverId);
    if (!Array.isArray(reservedPorts) || reservedPorts.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)
      || !Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535 || start > end) {
      throw new ApplicationRegistryError('invalid_node_port_allocation', 'Node port allocation bounds are invalid');
    }
    const used = new Set(reservedPorts);
    for (const application of state.applications) {
      if (application.serverId === serverId && application.type === 'node' && Number.isInteger(application.runtime?.port)) {
        used.add(application.runtime.port);
      }
    }
    for (let port = start; port <= end; port += 1) if (!used.has(port)) return port;
    throw new ApplicationRegistryError('node_port_exhausted', 'No managed Node application port is available', 409);
  }

  async function markDeploying(applicationId, deploymentId) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, applicationId));
    if (!['static', 'node', 'python'].includes(application.type)) {
      throw new ApplicationRegistryError('deployment_not_supported', 'Legacy deployment flow is not supported for this application type', 409);
    }
    if (application.type === 'node' && application.runtimeAdapter !== 'direct-systemd') {
      throw new ApplicationRegistryError('node_deploy_adapter_mismatch', 'Passenger Node releases must use Website provisioning instead of the legacy systemd deploy flow', 409);
    }
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
    gitTarget: requestedGitTarget = null,
    previousReleaseId,
    artifactFiles = null,
    artifactBytes = null,
    serviceName = null,
    port = null,
    healthPath = null,
    healthy = null,
    runtime: requestedRuntime = null,
  }) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, applicationId));
    if (!['static', 'node', 'python'].includes(application.type)) {
      throw new ApplicationRegistryError('deployment_not_supported', 'Legacy deployment flow is not supported for this application type', 409);
    }
    if (application.type === 'node' && application.runtimeAdapter !== 'direct-systemd') {
      throw new ApplicationRegistryError('node_deploy_adapter_mismatch', 'Passenger Node releases must use Website provisioning instead of the legacy systemd deploy flow', 409);
    }
    const normalizedDeploymentId = normalizeUuid(deploymentId, 'deploymentId');
    const normalizedReleaseId = normalizeUuid(releaseId, 'releaseId');
    const previousValue = previousReleaseId === undefined ? application.currentReleaseId : previousReleaseId;
    const normalizedPreviousReleaseId = normalizeNullableUuid(previousValue, 'previousReleaseId');

    if (application.activeDeploymentId !== normalizedDeploymentId) throw new ApplicationRegistryError('deployment_mismatch', 'Deployment result does not match active application deployment', 409);
    if (normalizedReleaseId !== normalizedDeploymentId) throw new ApplicationRegistryError('release_mismatch', 'Application release must match deployment identity', 409);
    if (normalizedPreviousReleaseId !== application.currentReleaseId) throw new ApplicationRegistryError('release_state_drift', 'Managed server previous release does not match control-plane state', 409);
    if (typeof commitSha !== 'string' || !COMMIT_PATTERN.test(commitSha)) throw new ApplicationRegistryError('invalid_commit_sha', 'Deployment commit SHA is invalid');
    let gitTarget;
    try { gitTarget = normalizeGitDeploymentTarget(requestedGitTarget, { defaultBranch: application.branch }); }
    catch { throw new ApplicationRegistryError('invalid_git_target', 'Deployment Git target is invalid'); }
    if (gitTarget.kind === 'commit' && commitSha.toLowerCase() !== gitTarget.value) {
      throw new ApplicationRegistryError('git_target_mismatch', 'Deployment commit does not match the requested Git target', 409);
    }
    if (artifactFiles != null && (!Number.isInteger(artifactFiles) || artifactFiles < 1 || artifactFiles > 100_000)) throw new ApplicationRegistryError('invalid_artifact_metadata', 'Artifact file count is invalid');
    if (artifactBytes != null && (!Number.isInteger(artifactBytes) || artifactBytes < 0 || artifactBytes > 2 * 1024 * 1024 * 1024)) throw new ApplicationRegistryError('invalid_artifact_metadata', 'Artifact byte size is invalid');

    if (application.type === 'node') {
      const deployedRuntime = normalizeNodeConfig({
        repositoryUrl: application.repositoryUrl,
        branch: application.branch,
        runtime: requestedRuntime ?? application.runtime,
        retention: application.retention,
        runtimeAdapter: application.runtimeAdapter,
      }).runtime;
      if (!sameValue(deployedRuntime, application.runtime)) {
        throw new ApplicationRegistryError('node_runtime_state_drift', 'Node deployment runtime does not match current desired configuration', 409);
      }
      const expectedService = expectedNodeServiceName(application.id);
      if (typeof serviceName !== 'string' || !NODE_SERVICE_PATTERN.test(serviceName) || serviceName !== expectedService) {
        throw new ApplicationRegistryError('invalid_node_service', 'Node deployment service identity is invalid');
      }
      if (!Number.isInteger(port) || port !== deployedRuntime.port) {
        throw new ApplicationRegistryError('invalid_node_port', 'Node deployment port does not match application state');
      }
      if (typeof healthPath !== 'string' || healthPath !== deployedRuntime.healthPath || healthy !== true) {
        throw new ApplicationRegistryError('invalid_node_health', 'Node deployment health result does not match application state');
      }
    }

    if (application.type === 'python') {
      const deployedRuntime = normalizePythonConfig({
        repositoryUrl: application.repositoryUrl,
        branch: application.branch,
        runtime: requestedRuntime ?? application.runtime,
        retention: application.retention,
      }).runtime;
      if (!sameValue(deployedRuntime, application.runtime)) {
        throw new ApplicationRegistryError('python_runtime_state_drift', 'Python deployment runtime does not match current desired configuration', 409);
      }
    }

    const timestamp = new Date(now()).toISOString();
    application.previousReleaseId = application.currentReleaseId;
    application.currentReleaseId = normalizedReleaseId;
    application.currentCommitSha = commitSha.toLowerCase();
    application.currentGitTarget = gitTarget;
    application.activeDeploymentId = null;
    application.pendingRollbackReleaseId = null;
    application.state = 'active';
    application.lastDeployedAt = timestamp;
    application.lastError = null;
    application.updatedAt = timestamp;
    if (application.type === 'node') {
      application.activeRuntime = structuredClone(application.runtime);
      application.appliedRevision = application.desiredRevision;
      application.serviceName = serviceName;
      application.servicePort = port;
      application.healthPath = healthPath;
      application.proxyTarget = { host: '127.0.0.1', port };
    }
    if (application.type === 'python') {
      application.activeRuntime = structuredClone(application.runtime);
      application.appliedRevision = application.desiredRevision;
      application.serviceName = pythonServiceName(application.id);
      application.socketPath = pythonSocketPath(application.id);
      application.servicePort = application.runtime?.port ?? null;
      application.healthPath = application.runtime?.healthPath ?? '/';
      application.proxyTarget = application.runtime?.port ? { host: '127.0.0.1', port: application.runtime.port } : null;
    }

    application.releases = application.releases.filter((release) => release.releaseId !== normalizedReleaseId);
    application.releases.unshift({
      releaseId: normalizedReleaseId,
      deploymentId: normalizedDeploymentId,
      commitSha: commitSha.toLowerCase(),
      gitTarget,
      artifactFiles,
      artifactBytes,
      deployedAt: timestamp,
      runtime: (application.type === 'node' || application.type === 'python') ? structuredClone(application.activeRuntime) : null,
      configurationRevision: (application.type === 'node' || application.type === 'python') ? application.appliedRevision : null,
    });
    trimReleaseHistory(application);
    await persist();
    return publicApplication(application);
  }

  async function activatePassengerRelease(applicationId, {
    operationId,
    releaseId,
    previousReleaseId = null,
    commitSha,
    gitTarget: requestedGitTarget = null,
    runtime: requestedRuntime = null,
  } = {}) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, normalizeApplicationId(applicationId)));
    if (application.type !== 'node' || application.runtimeAdapter !== 'passenger') {
      throw new ApplicationRegistryError('passenger_release_adapter_mismatch', 'Passenger release activation requires a Passenger Node Application', 409);
    }
    if (application.activeDeploymentId) {
      throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);
    }
    const normalizedOperationId = normalizeUuid(operationId, 'operationId');
    const normalizedReleaseId = normalizeUuid(releaseId, 'releaseId');
    const normalizedPreviousReleaseId = normalizeNullableUuid(previousReleaseId, 'previousReleaseId');
    if (normalizedOperationId !== normalizedReleaseId) {
      throw new ApplicationRegistryError('release_mismatch', 'Passenger release must match provisioning operation identity', 409);
    }
    if (typeof commitSha !== 'string' || !COMMIT_PATTERN.test(commitSha)) {
      throw new ApplicationRegistryError('invalid_commit_sha', 'Passenger release commit SHA is invalid');
    }
    let gitTarget;
    try { gitTarget = normalizeGitDeploymentTarget(requestedGitTarget, { defaultBranch: application.branch }); }
    catch { throw new ApplicationRegistryError('invalid_git_target', 'Passenger release Git target is invalid'); }
    if (gitTarget.kind === 'commit' && commitSha.toLowerCase() !== gitTarget.value) {
      throw new ApplicationRegistryError('git_target_mismatch', 'Passenger release commit does not match the requested Git target', 409);
    }
    const deployedRuntime = normalizeNodeConfig({
      repositoryUrl: application.repositoryUrl,
      branch: application.branch,
      runtime: requestedRuntime ?? application.runtime,
      retention: application.retention,
      runtimeAdapter: application.runtimeAdapter,
    }).runtime;
    if (!sameValue(deployedRuntime, application.runtime)) {
      throw new ApplicationRegistryError('node_runtime_state_drift', 'Passenger release runtime does not match current desired configuration', 409);
    }

    if (application.currentReleaseId === normalizedReleaseId) {
      const release = application.releases.find((candidate) => candidate.releaseId === normalizedReleaseId) ?? null;
      if (!release
        || application.previousReleaseId !== normalizedPreviousReleaseId
        || application.currentCommitSha !== commitSha.toLowerCase()
        || !sameValue(application.currentGitTarget, gitTarget)
        || !sameValue(application.activeRuntime, deployedRuntime)
        || application.appliedRevision !== application.desiredRevision
        || application.serviceName !== null || application.servicePort !== null || application.proxyTarget !== null) {
        throw new ApplicationRegistryError('passenger_release_state_drift', 'Persisted Passenger release state conflicts with provisioning evidence', 409);
      }
      return publicApplication(application);
    }
    if (application.currentReleaseId !== normalizedPreviousReleaseId) {
      throw new ApplicationRegistryError('release_state_drift', 'Passenger previous release does not match control-plane state', 409);
    }

    const timestamp = new Date(now()).toISOString();
    application.previousReleaseId = application.currentReleaseId;
    application.currentReleaseId = normalizedReleaseId;
    application.currentCommitSha = commitSha.toLowerCase();
    application.currentGitTarget = gitTarget;
    application.activeRuntime = structuredClone(deployedRuntime);
    application.appliedRevision = application.desiredRevision;
    application.activeDeploymentId = null;
    application.pendingRollbackReleaseId = null;
    application.state = 'active';
    application.lastDeploymentId = normalizedOperationId;
    application.lastDeployedAt = timestamp;
    application.lastError = null;
    application.serviceName = null;
    application.servicePort = null;
    application.healthPath = deployedRuntime.healthPath;
    application.proxyTarget = null;
    application.updatedAt = timestamp;
    application.releases = application.releases.filter((release) => release.releaseId !== normalizedReleaseId);
    application.releases.unshift({
      releaseId: normalizedReleaseId,
      deploymentId: normalizedOperationId,
      commitSha: commitSha.toLowerCase(),
      gitTarget,
      artifactFiles: null,
      artifactBytes: null,
      deployedAt: timestamp,
      runtime: structuredClone(deployedRuntime),
      configurationRevision: application.appliedRevision,
    });
    trimReleaseHistory(application);
    await persist();
    return publicApplication(application);
  }

  async function resetPassengerInitialRelease(applicationId, { operationId, releaseId } = {}) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, normalizeApplicationId(applicationId)));
    if (application.type !== 'node' || application.runtimeAdapter !== 'passenger') {
      throw new ApplicationRegistryError('passenger_release_adapter_mismatch', 'Passenger release reset requires a Passenger Node Application', 409);
    }
    const normalizedOperationId = normalizeUuid(operationId, 'operationId');
    const normalizedReleaseId = normalizeUuid(releaseId, 'releaseId');
    if (normalizedOperationId !== normalizedReleaseId) {
      throw new ApplicationRegistryError('release_mismatch', 'Passenger release must match provisioning operation identity', 409);
    }
    const retainedRelease = application.releases.find((release) => release.releaseId === normalizedReleaseId) ?? null;
    if (application.currentReleaseId === null && retainedRelease === null) return publicApplication(application);
    if (application.currentReleaseId !== normalizedReleaseId
      || application.previousReleaseId !== null
      || application.lastDeploymentId !== normalizedOperationId) {
      throw new ApplicationRegistryError('passenger_release_reset_drift', 'Passenger release cannot be reset after control-plane state changed', 409);
    }
    application.releases = application.releases.filter((release) => release.releaseId !== normalizedReleaseId);
    application.currentReleaseId = null;
    application.previousReleaseId = null;
    application.currentCommitSha = null;
    application.currentGitTarget = null;
    application.activeRuntime = null;
    application.appliedRevision = 0;
    application.activeDeploymentId = null;
    application.pendingRollbackReleaseId = null;
    application.state = 'draft';
    application.lastDeploymentId = null;
    application.lastDeployedAt = null;
    application.lastError = null;
    application.serviceName = null;
    application.servicePort = null;
    application.healthPath = application.runtime.healthPath;
    application.proxyTarget = null;
    application.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicApplication(application);
  }

  async function markPassengerMigrated(applicationId, { operationId = null } = {}) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, normalizeApplicationId(applicationId)));
    if (application.type !== 'node') {
      throw new ApplicationRegistryError('invalid_application_type', 'Application is not a Node application', 409);
    }
    if (application.runtimeAdapter === 'passenger') {
      return publicApplication(application);
    }
    const timestamp = new Date(now()).toISOString();
    application.runtimeAdapter = 'passenger';
    if (application.runtime && typeof application.runtime === 'object') {
      const { port: _unusedPort, ...cleanRuntime } = application.runtime;
      application.runtime = cleanRuntime;
    }
    if (application.activeRuntime && typeof application.activeRuntime === 'object') {
      const { port: _unusedActivePort, ...cleanActiveRuntime } = application.activeRuntime;
      application.activeRuntime = cleanActiveRuntime;
    }
    application.releases = application.releases.map((release) => {
      if (!release.runtime || typeof release.runtime !== 'object') return release;
      const { port: _unusedRelPort, ...cleanRelRuntime } = release.runtime;
      return { ...release, runtime: cleanRelRuntime };
    });
    application.serviceName = null;
    application.servicePort = null;
    application.proxyTarget = null;
    application.updatedAt = timestamp;
    await persist();
    return publicApplication(application);
  }

  async function activatePythonRelease(applicationId, {
    operationId,
    releaseId,
    previousReleaseId = null,
    commitSha,
    gitTarget: requestedGitTarget = null,
    runtime: requestedRuntime = null,
  } = {}) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, normalizeApplicationId(applicationId)));
    if (application.type !== 'python') {
      throw new ApplicationRegistryError('python_release_adapter_mismatch', 'Python release activation requires a Python Application', 409);
    }
    if (application.activeDeploymentId) {
      throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);
    }
    const normalizedOperationId = normalizeUuid(operationId, 'operationId');
    const normalizedReleaseId = normalizeUuid(releaseId, 'releaseId');
    const normalizedPreviousReleaseId = normalizeNullableUuid(previousReleaseId, 'previousReleaseId');
    if (normalizedOperationId !== normalizedReleaseId) {
      throw new ApplicationRegistryError('release_mismatch', 'Python release must match provisioning operation identity', 409);
    }
    if (typeof commitSha !== 'string' || !COMMIT_PATTERN.test(commitSha)) {
      throw new ApplicationRegistryError('invalid_commit_sha', 'Python release commit SHA is invalid');
    }
    let gitTarget;
    try { gitTarget = normalizeGitDeploymentTarget(requestedGitTarget, { defaultBranch: application.branch }); }
    catch { throw new ApplicationRegistryError('invalid_git_target', 'Python release Git target is invalid'); }
    if (gitTarget.kind === 'commit' && commitSha.toLowerCase() !== gitTarget.value) {
      throw new ApplicationRegistryError('git_target_mismatch', 'Python release commit does not match the requested Git target', 409);
    }
    const deployedRuntime = normalizePythonConfig({
      repositoryUrl: application.repositoryUrl,
      branch: application.branch,
      runtime: requestedRuntime ?? application.runtime,
      retention: application.retention,
    }).runtime;
    if (!sameValue(deployedRuntime, application.runtime)) {
      throw new ApplicationRegistryError('python_runtime_state_drift', 'Python release runtime does not match current desired configuration', 409);
    }

    if (application.currentReleaseId === normalizedReleaseId) {
      const release = application.releases.find((candidate) => candidate.releaseId === normalizedReleaseId) ?? null;
      if (!release
        || application.previousReleaseId !== normalizedPreviousReleaseId
        || application.currentCommitSha !== commitSha.toLowerCase()
        || !sameValue(application.currentGitTarget, gitTarget)
        || !sameValue(application.activeRuntime, deployedRuntime)
        || application.appliedRevision !== application.desiredRevision) {
        throw new ApplicationRegistryError('python_release_state_drift', 'Persisted Python release state conflicts with provisioning evidence', 409);
      }
      return publicApplication(application);
    }
    if (application.currentReleaseId !== normalizedPreviousReleaseId) {
      throw new ApplicationRegistryError('release_state_drift', 'Python previous release does not match control-plane state', 409);
    }

    const timestamp = new Date(now()).toISOString();
    application.previousReleaseId = application.currentReleaseId;
    application.currentReleaseId = normalizedReleaseId;
    application.currentCommitSha = commitSha.toLowerCase();
    application.currentGitTarget = gitTarget;
    application.activeRuntime = structuredClone(deployedRuntime);
    application.appliedRevision = application.desiredRevision;
    application.activeDeploymentId = null;
    application.pendingRollbackReleaseId = null;
    application.state = 'active';
    application.lastDeploymentId = normalizedOperationId;
    application.lastDeployedAt = timestamp;
    application.lastError = null;
    application.serviceName = pythonServiceName(application.id);
    application.socketPath = pythonSocketPath(application.id);
    application.servicePort = deployedRuntime.port ?? null;
    application.healthPath = deployedRuntime.healthPath ?? '/';
    application.proxyTarget = deployedRuntime.port ? { host: '127.0.0.1', port: deployedRuntime.port } : null;
    application.updatedAt = timestamp;
    application.releases = application.releases.filter((release) => release.releaseId !== normalizedReleaseId);
    application.releases.unshift({
      releaseId: normalizedReleaseId,
      deploymentId: normalizedOperationId,
      commitSha: commitSha.toLowerCase(),
      gitTarget,
      artifactFiles: null,
      artifactBytes: null,
      deployedAt: timestamp,
      runtime: structuredClone(deployedRuntime),
      configurationRevision: application.appliedRevision,
    });
    trimReleaseHistory(application);
    await persist();
    return publicApplication(application);
  }

  async function resetPythonInitialRelease(applicationId, { operationId, releaseId } = {}) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, normalizeApplicationId(applicationId)));
    if (application.type !== 'python') {
      throw new ApplicationRegistryError('python_release_adapter_mismatch', 'Python release reset requires a Python Application', 409);
    }
    const normalizedOperationId = normalizeUuid(operationId, 'operationId');
    const normalizedReleaseId = normalizeUuid(releaseId, 'releaseId');
    if (normalizedOperationId !== normalizedReleaseId) {
      throw new ApplicationRegistryError('release_mismatch', 'Python release must match provisioning operation identity', 409);
    }
    const retainedRelease = application.releases.find((release) => release.releaseId === normalizedReleaseId) ?? null;
    if (application.currentReleaseId === null && retainedRelease === null) return publicApplication(application);
    if (application.currentReleaseId !== normalizedReleaseId
      || application.previousReleaseId !== null
      || application.lastDeploymentId !== normalizedOperationId) {
      throw new ApplicationRegistryError('python_release_reset_drift', 'Python release cannot be reset after control-plane state changed', 409);
    }
    application.releases = application.releases.filter((release) => release.releaseId !== normalizedReleaseId);
    application.currentReleaseId = null;
    application.previousReleaseId = null;
    application.currentCommitSha = null;
    application.currentGitTarget = null;
    application.activeRuntime = null;
    application.appliedRevision = 0;
    application.activeDeploymentId = null;
    application.pendingRollbackReleaseId = null;
    application.state = 'draft';
    application.lastDeploymentId = null;
    application.lastDeployedAt = null;
    application.lastError = null;
    application.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicApplication(application);
  }

  async function markRollingBack(applicationId, operationId, releaseId) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, applicationId));
    if (!['static', 'node', 'python'].includes(application.type)) throw new ApplicationRegistryError('rollback_not_supported', 'Rollback is not implemented for this application type yet', 409);
    if (application.type === 'node' && application.runtimeAdapter !== 'direct-systemd') {
      throw new ApplicationRegistryError('node_rollback_adapter_mismatch', 'Passenger Node rollback must use Website provisioning instead of the legacy systemd rollback flow', 409);
    }
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

  async function markRolledBack(applicationId, {
    operationId,
    releaseId,
    previousReleaseId,
    serviceName = null,
    port = null,
    healthPath = null,
    healthy = null,
  }) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, applicationId));
    if (!['static', 'node', 'python'].includes(application.type)) throw new ApplicationRegistryError('rollback_not_supported', 'Rollback is not implemented for this application type yet', 409);
    if (application.type === 'node' && application.runtimeAdapter !== 'direct-systemd') {
      throw new ApplicationRegistryError('node_rollback_adapter_mismatch', 'Passenger Node rollback must use Website provisioning instead of the legacy systemd rollback flow', 409);
    }
    const normalizedOperationId = normalizeUuid(operationId, 'operationId');
    const normalizedReleaseId = normalizeUuid(releaseId, 'releaseId');
    const previousValue = previousReleaseId === undefined ? application.currentReleaseId : previousReleaseId;
    const normalizedPreviousReleaseId = normalizeNullableUuid(previousValue, 'previousReleaseId');

    if (application.activeDeploymentId !== normalizedOperationId || application.pendingRollbackReleaseId !== normalizedReleaseId) throw new ApplicationRegistryError('rollback_mismatch', 'Rollback result does not match active application rollback', 409);
    if (normalizedPreviousReleaseId !== application.currentReleaseId) throw new ApplicationRegistryError('release_state_drift', 'Managed server current release does not match control-plane rollback state', 409);
    const target = application.releases.find((release) => release.releaseId === normalizedReleaseId);
    if (!target) throw new ApplicationRegistryError('rollback_release_unknown', 'Rollback release is not in retained application history', 409);

    if (application.type === 'node') {
      const targetRuntime = normalizeNodeRuntimeConfig(target.runtime);
      const expectedService = expectedNodeServiceName(application.id);
      if (typeof serviceName !== 'string' || !NODE_SERVICE_PATTERN.test(serviceName) || serviceName !== expectedService) {
        throw new ApplicationRegistryError('invalid_node_service', 'Node rollback service identity is invalid');
      }
      if (!Number.isInteger(port) || port !== targetRuntime.port) {
        throw new ApplicationRegistryError('invalid_node_port', 'Node rollback port does not match application state');
      }
      if (typeof healthPath !== 'string' || healthPath !== targetRuntime.healthPath || healthy !== true) {
        throw new ApplicationRegistryError('invalid_node_health', 'Node rollback health result does not match application state');
      }
    }

    const timestamp = new Date(now()).toISOString();
    application.previousReleaseId = application.currentReleaseId;
    application.currentReleaseId = normalizedReleaseId;
    application.currentCommitSha = target.commitSha;
    application.currentGitTarget = structuredClone(target.gitTarget);
    application.activeDeploymentId = null;
    application.pendingRollbackReleaseId = null;
    application.state = 'active';
    application.lastRolledBackAt = timestamp;
    application.lastError = null;
    application.updatedAt = timestamp;
    if (application.type === 'node') {
      application.activeRuntime = structuredClone(target.runtime);
      application.appliedRevision = target.configurationRevision;
      application.serviceName = serviceName;
      application.servicePort = port;
      application.healthPath = healthPath;
      application.proxyTarget = { host: '127.0.0.1', port };
    }
    if (application.type === 'python') {
      const targetRuntime = normalizePythonRuntimeConfig(target.runtime);
      application.activeRuntime = structuredClone(target.runtime);
      application.appliedRevision = target.configurationRevision;
      application.serviceName = pythonServiceName(application.id);
      application.socketPath = pythonSocketPath(application.id);
      application.servicePort = targetRuntime.port ?? null;
      application.healthPath = targetRuntime.healthPath ?? '/';
      application.proxyTarget = targetRuntime.port ? { host: '127.0.0.1', port: targetRuntime.port } : null;
    }
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

  async function previewNodeConfiguration(applicationId, requestedRuntime) {
    await ensureInitialized();
    const application = hydrateApplication(requireApplication(state, normalizeApplicationId(applicationId)));
    if (application.type !== 'node') {
      throw new ApplicationRegistryError('node_configuration_not_supported', 'Runtime configuration is available only for Node applications', 409);
    }
    if (application.activeDeploymentId) {
      throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);
    }
    const nextRuntime = normalizeNodeConfig({
      repositoryUrl: application.repositoryUrl,
      branch: application.branch,
      runtime: requestedRuntime,
      retention: application.retention,
      runtimeAdapter: application.runtimeAdapter,
    }).runtime;
    if (application.runtimeAdapter === 'direct-systemd' && nextRuntime.port !== application.runtime.port) {
      throw new ApplicationRegistryError('node_port_immutable', 'Managed Node port cannot be changed through runtime configuration', 409);
    }
    if (sameValue(nextRuntime, application.runtime)) {
      throw new ApplicationRegistryError('node_configuration_no_changes', 'Node runtime configuration does not change current desired state', 409);
    }
    const changedFields = Object.keys(nextRuntime).filter((field) => !sameValue(nextRuntime[field], application.runtime[field])).sort();
    const core = {
      version: 1,
      applicationId: application.id,
      currentRevision: application.desiredRevision,
      currentReleaseId: application.currentReleaseId,
      nextRuntime,
      impact: {
        changedFields,
        deploymentRequired: application.currentReleaseId !== null,
        activeProcessChanged: false,
      },
    };
    const previewDigest = createHash('sha256').update(JSON.stringify(core)).digest('hex');
    return Object.freeze({
      ...core,
      previewDigest,
      confirmation: `update-node:${application.id}:${application.desiredRevision}:${previewDigest}`,
      autoApply: false,
    });
  }

  async function updateNodeConfiguration({ applicationId, expectedRevision, runtime, previewDigest, confirmation } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ApplicationRegistryError('invalid_application_revision', 'A positive Application revision is required');
    }
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
      throw new ApplicationRegistryError('invalid_node_configuration_digest', 'A current Node configuration preview digest is required');
    }
    await ensureInitialized();
    const beforePreview = hydrateApplication(requireApplication(state, normalizeApplicationId(applicationId)));
    if (beforePreview.desiredRevision !== expectedRevision) {
      throw new ApplicationRegistryError('application_revision_conflict', 'Application changed after preview; request a new preview', 409);
    }
    const preview = await previewNodeConfiguration(applicationId, runtime);
    if (preview.currentRevision !== expectedRevision) {
      throw new ApplicationRegistryError('application_revision_conflict', 'Application changed after preview; request a new preview', 409);
    }
    if (preview.previewDigest !== previewDigest) {
      throw new ApplicationRegistryError('node_configuration_preview_stale', 'Node configuration preview is stale', 409);
    }
    if (confirmation !== preview.confirmation) {
      throw new ApplicationRegistryError('node_configuration_confirmation_required', 'Exact Node configuration confirmation is required');
    }
    const application = hydrateApplication(requireApplication(state, preview.applicationId));
    if (application.desiredRevision !== expectedRevision || application.activeDeploymentId) {
      throw new ApplicationRegistryError('application_revision_conflict', 'Application changed after preview; request a new preview', 409);
    }
    application.runtime = structuredClone(preview.nextRuntime);
    application.desiredRevision += 1;
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
    createNodeApplication,
    createPhpApplication,
    createPythonApplication,
    allocateNodePort,
    markDeploying,
    markDeployed,
    activatePassengerRelease,
    resetPassengerInitialRelease,
    markPassengerMigrated,
    activatePythonRelease,
    resetPythonInitialRelease,
    markRollingBack,
    markRolledBack,
    markFailed,
    previewNodeConfiguration,
    updateNodeConfiguration,
    getApplication,
    listApplications,
  };
}
