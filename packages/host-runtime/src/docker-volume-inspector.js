import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DOCKER_PATHS = Object.freeze(['/usr/bin/docker', '/usr/local/bin/docker']);
const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const MAX_OUTPUT_BYTES = 64 * 1024;

export class DockerVolumeInspectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DockerVolumeInspectorError';
    this.code = code;
  }
}

async function findDocker(accessFn) {
  for (const candidate of DOCKER_PATHS) {
    try { await accessFn(candidate); return candidate; }
    catch { /* Continue fixed allowlist. */ }
  }
  return null;
}

function defaultRun(file, args) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    windowsHide: true,
  });
}

function normalizeInspect(value, expectedName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.Name !== expectedName
    || value.Driver !== 'local'
    || (value.Scope !== undefined && value.Scope !== 'local')
    || typeof value.Mountpoint !== 'string' || !path.isAbsolute(value.Mountpoint)
    || value.Mountpoint.length > 4096 || /[\u0000-\u001f\u007f]/.test(value.Mountpoint)) {
    throw new DockerVolumeInspectorError('docker_volume_state_invalid', 'Docker volume state is invalid');
  }
  const options = value.Options ?? null;
  if (options !== null && (!options || typeof options !== 'object' || Array.isArray(options))) {
    throw new DockerVolumeInspectorError('docker_volume_state_invalid', 'Docker volume options are invalid');
  }
  if (options && Object.keys(options).length > 0) {
    throw new DockerVolumeInspectorError(
      'docker_volume_options_unsupported',
      'Docker volume with custom driver options is not eligible for managed backup',
    );
  }
  return Object.freeze({
    name: expectedName,
    driver: 'local',
    mountpoint: path.resolve(value.Mountpoint),
  });
}

export function createDockerVolumeInspector({
  accessFn = access,
  run = defaultRun,
} = {}) {
  if (typeof accessFn !== 'function' || typeof run !== 'function') {
    throw new DockerVolumeInspectorError('docker_volume_inspector_dependencies_invalid', 'Docker volume inspector dependencies are invalid');
  }

  return async function inspectDockerVolume(volumeName) {
    if (typeof volumeName !== 'string' || !VOLUME_NAME_PATTERN.test(volumeName)) {
      throw new DockerVolumeInspectorError('docker_volume_name_invalid', 'Docker volume name is invalid');
    }
    const dockerPath = await findDocker(accessFn);
    if (!dockerPath) throw new DockerVolumeInspectorError('docker_unavailable', 'Docker CLI is not installed on this host');
    let stdout;
    try {
      ({ stdout } = await run(dockerPath, ['volume', 'inspect', '--format', '{{json .}}', volumeName]));
    } catch {
      throw new DockerVolumeInspectorError('docker_volume_inspect_failed', 'Docker volume could not be inspected');
    }
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
      throw new DockerVolumeInspectorError('docker_volume_state_invalid', 'Docker volume inspection output is invalid');
    }
    let parsed;
    try { parsed = JSON.parse(stdout.trim()); }
    catch { throw new DockerVolumeInspectorError('docker_volume_state_invalid', 'Docker volume inspection output is invalid'); }
    return normalizeInspect(parsed, volumeName);
  };
}

export const dockerVolumeInspectorInternals = Object.freeze({
  dockerPaths: DOCKER_PATHS,
  volumeNamePattern: VOLUME_NAME_PATTERN,
  findDocker,
  normalizeInspect,
});
