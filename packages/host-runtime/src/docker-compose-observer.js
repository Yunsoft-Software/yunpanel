import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { sanitizeLogMessage } from '@yunpanel/shared';

const DOCKER_PATHS = Object.freeze(['/usr/bin/docker', '/usr/local/bin/docker']);
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/i;
const CONTAINER_STATES = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);
const HEALTH_STATES = new Set(['starting', 'healthy', 'unhealthy']);
const MAX_CONTAINERS = 64;
const MAX_LOG_CONTAINERS = 16;
const MAX_LOG_TAIL = 500;
const MAX_LOG_BYTES = 512 * 1024;

export class DockerComposeObserverError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DockerComposeObserverError';
    this.code = code;
    this.status = status;
  }
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      ...options,
      encoding: 'utf8',
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) return reject(error);
      return resolve({ stdout, stderr });
    });
  });
}

async function findDockerPath(accessFn) {
  for (const candidate of DOCKER_PATHS) {
    try { await accessFn(candidate); return candidate; }
    catch { /* Continue through fixed executable allowlist. */ }
  }
  return null;
}

function projectName(value) {
  if (typeof value !== 'string' || !PROJECT_NAME_PATTERN.test(value)) {
    throw new DockerComposeObserverError('docker_compose_project_name_invalid', 'Docker Compose project name is invalid', 400);
  }
  return value;
}

function serviceName(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !SERVICE_NAME_PATTERN.test(value)) {
    throw new DockerComposeObserverError('docker_compose_service_name_invalid', 'Docker Compose service name is invalid', 400);
  }
  return value;
}

function logTail(value) {
  if (value === undefined || value === null) return 200;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LOG_TAIL) {
    throw new DockerComposeObserverError('docker_compose_log_tail_invalid', `Docker Compose log tail must be between 1 and ${MAX_LOG_TAIL}`, 400);
  }
  return value;
}

function safeText(value, maximum = 300) {
  if (typeof value !== 'string') return null;
  return sanitizeLogMessage(value).message.slice(0, maximum);
}

function parseContainerRows(output) {
  if (typeof output !== 'string') {
    throw new DockerComposeObserverError('docker_compose_container_output_invalid', 'Docker Compose container inventory is invalid');
  }
  const containers = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); }
    catch { throw new DockerComposeObserverError('docker_compose_container_output_invalid', 'Docker Compose container inventory is invalid'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.ID !== 'string' || !CONTAINER_ID_PATTERN.test(value.ID)) {
      throw new DockerComposeObserverError('docker_compose_container_output_invalid', 'Docker Compose container inventory is invalid');
    }
    containers.push(Object.freeze({
      id: value.ID.toLowerCase(),
      name: safeText(value.Names, 200),
      image: safeText(value.Image, 500),
      state: safeText(value.State, 40),
      statusText: safeText(value.Status, 500),
    }));
    if (containers.length > MAX_CONTAINERS) {
      throw new DockerComposeObserverError('docker_compose_container_limit_exceeded', 'Docker Compose project has too many containers');
    }
  }
  return containers.sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
}

function parseState(output) {
  let value;
  try { value = JSON.parse(output); }
  catch { throw new DockerComposeObserverError('docker_compose_state_output_invalid', 'Docker container state is invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DockerComposeObserverError('docker_compose_state_output_invalid', 'Docker container state is invalid');
  }
  const status = typeof value.Status === 'string' && CONTAINER_STATES.has(value.Status) ? value.Status : 'unknown';
  const health = value.Health && typeof value.Health === 'object' && !Array.isArray(value.Health)
    ? Object.freeze({
      status: typeof value.Health.Status === 'string' && HEALTH_STATES.has(value.Health.Status) ? value.Health.Status : 'unknown',
      failingStreak: Number.isSafeInteger(value.Health.FailingStreak) && value.Health.FailingStreak >= 0
        ? value.Health.FailingStreak : 0,
    })
    : null;
  return Object.freeze({
    status,
    running: value.Running === true,
    paused: value.Paused === true,
    restarting: value.Restarting === true,
    oomKilled: value.OOMKilled === true,
    dead: value.Dead === true,
    exitCode: Number.isSafeInteger(value.ExitCode) ? value.ExitCode : null,
    health,
  });
}

function aggregateStatus(containers) {
  if (containers.length === 0) return 'absent';
  if (containers.some((item) => item.runtime.dead || item.runtime.oomKilled || item.runtime.health?.status === 'unhealthy')) return 'degraded';
  if (containers.some((item) => item.runtime.restarting)) return 'restarting';
  if (containers.every((item) => !item.runtime.running)) return 'stopped';
  if (containers.some((item) => item.runtime.health?.status === 'starting')) return 'starting';
  if (containers.every((item) => item.runtime.running)) return 'running';
  return 'degraded';
}

function projectFilters(name, service) {
  const filters = ['--filter', `label=com.docker.compose.project=${name}`];
  if (service) filters.push('--filter', `label=com.docker.compose.service=${service}`);
  return filters;
}

export function createDockerComposeObserver({ accessFn = access, execFn = execFileText } = {}) {
  if (typeof accessFn !== 'function' || typeof execFn !== 'function') {
    throw new DockerComposeObserverError('docker_compose_observer_dependencies_invalid', 'Docker Compose observer dependencies are invalid', 500);
  }

  async function dockerPath() {
    const resolved = await findDockerPath(accessFn);
    if (!resolved) throw new DockerComposeObserverError('docker_compose_unavailable', 'Docker CLI is not installed on this host', 503);
    return resolved;
  }

  async function listContainers(name, service = null) {
    const executable = await dockerPath();
    let output;
    try {
      ({ stdout: output } = await execFn(executable, [
        'ps', '-a', '--no-trunc', ...projectFilters(name, service), '--format', '{{json .}}',
      ], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }));
    } catch {
      throw new DockerComposeObserverError('docker_compose_inspection_failed', 'Docker Compose container inventory could not be inspected', 503);
    }
    return { executable, containers: parseContainerRows(output) };
  }

  async function inspect({ projectName: requestedProjectName, service: requestedService = null } = {}) {
    const name = projectName(requestedProjectName);
    const service = serviceName(requestedService);
    const { executable, containers } = await listContainers(name, service);
    const detailed = [];
    for (const container of containers) {
      let output;
      try {
        ({ stdout: output } = await execFn(executable, [
          'inspect', '--format', '{{json .State}}', container.id,
        ], { timeout: 10_000, maxBuffer: 256 * 1024 }));
      } catch {
        throw new DockerComposeObserverError('docker_compose_inspection_failed', 'Docker container state could not be inspected', 503);
      }
      detailed.push(Object.freeze({ ...container, runtime: parseState(output.trim()) }));
    }
    return Object.freeze({
      version: 1,
      projectName: name,
      service,
      status: aggregateStatus(detailed),
      containerCount: detailed.length,
      containers: Object.freeze(detailed),
    });
  }

  async function logs({ projectName: requestedProjectName, service: requestedService = null, tail: requestedTail = 200 } = {}) {
    const name = projectName(requestedProjectName);
    const service = serviceName(requestedService);
    const tail = logTail(requestedTail);
    const { executable, containers } = await listContainers(name, service);
    const selected = containers.slice(0, MAX_LOG_CONTAINERS);
    let remainingBytes = MAX_LOG_BYTES;
    let truncated = containers.length > selected.length;
    const output = [];
    for (const container of selected) {
      let stdout = '';
      let stderr = '';
      try {
        ({ stdout, stderr } = await execFn(executable, [
          'logs', '--tail', String(tail), '--timestamps', container.id,
        ], { timeout: 10_000, maxBuffer: MAX_LOG_BYTES }));
      } catch {
        output.push(Object.freeze({ id: container.id, name: container.name, lines: Object.freeze([]), unavailable: true }));
        continue;
      }
      const lines = [];
      for (const rawLine of `${stdout ?? ''}\n${stderr ?? ''}`.split('\n')) {
        if (!rawLine) continue;
        const sanitized = sanitizeLogMessage(rawLine);
        const bytes = Buffer.byteLength(sanitized.message);
        if (bytes > remainingBytes) { truncated = true; break; }
        remainingBytes -= bytes;
        lines.push(sanitized.message);
        if (sanitized.truncated) truncated = true;
      }
      output.push(Object.freeze({ id: container.id, name: container.name, lines: Object.freeze(lines), unavailable: false }));
      if (remainingBytes <= 0) break;
    }
    return Object.freeze({
      version: 1,
      projectName: name,
      service,
      tail,
      containers: Object.freeze(output),
      truncated,
    });
  }

  return Object.freeze({ inspect, logs });
}

export const dockerComposeObserverInternals = Object.freeze({
  dockerPaths: DOCKER_PATHS,
  maxContainers: MAX_CONTAINERS,
  maxLogContainers: MAX_LOG_CONTAINERS,
  maxLogTail: MAX_LOG_TAIL,
  maxLogBytes: MAX_LOG_BYTES,
  findDockerPath,
  projectName,
  serviceName,
  logTail,
  parseContainerRows,
  parseState,
  aggregateStatus,
  projectFilters,
});
