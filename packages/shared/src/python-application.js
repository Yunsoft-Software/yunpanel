import {
  ApplicationValidationError,
  assertUuid,
  normalizeGithubRepositoryUrl,
  normalizeGitBranch,
  normalizeGitDeploymentTarget,
  normalizeRelativeBuildPath,
} from './application.js';

export const SUPPORTED_PYTHON_VERSIONS = Object.freeze(['3.10', '3.11', '3.12']);
export const DEFAULT_PYTHON_VERSION = '3.12';
export const SUPPORTED_APP_SERVERS = Object.freeze(['gunicorn', 'uvicorn']);
export const DEFAULT_APP_SERVER = 'gunicorn';

const ENTRY_POINT_PATTERN = /^[a-zA-Z0-9_.]+(?::[a-zA-Z0-9_]+)?$/;
const HEALTH_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const RUNTIME_MODES = new Set(['production', 'development']);
const RESTART_POLICIES = new Set(['always', 'on-failure']);

const RUNTIME_FIELDS = new Set([
  'pythonVersion',
  'appServer',
  'entryPoint',
  'workers',
  'requirementsFile',
  'documentRoot',
  'healthPath',
  'healthTimeoutSeconds',
  'restartPolicy',
  'mode',
  'port',
]);

const APPLICATION_SPEC_FIELDS = new Set([
  'applicationId',
  'deploymentId',
  'repositoryUrl',
  'branch',
  'gitTarget',
  'runtime',
  'retention',
]);

export function normalizePythonRuntimeConfig(value = {}, { requirePort = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_python_runtime', 'Python runtime config must be an object');
  }
  if (Object.keys(value).some((key) => !RUNTIME_FIELDS.has(key))) {
    throw new ApplicationValidationError('invalid_python_runtime', 'Python runtime config contains unsupported fields');
  }

  const pythonVersion = String(value.pythonVersion ?? DEFAULT_PYTHON_VERSION);
  if (!SUPPORTED_PYTHON_VERSIONS.includes(pythonVersion)) {
    throw new ApplicationValidationError('invalid_python_version', `Python version must be one of: ${SUPPORTED_PYTHON_VERSIONS.join(', ')}`);
  }

  const appServer = String(value.appServer ?? DEFAULT_APP_SERVER).toLowerCase();
  if (!SUPPORTED_APP_SERVERS.includes(appServer)) {
    throw new ApplicationValidationError('invalid_app_server', `App server must be one of: ${SUPPORTED_APP_SERVERS.join(', ')}`);
  }

  const entryPoint = String(value.entryPoint ?? 'app:app').trim();
  if (!ENTRY_POINT_PATTERN.test(entryPoint)) {
    throw new ApplicationValidationError('invalid_entry_point', 'Python entry point must be in module:callable format (e.g. app:app)');
  }

  const workers = value.workers ?? 2;
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
    throw new ApplicationValidationError('invalid_workers', 'Workers must be an integer between 1 and 16');
  }

  const requirementsFile = value.requirementsFile == null
    ? 'requirements.txt'
    : normalizeRelativeBuildPath(value.requirementsFile);

  const documentRoot = value.documentRoot == null || value.documentRoot === '.'
    ? '.'
    : normalizeRelativeBuildPath(value.documentRoot, { allowDot: true });

  const healthPath = value.healthPath ?? '/';
  if (typeof healthPath !== 'string' || !HEALTH_PATH_PATTERN.test(healthPath)) {
    throw new ApplicationValidationError('invalid_health_path', 'Python health path is invalid');
  }

  const healthTimeoutSeconds = value.healthTimeoutSeconds ?? 10;
  if (!Number.isInteger(healthTimeoutSeconds) || healthTimeoutSeconds < 1 || healthTimeoutSeconds > 60) {
    throw new ApplicationValidationError('invalid_health_timeout', 'Health timeout must be between 1 and 60 seconds');
  }

  const restartPolicy = value.restartPolicy ?? 'always';
  if (!RESTART_POLICIES.has(restartPolicy)) {
    throw new ApplicationValidationError('invalid_restart_policy', 'Restart policy must be always or on-failure');
  }

  const mode = value.mode ?? 'production';
  if (!RUNTIME_MODES.has(mode)) {
    throw new ApplicationValidationError('invalid_runtime_mode', 'Mode must be production or development');
  }

  let port = null;
  if (value.port !== undefined && value.port !== null) {
    if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) {
      throw new ApplicationValidationError('invalid_python_port', 'Python port must be between 1024 and 65535');
    }
    port = value.port;
  } else if (requirePort) {
    throw new ApplicationValidationError('python_port_required', 'Python port is required when loopback port mode is selected');
  }

  return Object.freeze({
    pythonVersion,
    appServer,
    entryPoint,
    workers,
    requirementsFile,
    documentRoot,
    healthPath,
    healthTimeoutSeconds,
    restartPolicy,
    mode,
    port,
  });
}

export function normalizePythonApplicationSpec(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_application_spec', 'Python application spec must be an object');
  }
  if (Object.keys(value).some((key) => !APPLICATION_SPEC_FIELDS.has(key))) {
    throw new ApplicationValidationError('invalid_application_spec', 'Python application spec contains unsupported fields');
  }

  const applicationId = assertUuid(value.applicationId, 'applicationId');
  const deploymentId = value.deploymentId !== undefined ? assertUuid(value.deploymentId, 'deploymentId') : undefined;
  const repositoryUrl = normalizeGithubRepositoryUrl(value.repositoryUrl);
  const branch = normalizeGitBranch(value.branch);
  const gitTarget = normalizeGitDeploymentTarget(value.gitTarget, { defaultBranch: branch });
  const runtime = normalizePythonRuntimeConfig(value.runtime);
  const retention = Number.isInteger(value.retention) && value.retention >= 2 && value.retention <= 20
    ? value.retention
    : 5;

  const result = {
    applicationId,
    repositoryUrl,
    branch,
    gitTarget,
    runtime,
    retention,
  };
  if (deploymentId !== undefined) {
    result.deploymentId = deploymentId;
  }

  return Object.freeze(result);
}

function normalizeManagedPythonSpec(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError(code, message);
  }
  return {
    applicationId: assertUuid(value.applicationId, 'applicationId'),
    releaseId: assertUuid(value.releaseId, 'releaseId'),
    runtime: normalizePythonRuntimeConfig(value.runtime),
  };
}

export function normalizePythonRollbackSpec(value) {
  return {
    ...normalizeManagedPythonSpec(value, 'invalid_python_rollback', 'Python rollback spec must be an object'),
    currentReleaseId: assertUuid(value.currentReleaseId, 'currentReleaseId'),
  };
}

export function normalizePythonRestartSpec(value) {
  return normalizeManagedPythonSpec(value, 'invalid_python_restart', 'Python restart spec must be an object');
}

export function normalizePythonStatusSpec(value) {
  return normalizeManagedPythonSpec(value, 'invalid_python_status', 'Python status spec must be an object');
}
