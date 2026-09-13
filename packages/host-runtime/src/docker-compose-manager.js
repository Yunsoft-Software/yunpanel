import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDockerComposeValidator } from './docker-compose-validator.js';

const DEFAULT_ROOT = '/var/lib/yunpanel/docker/compose-runtime';
const DOCKER_PATHS = Object.freeze(['/usr/bin/docker', '/usr/local/bin/docker']);
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const REGISTRY_HOST_PATTERN = /^(?:localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;
const ACTIONS = new Map([
  ['build', ['build']],
  ['pull', ['pull']],
  ['start', ['up', '-d', '--no-build', '--remove-orphans']],
  ['stop', ['stop']],
  ['restart', ['restart']],
]);

export class DockerComposeManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DockerComposeManagerError';
    this.code = code;
  }
}

async function findDockerPath(accessFn) {
  for (const candidate of DOCKER_PATHS) {
    try { await accessFn(candidate); return candidate; }
    catch { /* Continue through fixed executable allowlist. */ }
  }
  return null;
}

function execFileSafe(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      ...options,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }, (error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

function normalizeEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DockerComposeManagerError('docker_compose_environment_invalid', 'Docker Compose environment is invalid');
  }
  const entries = Object.entries(value);
  if (entries.length > 256) throw new DockerComposeManagerError('docker_compose_environment_invalid', 'Docker Compose environment is too large');
  const output = {};
  for (const [key, raw] of entries) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || typeof raw !== 'string' || raw.includes('\u0000') || Buffer.byteLength(raw) > 64 * 1024) {
      throw new DockerComposeManagerError('docker_compose_environment_invalid', 'Docker Compose environment contains an invalid value');
    }
    output[key] = raw;
  }
  return output;
}

function normalizeCredentials(value) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new DockerComposeManagerError('docker_registry_credentials_invalid', 'Docker registry credentials are invalid');
  }
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !REGISTRY_HOST_PATTERN.test(item.registryHost)
      || typeof item.username !== 'string' || item.username.length < 1 || item.username.includes('\u0000')
      || typeof item.secret !== 'string' || item.secret.length < 1 || item.secret.includes('\u0000')
      || seen.has(item.registryHost)) {
      throw new DockerComposeManagerError('docker_registry_credentials_invalid', 'Docker registry credentials are invalid');
    }
    seen.add(item.registryHost);
    return { registryHost: item.registryHost, username: item.username, secret: item.secret };
  });
}

function runtimeInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.projectId !== 'string' || value.projectId.length < 8 || value.projectId.length > 128
    || typeof value.projectName !== 'string' || !PROJECT_NAME_PATTERN.test(value.projectName)
    || !Number.isSafeInteger(value.projectRevision) || value.projectRevision < 1
    || !Number.isSafeInteger(value.environmentRevision) || value.environmentRevision < 0
    || typeof value.composeSha256 !== 'string' || !SHA256_PATTERN.test(value.composeSha256)
    || typeof value.document !== 'string' || value.document.length < 1
    || createHash('sha256').update(value.document).digest('hex') !== value.composeSha256) {
    throw new DockerComposeManagerError('docker_compose_runtime_input_invalid', 'Docker Compose runtime input is invalid');
  }
  return {
    projectId: value.projectId,
    projectName: value.projectName,
    projectRevision: value.projectRevision,
    environmentRevision: value.environmentRevision,
    composeSha256: value.composeSha256,
    document: value.document,
    environment: normalizeEnvironment(value.environment),
    credentials: normalizeCredentials(value.credentials),
  };
}

function dockerConfig(credentials) {
  const auths = {};
  for (const credential of credentials) {
    auths[credential.registryHost] = {
      auth: Buffer.from(`${credential.username}:${credential.secret}`, 'utf8').toString('base64'),
    };
  }
  return JSON.stringify({ auths });
}

export function createDockerComposeManager({
  root = DEFAULT_ROOT,
  accessFn = access,
  execFn = execFileSafe,
  validateCompose = createDockerComposeValidator(),
  randomSuffix = () => randomBytes(8).toString('hex'),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof accessFn !== 'function'
    || typeof execFn !== 'function' || typeof validateCompose !== 'function' || typeof randomSuffix !== 'function') {
    throw new DockerComposeManagerError('docker_compose_manager_dependencies_invalid', 'Docker Compose manager dependencies are invalid');
  }

  async function execute(action, requestedInput) {
    const command = ACTIONS.get(action);
    if (!command) throw new DockerComposeManagerError('docker_compose_action_invalid', 'Docker Compose action is invalid');
    const input = runtimeInput(requestedInput);
    await validateCompose({
      projectName: input.projectName,
      document: input.document,
      environment: input.environment,
      interpolate: true,
    });
    const dockerPath = await findDockerPath(accessFn);
    if (!dockerPath) throw new DockerComposeManagerError('docker_compose_unavailable', 'Docker CLI is not installed on this host');

    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const directory = await mkdtemp(path.join(root, `.run-${randomSuffix()}-`));
    await chmod(directory, 0o700);
    const composePath = path.join(directory, 'compose.yaml');
    const dockerConfigDir = path.join(directory, 'docker-config');
    try {
      await mkdir(dockerConfigDir, { mode: 0o700 });
      await chmod(dockerConfigDir, 0o700);
      await writeFile(composePath, input.document, { encoding: 'utf8', mode: 0o600 });
      await chmod(composePath, 0o600);
      const configPath = path.join(dockerConfigDir, 'config.json');
      await writeFile(configPath, dockerConfig(input.credentials), { encoding: 'utf8', mode: 0o600 });
      await chmod(configPath, 0o600);
      try {
        await execFn(dockerPath, [
          'compose',
          '--project-name', input.projectName,
          '--project-directory', directory,
          '--env-file', '/dev/null',
          '-f', composePath,
          ...command,
        ], {
          cwd: directory,
          timeout: ['build', 'pull'].includes(action) ? 60 * 60 * 1000 : 10 * 60 * 1000,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: directory,
            LANG: 'C',
            LC_ALL: 'C',
            DOCKER_CONFIG: dockerConfigDir,
            COMPOSE_PROJECT_NAME: input.projectName,
            ...input.environment,
          },
        });
      } catch {
        throw new DockerComposeManagerError('docker_compose_command_failed', `Docker Compose ${action} command failed`);
      }
      return Object.freeze({
        version: 1,
        projectId: input.projectId,
        projectRevision: input.projectRevision,
        environmentRevision: input.environmentRevision,
        composeSha256: input.composeSha256,
        action,
        runtimeState: action === 'start' || action === 'restart' ? 'running' : action === 'stop' ? 'stopped' : null,
        executed: true,
        sideEffects: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return Object.freeze({
    build: (input) => execute('build', input),
    pull: (input) => execute('pull', input),
    start: (input) => execute('start', input),
    stop: (input) => execute('stop', input),
    restart: (input) => execute('restart', input),
  });
}

export const dockerComposeManagerInternals = Object.freeze({
  defaultRoot: DEFAULT_ROOT,
  actions: ACTIONS,
  findDockerPath,
  runtimeInput,
  normalizeEnvironment,
  normalizeCredentials,
  dockerConfig,
});
