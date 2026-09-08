import {
  ApplicationValidationError,
  assertUuid,
  normalizeGithubRepositoryUrl,
  normalizeGitBranch,
  normalizeRelativeBuildPath,
} from './application.js';

const SCRIPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const HEALTH_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

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
  if (value.start !== undefined && (!value.start || typeof value.start !== 'object' || Array.isArray(value.start))) {
    throw new ApplicationValidationError('invalid_node_start', 'Node start config must be an object');
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
    installMode,
    buildScript,
    start,
    port,
    healthPath,
    healthTimeoutSeconds,
    restartPolicy,
  };
}

export function normalizeNodeApplicationSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_application_spec', 'Node application spec must be an object');
  }

  return {
    applicationId: assertUuid(value.applicationId, 'applicationId'),
    deploymentId: assertUuid(value.deploymentId, 'deploymentId'),
    repositoryUrl: normalizeGithubRepositoryUrl(value.repositoryUrl),
    branch: normalizeGitBranch(value.branch ?? 'main'),
    runtime: normalizeNodeRuntimeConfig(value.runtime),
    retention: Number.isInteger(value.retention) && value.retention >= 2 && value.retention <= 20 ? value.retention : 5,
  };
}

export function normalizeNodeRollbackSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_node_rollback', 'Node rollback spec must be an object');
  }

  return {
    applicationId: assertUuid(value.applicationId, 'applicationId'),
    releaseId: assertUuid(value.releaseId, 'releaseId'),
    runtime: normalizeNodeRuntimeConfig(value.runtime),
  };
}

export function normalizeNodeRestartSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_node_restart', 'Node restart spec must be an object');
  }

  return {
    applicationId: assertUuid(value.applicationId, 'applicationId'),
    releaseId: assertUuid(value.releaseId, 'releaseId'),
    runtime: normalizeNodeRuntimeConfig(value.runtime),
  };
}
