import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ROOT = '/var/lib/yunpanel/docker/compose-validation';
const DOCKER_PATHS = Object.freeze(['/usr/bin/docker', '/usr/local/bin/docker']);
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export class DockerComposeValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DockerComposeValidationError';
    this.code = code;
  }
}

function projectName(value) {
  if (typeof value !== 'string' || !PROJECT_NAME_PATTERN.test(value)) {
    throw new DockerComposeValidationError('docker_compose_project_name_invalid', 'Docker Compose project name is invalid');
  }
  return value;
}

function composeDocument(value) {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\u0000')) {
    throw new DockerComposeValidationError('docker_compose_document_invalid', 'Docker Compose document is invalid');
  }
  const bytes = Buffer.byteLength(value);
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new DockerComposeValidationError('docker_compose_document_too_large', 'Docker Compose document exceeds the safe size limit');
  }
  return { document: value, bytes, sha256: createHash('sha256').update(value).digest('hex') };
}

function normalizeEnvironment(value) {
  if (value === undefined || value === null) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DockerComposeValidationError('docker_compose_environment_invalid', 'Docker Compose environment must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new DockerComposeValidationError('docker_compose_environment_too_large', 'Docker Compose environment has too many entries');
  }
  const normalized = {};
  for (const [key, rawValue] of entries) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || typeof rawValue !== 'string' || rawValue.includes('\u0000')
      || Buffer.byteLength(rawValue) > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new DockerComposeValidationError('docker_compose_environment_invalid', 'Docker Compose environment contains an invalid entry');
    }
    normalized[key] = rawValue;
  }
  return Object.freeze(normalized);
}

async function findDockerPath(accessFn) {
  for (const candidate of DOCKER_PATHS) {
    try {
      await accessFn(candidate);
      return candidate;
    } catch {
      // Continue through the fixed executable allowlist.
    }
  }
  return null;
}

function execFileText(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      ...options,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: MAX_CONFIG_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) return reject(error);
      return resolve(stdout);
    });
  });
}

function resourceNames(value, field) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DockerComposeValidationError('docker_compose_config_invalid', `Docker Compose ${field} config is invalid`);
  }
  const names = Object.keys(value);
  if (names.length > 128 || names.some((name) => !RESOURCE_NAME_PATTERN.test(name))) {
    throw new DockerComposeValidationError('docker_compose_config_invalid', `Docker Compose ${field} names are invalid`);
  }
  return names.sort();
}

export function summarizeDockerComposeConfig(value, { expectedProjectName, documentSha256, documentBytes } = {}) {
  const expected = projectName(expectedProjectName);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.services || typeof value.services !== 'object' || Array.isArray(value.services)) {
    throw new DockerComposeValidationError('docker_compose_config_invalid', 'Docker Compose normalized config is invalid');
  }
  if (value.name !== undefined && value.name !== expected) {
    throw new DockerComposeValidationError('docker_compose_project_name_mismatch', 'Docker Compose normalized project identity changed');
  }
  const serviceEntries = Object.entries(value.services);
  if (serviceEntries.length < 1 || serviceEntries.length > 64) {
    throw new DockerComposeValidationError('docker_compose_service_count_invalid', 'Docker Compose must define between 1 and 64 services');
  }
  const services = serviceEntries.map(([name, service]) => {
    if (!SERVICE_NAME_PATTERN.test(name) || !service || typeof service !== 'object' || Array.isArray(service)) {
      throw new DockerComposeValidationError('docker_compose_service_invalid', 'Docker Compose contains an invalid service');
    }
    return Object.freeze({
      name,
      imageConfigured: typeof service.image === 'string' && service.image.length > 0,
      buildConfigured: service.build !== undefined && service.build !== null,
    });
  }).sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    version: 1,
    projectName: expected,
    composeSha256: documentSha256,
    composeBytes: documentBytes,
    serviceCount: services.length,
    services: Object.freeze(services),
    networks: Object.freeze(resourceNames(value.networks, 'network')),
    volumes: Object.freeze(resourceNames(value.volumes, 'volume')),
    secretCount: resourceNames(value.secrets, 'secret').length,
    configCount: resourceNames(value.configs, 'config').length,
    validated: true,
    sideEffects: false,
  });
}

export function createDockerComposeValidator({
  root = DEFAULT_ROOT,
  accessFn = access,
  execFn = execFileText,
  randomSuffix = () => randomBytes(8).toString('hex'),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof accessFn !== 'function'
    || typeof execFn !== 'function' || typeof randomSuffix !== 'function') {
    throw new DockerComposeValidationError('docker_compose_validator_dependencies_invalid', 'Docker Compose validator dependencies are invalid');
  }

  return async function validateDockerCompose({ projectName: requestedProjectName, document: requestedDocument, environment = {} } = {}) {
    const name = projectName(requestedProjectName);
    const source = composeDocument(requestedDocument);
    const normalizedEnvironment = normalizeEnvironment(environment);
    const dockerPath = await findDockerPath(accessFn);
    if (!dockerPath) {
      throw new DockerComposeValidationError('docker_compose_unavailable', 'Docker CLI is not installed on this host');
    }

    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const directory = await mkdtemp(path.join(root, `.validate-${randomSuffix()}-`));
    await chmod(directory, 0o700);
    const composePath = path.join(directory, 'compose.yaml');
    try {
      await writeFile(composePath, source.document, { encoding: 'utf8', mode: 0o600 });
      await chmod(composePath, 0o600);
      let output;
      try {
        output = await execFn(dockerPath, [
          'compose',
          '--project-name', name,
          '--project-directory', directory,
          '--env-file', '/dev/null',
          '-f', composePath,
          'config',
          '--format', 'json',
        ], {
          cwd: directory,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: directory,
            LANG: 'C',
            LC_ALL: 'C',
            COMPOSE_PROJECT_NAME: name,
            ...normalizedEnvironment,
          },
        });
      } catch {
        throw new DockerComposeValidationError('docker_compose_validation_failed', 'Docker Compose configuration validation failed');
      }
      if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_CONFIG_BYTES) {
        throw new DockerComposeValidationError('docker_compose_config_invalid', 'Docker Compose normalized config output is invalid');
      }
      let parsed;
      try { parsed = JSON.parse(output); }
      catch { throw new DockerComposeValidationError('docker_compose_config_invalid', 'Docker Compose normalized config is invalid JSON'); }
      return summarizeDockerComposeConfig(parsed, {
        expectedProjectName: name,
        documentSha256: source.sha256,
        documentBytes: source.bytes,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export const dockerComposeValidatorInternals = Object.freeze({
  defaultRoot: DEFAULT_ROOT,
  dockerPaths: DOCKER_PATHS,
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxConfigBytes: MAX_CONFIG_BYTES,
  maxEnvironmentEntries: MAX_ENVIRONMENT_ENTRIES,
  projectName,
  composeDocument,
  normalizeEnvironment,
  findDockerPath,
});
