import {
  ApplicationValidationError,
  assertUuid,
  normalizeGithubRepositoryUrl,
  normalizeGitBranch,
  normalizeGitDeploymentTarget,
  normalizeRelativeBuildPath,
} from './application.js';

const SCRIPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const HEALTH_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
const RUNTIME_MODES = new Set(['production', 'development']);
const RUNTIME_FIELDS = new Set([
  'nodeMajor', 'packageManager', 'installMode', 'buildScript', 'mode', 'documentRoot',
  'startMode', 'entryFile', 'startScript', 'start', 'port', 'healthPath',
  'healthTimeoutSeconds', 'restartPolicy',
]);
const START_FIELDS = new Set(['mode', 'entryFile', 'script']);
const PROCESS_ACTIONS = new Set(['enable', 'disable', 'start', 'stop']);
const PROCESS_FIELDS = new Set(['applicationId', 'releaseId', 'runtime', 'action']);
export const MANAGED_NODE_RUNTIME_MAJORS = Object.freeze([22, 24]);

function normalizeScriptName(value, fieldName, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || !SCRIPT_PATTERN.test(value)) {
    throw new ApplicationValidationError('invalid_node_script', `${fieldName} is invalid`);
  }
  return value;
}

export function normalizeNodeRuntimeConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_node_runtime', 'Node runtime config must be an object');
  }
  if (Object.keys(value).some((key) => !RUNTIME_FIELDS.has(key))) {
    throw new ApplicationValidationError('invalid_node_runtime', 'Node runtime config contains unsupported fields');
  }
  if (value.start !== undefined && (!value.start || typeof value.start !== 'object' || Array.isArray(value.start))) {
    throw new ApplicationValidationError('invalid_node_start', 'Node start config must be an object');
  }
  if (value.start && Object.keys(value.start).some((key) => !START_FIELDS.has(key))) {
    throw new ApplicationValidationError('invalid_node_start', 'Node start config contains unsupported fields');
  }

  const nodeMajor = value.nodeMajor ?? 24;
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20 || nodeMajor > 40) {
    throw new ApplicationValidationError('invalid_node_version', 'Node major version must be between 20 and 40');
  }

  const installMode = value.installMode ?? 'ci';
  if (!['ci', 'install'].includes(installMode)) {
    throw new ApplicationValidationError('invalid_install_mode', 'npm install mode must be ci or install');
  }

  const buildScript = normalizeScriptName(value.buildScript ?? null, 'buildScript', { nullable: true });
  const packageManager = value.packageManager ?? 'npm';
  if (!PACKAGE_MANAGERS.has(packageManager)) {
    throw new ApplicationValidationError('invalid_package_manager', 'Node packageManager must be npm, pnpm or yarn');
  }
  const mode = value.mode ?? 'production';
  if (!RUNTIME_MODES.has(mode)) {
    throw new ApplicationValidationError('invalid_node_mode', 'Node mode must be production or development');
  }
  const documentRoot = normalizeRelativeBuildPath(value.documentRoot ?? '.', { allowDot: true });
  const startMode = value.startMode ?? value.start?.mode ?? 'node';
  if (!['node', 'npm'].includes(startMode)) {
    throw new ApplicationValidationError('invalid_start_mode', 'Node startMode must be node or npm');
  }

  const start = startMode === 'node'
    ? {
        mode: 'node',
        entryFile: normalizeRelativeBuildPath(value.entryFile ?? value.start?.entryFile ?? 'server.js'),
        script: null,
      }
    : {
        mode: 'npm',
        entryFile: null,
        script: normalizeScriptName(value.startScript ?? value.start?.script ?? 'start', 'startScript'),
      };

  const port = value.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ApplicationValidationError('invalid_node_port', 'Node application port must be between 1024 and 65535');
  }

  const healthPath = value.healthPath ?? '/health';
  if (typeof healthPath !== 'string' || healthPath.length > 200 || !HEALTH_PATH_PATTERN.test(healthPath) || healthPath.includes('//')) {
    throw new ApplicationValidationError('invalid_health_path', 'Node health path is invalid');
  }

  const healthTimeoutSeconds = value.healthTimeoutSeconds ?? 30;
  if (!Number.isInteger(healthTimeoutSeconds) || healthTimeoutSeconds < 5 || healthTimeoutSeconds > 120) {
    throw new ApplicationValidationError('invalid_health_timeout', 'Node health timeout must be between 5 and 120 seconds');
  }

  const restartPolicy = value.restartPolicy ?? 'on-failure';
  if (!['on-failure', 'always'].includes(restartPolicy)) {
    throw new ApplicationValidationError('invalid_restart_policy', 'Node restart policy must be on-failure or always');
  }

  return {
    nodeMajor,
    packageManager,
    installMode,
    buildScript,
    mode,
    documentRoot,
    start,
    port,
    healthPath,
    healthTimeoutSeconds,
    restartPolicy,
  };
}

function normalizeManagedNodeSpec(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError(code, message);
  }
  return {
    applicationId: assertUuid(value.applicationId, 'applicationId'),
    releaseId: assertUuid(value.releaseId, 'releaseId'),
    runtime: normalizeNodeRuntimeConfig(value.runtime),
  };
}

export function normalizeNodeApplicationSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_application_spec', 'Node application spec must be an object');
  }

  const branch = normalizeGitBranch(value.branch ?? 'main');
  return {
    applicationId: assertUuid(value.applicationId, 'applicationId'),
    deploymentId: assertUuid(value.deploymentId, 'deploymentId'),
    repositoryUrl: normalizeGithubRepositoryUrl(value.repositoryUrl),
    branch,
    gitTarget: normalizeGitDeploymentTarget(value.gitTarget, { defaultBranch: branch }),
    runtime: normalizeNodeRuntimeConfig(value.runtime),
    retention: Number.isInteger(value.retention) && value.retention >= 2 && value.retention <= 20 ? value.retention : 5,
  };
}

export function normalizeNodeRollbackSpec(value) {
  return {
    ...normalizeManagedNodeSpec(value, 'invalid_node_rollback', 'Node rollback spec must be an object'),
    currentReleaseId: assertUuid(value.currentReleaseId, 'currentReleaseId'),
  };
}

export function normalizeNodeRestartSpec(value) {
  return normalizeManagedNodeSpec(value, 'invalid_node_restart', 'Node restart spec must be an object');
}

export function normalizeNodeStatusSpec(value) {
  return normalizeManagedNodeSpec(value, 'invalid_node_status', 'Node status spec must be an object');
}

export function normalizeNodeProcessSpec(value) {
  const normalized = normalizeManagedNodeSpec(value, 'invalid_node_process', 'Node process spec must be an object');
  if (Object.keys(value).some((key) => !PROCESS_FIELDS.has(key))) {
    throw new ApplicationValidationError('invalid_node_process', 'Node process spec contains unsupported fields');
  }
  if (!PROCESS_ACTIONS.has(value.action)) {
    throw new ApplicationValidationError('invalid_node_process_action', 'Node process action must be enable, disable, start or stop');
  }
  return { ...normalized, action: value.action };
}

export const nodeApplicationInternals = Object.freeze({
  packageManagers: Object.freeze([...PACKAGE_MANAGERS]),
  runtimeModes: Object.freeze([...RUNTIME_MODES]),
  runtimeFields: Object.freeze([...RUNTIME_FIELDS]),
  processActions: Object.freeze([...PROCESS_ACTIONS]),
  processFields: Object.freeze([...PROCESS_FIELDS]),
});
