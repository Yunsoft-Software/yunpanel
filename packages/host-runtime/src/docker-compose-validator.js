import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isIP, SocketAddress } from 'node:net';
import path from 'node:path';

const DEFAULT_ROOT = '/var/lib/yunpanel/docker/compose-validation';
const DOCKER_PATHS = Object.freeze(['/usr/bin/docker', '/usr/local/bin/docker']);
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const MAX_SERVICE_PORTS = 64;
const MAX_SERVICE_MOUNTS = 128;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PORT_PROTOCOLS = new Set(['tcp', 'udp']);
const STORAGE_TYPES = new Set(['bind', 'tmpfs', 'volume']);

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
      // Continue through fixed executable allowlist.
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

function canonicalIp(value) {
  const family = isIP(value);
  if (!family) return null;
  try {
    return new SocketAddress({ address: value, family: family === 4 ? 'ipv4' : 'ipv6', port: 0 }).address;
  } catch {
    return null;
  }
}

function portNumber(value) {
  const number = typeof value === 'string' && /^(?:[1-9][0-9]{0,4})$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 1 && number <= 65535 ? number : null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function publishedPorts(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SERVICE_PORTS) {
    throw new DockerComposeValidationError('docker_compose_service_ports_invalid', 'Docker Compose service ports are invalid');
  }
  const output = [];
  const identities = new Set();
  for (const port of value) {
    if (!port || typeof port !== 'object' || Array.isArray(port)) {
      throw new DockerComposeValidationError('docker_compose_service_ports_invalid', 'Docker Compose service ports are invalid');
    }
    const targetPort = portNumber(port.target);
    if (!targetPort) throw new DockerComposeValidationError('docker_compose_service_ports_invalid', 'Docker Compose service target port is invalid');
    if (port.published === undefined || port.published === null || port.published === '') continue;
    const publishedPort = portNumber(port.published);
    const protocol = port.protocol ?? 'tcp';
    const hostIp = port.host_ip == null || port.host_ip === '' ? null : canonicalIp(port.host_ip);
    if (!publishedPort || !PORT_PROTOCOLS.has(protocol) || (port.host_ip != null && port.host_ip !== '' && hostIp === null)) {
      throw new DockerComposeValidationError('docker_compose_service_ports_invalid', 'Docker Compose published port is invalid');
    }
    const item = Object.freeze({ hostIp, publishedPort, targetPort, protocol });
    const identity = `${hostIp ?? '*'}:${publishedPort}/${protocol}`;
    if (identities.has(identity)) {
      throw new DockerComposeValidationError('docker_compose_service_ports_invalid', 'Docker Compose published port identities must be unique');
    }
    identities.add(identity);
    output.push(item);
  }
  return output.sort((left, right) => compareText(left.hostIp ?? '', right.hostIp ?? '')
    || left.publishedPort - right.publishedPort
    || left.targetPort - right.targetPort
    || compareText(left.protocol, right.protocol));
}

function safeStoragePath(value, { absolute = true } = {}) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value) && (!absolute || path.posix.isAbsolute(value));
}

function publicBindSource(source, projectDirectory) {
  if (!safeStoragePath(source) || typeof projectDirectory !== 'string' || !path.isAbsolute(projectDirectory)) {
    throw new DockerComposeValidationError('docker_compose_service_storage_invalid', 'Docker Compose bind mount source is invalid');
  }
  const root = path.resolve(projectDirectory);
  const resolved = path.resolve(source);
  const relative = path.relative(root, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    const normalized = relative === '' ? './' : `./${relative.split(path.sep).join('/')}`;
    return Object.freeze({ source: normalized, sourceScope: 'project' });
  }
  return Object.freeze({ source: resolved, sourceScope: 'host' });
}

function namedVolumeScope(source, volumeDefinitions, expectedProjectName) {
  if (!volumeDefinitions || typeof volumeDefinitions !== 'object' || Array.isArray(volumeDefinitions)
    || !Object.hasOwn(volumeDefinitions, source)) {
    throw new DockerComposeValidationError('docker_compose_service_storage_invalid', 'Docker Compose named volume definition is unavailable');
  }
  const definition = volumeDefinitions[source];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new DockerComposeValidationError('docker_compose_service_storage_invalid', 'Docker Compose named volume definition is invalid');
  }
  if (definition.external !== undefined && typeof definition.external !== 'boolean') {
    throw new DockerComposeValidationError('docker_compose_service_storage_invalid', 'Docker Compose named volume external state is invalid');
  }
  if (definition.name !== undefined
    && (typeof definition.name !== 'string' || !RESOURCE_NAME_PATTERN.test(definition.name))) {
    throw new DockerComposeValidationError('docker_compose_service_storage_invalid', 'Docker Compose named volume runtime name is invalid');
  }
  if (definition.external === true) return 'host';
  const defaultRuntimeName = `${expectedProjectName}_${source}`;
  if (definition.name !== undefined && definition.name !== defaultRuntimeName) return 'host';
  return 'project';
}

function namedNetworkScope(source, networkDefinitions, expectedProjectName) {
  if (!networkDefinitions || typeof networkDefinitions !== 'object' || Array.isArray(networkDefinitions)) {
    throw new DockerComposeValidationError('docker_compose_service_network_invalid', 'Docker Compose network definition is invalid');
  }
  if (!Object.hasOwn(networkDefinitions, source)) {
    if (source === 'default') return 'project';
    throw new DockerComposeValidationError('docker_compose_service_network_invalid', 'Docker Compose network definition is unavailable');
  }
  const definition = networkDefinitions[source];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new DockerComposeValidationError('docker_compose_service_network_invalid', 'Docker Compose network definition is invalid');
  }
  if (definition.external !== undefined && typeof definition.external !== 'boolean') {
    throw new DockerComposeValidationError('docker_compose_service_network_invalid', 'Docker Compose network external state is invalid');
  }
  if (definition.name !== undefined
    && (typeof definition.name !== 'string' || !RESOURCE_NAME_PATTERN.test(definition.name))) {
    throw new DockerComposeValidationError('docker_compose_service_network_invalid', 'Docker Compose network runtime name is invalid');
  }
  if (definition.external === true) return 'host';
  const defaultRuntimeName = `${expectedProjectName}_${source}`;
  if (definition.name !== undefined && definition.name !== defaultRuntimeName) return 'host';
  return 'project';
}

function storageMounts(value, { projectDirectory = null, volumeDefinitions = {}, expectedProjectName } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SERVICE_MOUNTS) {
    throw new DockerComposeValidationError('docker_compose_service_storage_invalid', 'Docker Compose service storage mounts are invalid');
  }
  const output = [];
  const targets = new Set();
  for (const mount of value) {
    if (!mount || typeof mount !== 'object' || Array.isArray(mount)
      || typeof mount.type !== 'string' || !STORAGE_TYPES.has(mount.type)
      || !safeStoragePath(mount.target)
      || (mount.read_only !== undefined && typeof mount.read_only !== 'boolean')
      || targets.has(mount.target)) {
      throw new DockerComposeValidationError('docker_compose_service_storage_invalid', 'Docker Compose service storage mount is invalid');
    }
    targets.add(mount.target);
    const readOnly = mount.read_only === true;
    if (mount.type === 'bind') {
      const bind = publicBindSource(mount.source, projectDirectory);
      output.push(Object.freeze({
        kind: 'bind',
        source: bind.source,
        sourceScope: bind.sourceScope,
        target: mount.target,
        readOnly,
      }));
      continue;
    }
    if (mount.type === 'volume') {
      if (mount.source === undefined || mount.source === null || mount.source === '') {
        output.push(Object.freeze({ kind: 'ephemeral', source: null, sourceScope: null, target: mount.target, readOnly }));
        continue;
      }
      if (typeof mount.source !== 'string' || !RESOURCE_NAME_PATTERN.test(mount.source)) {
        throw new DockerComposeValidationError('docker_compose_service_storage_invalid', 'Docker Compose named volume source is invalid');
      }
      output.push(Object.freeze({
        kind: 'named_volume',
        source: mount.source,
        sourceScope: namedVolumeScope(mount.source, volumeDefinitions, expectedProjectName),
        target: mount.target,
        readOnly,
      }));
      continue;
    }
    if (mount.source !== undefined && mount.source !== null && mount.source !== '') {
      throw new DockerComposeValidationError('docker_compose_service_storage_invalid', 'Docker Compose tmpfs mount source is invalid');
    }
    output.push(Object.freeze({ kind: 'ephemeral', source: null, sourceScope: null, target: mount.target, readOnly }));
  }
  return output.sort((left, right) => left.target.localeCompare(right.target)
    || left.kind.localeCompare(right.kind)
    || String(left.source ?? '').localeCompare(String(right.source ?? '')));
}

export function summarizeDockerComposeConfig(value, {
  expectedProjectName,
  documentSha256,
  documentBytes,
  projectDirectory = null,
} = {}) {
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
  const volumeDefinitions = value.volumes ?? {};
  const services = serviceEntries.map(([name, service]) => {
    if (!SERVICE_NAME_PATTERN.test(name) || !service || typeof service !== 'object' || Array.isArray(service)) {
      throw new DockerComposeValidationError('docker_compose_service_invalid', 'Docker Compose contains an invalid service');
    }
    if (service.network_mode !== undefined) {
      if (typeof service.network_mode !== 'string'
        || service.network_mode === 'host'
        || service.network_mode.startsWith('container:')
        || service.network_mode.startsWith('service:')) {
        throw new DockerComposeValidationError('docker_compose_service_network_invalid', 'Docker Compose service network mode must be isolated');
      }
    }
    return Object.freeze({
      name,
      imageConfigured: typeof service.image === 'string' && service.image.length > 0,
      buildConfigured: service.build !== undefined && service.build !== null,
      publishedPorts: Object.freeze(publishedPorts(service.ports)),
      storageMounts: Object.freeze(storageMounts(service.volumes, {
        projectDirectory,
        volumeDefinitions,
        expectedProjectName: expected,
      })),
    });
  }).sort((left, right) => left.name.localeCompare(right.name));
  const networkDefinitions = value.networks ?? {};
  const networkNames = resourceNames(value.networks, 'network');
  const networkDetails = networkNames.map((networkName) => Object.freeze({
    name: networkName,
    scope: namedNetworkScope(networkName, networkDefinitions, expected),
  }));
  return Object.freeze({
    version: 1,
    projectName: expected,
    composeSha256: documentSha256,
    composeBytes: documentBytes,
    serviceCount: services.length,
    services: Object.freeze(services),
    networks: Object.freeze(networkNames),
    networkDetails: Object.freeze(networkDetails),
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

  return async function validateDockerCompose({
    projectName: requestedProjectName,
    document: requestedDocument,
    environment = {},
    interpolate = true,
  } = {}) {
    const name = projectName(requestedProjectName);
    const source = composeDocument(requestedDocument);
    const normalizedEnvironment = normalizeEnvironment(environment);
    if (typeof interpolate !== 'boolean') {
      throw new DockerComposeValidationError('docker_compose_validation_mode_invalid', 'Docker Compose validation mode is invalid');
    }
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
        const configArgs = ['config'];
        if (!interpolate) configArgs.push('--no-interpolate');
        configArgs.push('--format', 'json');
        output = await execFn(dockerPath, [
          'compose',
          '--project-name', name,
          '--project-directory', directory,
          '--env-file', '/dev/null',
          '-f', composePath,
          ...configArgs,
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
        projectDirectory: directory,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export const dockerComposeValidatorInternals = Object.freeze({
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxConfigBytes: MAX_CONFIG_BYTES,
  maxEnvironmentEntries: MAX_ENVIRONMENT_ENTRIES,
  maxEnvironmentValueBytes: MAX_ENVIRONMENT_VALUE_BYTES,
  maxServicePorts: MAX_SERVICE_PORTS,
  maxServiceMounts: MAX_SERVICE_MOUNTS,
  projectName,
  composeDocument,
  normalizeEnvironment,
  findDockerPath,
  publishedPorts,
  publicBindSource,
  namedVolumeScope,
  namedNetworkScope,
  storageMounts,
});
