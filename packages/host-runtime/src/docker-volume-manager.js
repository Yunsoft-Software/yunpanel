import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const ALLOWED_DOCKER_PATHS = Object.freeze(['/usr/bin/docker', '/usr/local/bin/docker']);
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const VOLUME_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CONTAINERS = 128;
const MAX_BUFFER = 512 * 1024;
const TIMEOUT_MS = 15_000;
const DOCKER_LOCAL_SOCKET = 'unix:///var/run/docker.sock';
const CLEAN_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  DOCKER_HOST: DOCKER_LOCAL_SOCKET,
  DOCKER_CONFIG: '/nonexistent',
});

export class DockerVolumeManagerError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DockerVolumeManagerError';
    this.code = code;
    this.status = status;
  }
}

function assertSafeVolumeName(value) {
  if (typeof value !== 'string' || !VOLUME_NAME_PATTERN.test(value)) {
    throw new DockerVolumeManagerError('docker_volume_name_invalid', 'Docker volume name is invalid', 400);
  }
  return value;
}

function assertOwnedVolumeIdentity(projectName, volumeKey, volumeName) {
  if (typeof projectName !== 'string' || !PROJECT_NAME_PATTERN.test(projectName)) {
    throw new DockerVolumeManagerError('docker_volume_project_invalid', 'Docker Compose project name is invalid', 400);
  }
  if (typeof volumeKey !== 'string' || !VOLUME_KEY_PATTERN.test(volumeKey)) {
    throw new DockerVolumeManagerError('docker_volume_key_invalid', 'Docker Compose volume key is invalid', 400);
  }
  const normalizedName = assertSafeVolumeName(volumeName);
  if (normalizedName !== `${projectName}_${volumeKey}`) {
    throw new DockerVolumeManagerError(
      'docker_volume_identity_mismatch',
      'Docker volume name does not match the Compose project volume identity',
      409,
    );
  }
  return { projectName, volumeKey, volumeName: normalizedName };
}

function sanitizeText(value, maxLength = 256) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function normalizeLabels(value) {
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DockerVolumeManagerError('docker_volume_inspect_invalid', 'Docker volume label metadata is invalid', 503);
  }
  const entries = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || typeof raw !== 'string') {
      throw new DockerVolumeManagerError('docker_volume_inspect_invalid', 'Docker volume label metadata is invalid', 503);
    }
    entries[key] = raw;
  }
  return Object.freeze(entries);
}

function normalizeOptions(value) {
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DockerVolumeManagerError('docker_volume_inspect_invalid', 'Docker volume options metadata is invalid', 503);
  }
  return Object.freeze({ ...value });
}

export function computeVolumeFingerprint({
  name,
  driver,
  scope,
  mountpoint,
  createdAt,
  composeProject,
  composeVolume,
}) {
  if (typeof name !== 'string' || !name
    || typeof driver !== 'string' || !driver
    || typeof scope !== 'string' || !scope
    || typeof mountpoint !== 'string' || !mountpoint
    || typeof createdAt !== 'string' || !createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new DockerVolumeManagerError(
      'docker_volume_identity_incomplete',
      'Docker volume identity requires verified scope and creation timestamp',
      409,
    );
  }
  return createHash('sha256')
    .update(JSON.stringify({
      version: 1,
      name,
      driver,
      scope,
      mountpoint,
      createdAt,
      composeProject,
      composeVolume,
    }))
    .digest('hex');
}

export function normalizeVolumeInspect(raw, expectedName) {
  const safeName = assertSafeVolumeName(expectedName);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DockerVolumeManagerError('docker_volume_inspect_invalid', 'Docker volume inspection returned invalid metadata', 503);
  }
  if (raw.Name !== safeName) {
    throw new DockerVolumeManagerError('docker_volume_name_mismatch', 'Docker volume inspection returned a different volume', 409);
  }
  const driver = typeof raw.Driver === 'string' && raw.Driver.length > 0 ? raw.Driver : null;
  if (!driver) {
    throw new DockerVolumeManagerError('docker_volume_inspect_invalid', 'Docker volume driver metadata is missing', 503);
  }
  const scope = typeof raw.Scope === 'string' && raw.Scope.trim().length > 0 ? sanitizeText(raw.Scope, 64) : null;
  if (typeof raw.Mountpoint !== 'string' || !path.posix.isAbsolute(raw.Mountpoint)
    || raw.Mountpoint.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw.Mountpoint)) {
    throw new DockerVolumeManagerError('docker_volume_mountpoint_invalid', 'Docker volume mountpoint is invalid', 503);
  }
  const mountpoint = path.posix.normalize(raw.Mountpoint);
  if (!path.posix.isAbsolute(mountpoint) || mountpoint === '/') {
    throw new DockerVolumeManagerError('docker_volume_mountpoint_invalid', 'Docker volume mountpoint is unsafe', 503);
  }
  const options = normalizeOptions(raw.Options);
  const labels = normalizeLabels(raw.Labels);
  const rawCreatedAt = typeof raw.CreatedAt === 'string' ? sanitizeText(raw.CreatedAt, 128) : '';
  const createdAt = rawCreatedAt.length > 0 && Number.isFinite(Date.parse(rawCreatedAt)) ? rawCreatedAt : null;
  const composeProject = Object.hasOwn(labels, 'com.docker.compose.project') ? labels['com.docker.compose.project'] : null;
  const composeVolume = Object.hasOwn(labels, 'com.docker.compose.volume') ? labels['com.docker.compose.volume'] : null;
  const fingerprint = scope && createdAt
    ? computeVolumeFingerprint({
      name: safeName,
      driver,
      scope,
      mountpoint,
      createdAt,
      composeProject,
      composeVolume,
    })
    : null;

  return Object.freeze({
    present: true,
    name: safeName,
    driver,
    scope,
    mountpoint,
    options,
    hasOptions: Object.keys(options).length > 0,
    createdAt,
    labels,
    composeProject,
    composeVolume,
    fingerprint,
  });
}

export function parseVolumeContainersOutput(stdout, expectedVolumeName) {
  const volumeName = assertSafeVolumeName(expectedVolumeName);
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > MAX_CONTAINERS) {
    throw new DockerVolumeManagerError('docker_volume_usage_check_failed', 'Too many containers attached to Docker volume', 503);
  }
  const containers = lines.map((line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new DockerVolumeManagerError('docker_volume_usage_check_failed', 'Docker volume container usage output is invalid', 503);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DockerVolumeManagerError('docker_volume_usage_check_failed', 'Docker volume container usage output is invalid', 503);
    }
    const id = sanitizeText(parsed.ID ?? parsed.Id ?? '', 128);
    const name = sanitizeText(parsed.Names ?? parsed.Name ?? '', 128).replace(/^\//, '');
    const state = sanitizeText(parsed.State ?? '', 64).toLowerCase() || 'unknown';
    const status = sanitizeText(parsed.Status ?? '', 128);
    if (!id) {
      throw new DockerVolumeManagerError('docker_volume_usage_check_failed', 'Docker volume container identity is missing', 503);
    }
    return Object.freeze({ id, name, state, status });
  });
  return Object.freeze({
    volumeName,
    containerCount: containers.length,
    containers: Object.freeze(containers),
  });
}

export function assertVolumeDeletableMetadata(detail, { projectName, volumeKey, expectedFingerprint = null } = {}) {
  if (!detail || detail.present !== true) {
    throw new DockerVolumeManagerError('docker_volume_not_found', 'Docker volume was not found on the host', 404);
  }
  if (detail.driver !== 'local') {
    throw new DockerVolumeManagerError(
      'docker_volume_driver_unsupported',
      'Only local Docker volumes can be deleted through this operation',
      409,
    );
  }
  if (detail.scope !== 'local') {
    throw new DockerVolumeManagerError(
      detail.scope === null ? 'docker_volume_identity_incomplete' : 'docker_volume_driver_unsupported',
      detail.scope === null
        ? 'Docker volume scope metadata is missing and cannot be verified as local'
        : 'Only local-scope Docker volumes can be deleted through this operation',
      409,
    );
  }
  if (!detail.createdAt || !Number.isFinite(Date.parse(detail.createdAt)) || !detail.fingerprint) {
    throw new DockerVolumeManagerError(
      'docker_volume_identity_incomplete',
      'Docker volume creation timestamp is missing or invalid',
      409,
    );
  }
  if (detail.hasOptions || Object.keys(detail.options ?? {}).length > 0) {
    throw new DockerVolumeManagerError(
      'docker_volume_options_unsupported',
      'Docker volumes with custom driver options cannot be deleted through this operation',
      409,
    );
  }
  if (detail.composeProject !== projectName || detail.composeVolume !== volumeKey) {
    throw new DockerVolumeManagerError(
      'docker_volume_ownership_unverified',
      'Docker volume Compose ownership labels do not match the selected project and volume',
      409,
    );
  }
  if (expectedFingerprint !== null && detail.fingerprint !== expectedFingerprint) {
    throw new DockerVolumeManagerError(
      'docker_volume_preview_stale',
      'Docker volume state changed after preview; request a new preview',
      409,
    );
  }
  return detail;
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: CLEAN_ENV,
      shell: false,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: stdout ?? '', stderr: stderr ?? '' }));
        return;
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function isMissingVolumeError(error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`.toLowerCase();
  return text.includes('no such volume');
}

export function createDockerVolumeManager({
  dockerPath = null,
  accessFn = access,
  execFn = execFileText,
} = {}) {
  if (dockerPath !== null && !ALLOWED_DOCKER_PATHS.includes(dockerPath)) {
    throw new DockerVolumeManagerError('docker_binary_invalid', 'Docker executable path is not allowed', 500);
  }
  if (typeof accessFn !== 'function' || typeof execFn !== 'function') {
    throw new DockerVolumeManagerError('docker_volume_manager_dependencies_invalid', 'Docker volume manager dependencies are invalid', 500);
  }

  async function resolveDockerPath() {
    if (dockerPath) {
      try {
        await accessFn(dockerPath, fsConstants.X_OK);
        return dockerPath;
      } catch {
        throw new DockerVolumeManagerError('docker_unavailable', 'Docker engine CLI is unavailable on this host', 503);
      }
    }
    for (const candidate of ALLOWED_DOCKER_PATHS) {
      try {
        await accessFn(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // continue checking allowlisted paths
      }
    }
    throw new DockerVolumeManagerError('docker_unavailable', 'Docker engine CLI is unavailable on this host', 503);
  }

  async function inspectVolumeDetail(volumeName) {
    const safeName = assertSafeVolumeName(volumeName);
    const binary = await resolveDockerPath();
    let result;
    try {
      result = await execFn(binary, ['--host', DOCKER_LOCAL_SOCKET, 'volume', 'inspect', '--format', '{{json .}}', safeName]);
    } catch (error) {
      if (isMissingVolumeError(error)) {
        return Object.freeze({ present: false, name: safeName });
      }
      throw new DockerVolumeManagerError('docker_volume_inspect_failed', 'Docker volume inspection failed', 503);
    }
    let parsed;
    try {
      parsed = JSON.parse(String(result?.stdout ?? '').trim());
    } catch {
      throw new DockerVolumeManagerError('docker_volume_inspect_invalid', 'Docker volume inspection output is invalid', 503);
    }
    return normalizeVolumeInspect(parsed, safeName);
  }

  async function listVolumeContainers(volumeName) {
    const safeName = assertSafeVolumeName(volumeName);
    const binary = await resolveDockerPath();
    let result;
    try {
      result = await execFn(binary, ['--host', DOCKER_LOCAL_SOCKET, 'ps', '-a', '--no-trunc', '--filter', `volume=${safeName}`, '--format', '{{json .}}']);
    } catch {
      throw new DockerVolumeManagerError('docker_volume_usage_check_failed', 'Docker volume container usage inspection failed', 503);
    }
    return parseVolumeContainersOutput(result?.stdout ?? '', safeName);
  }

  async function deleteVolume({ projectName, volumeKey, volumeName, expectedFingerprint } = {}) {
    const identity = assertOwnedVolumeIdentity(projectName, volumeKey, volumeName);
    if (typeof expectedFingerprint !== 'string' || !SHA256_PATTERN.test(expectedFingerprint)) {
      throw new DockerVolumeManagerError('docker_volume_fingerprint_invalid', 'A verified Docker volume fingerprint is required', 400);
    }
    const detail = await inspectVolumeDetail(identity.volumeName);
    assertVolumeDeletableMetadata(detail, {
      projectName: identity.projectName,
      volumeKey: identity.volumeKey,
      expectedFingerprint,
    });
    const usage = await listVolumeContainers(identity.volumeName);
    if (usage.containerCount > 0) {
      throw new DockerVolumeManagerError(
        'docker_volume_in_use',
        `Docker volume is still attached to ${usage.containerCount} container(s), including stopped containers`,
        409,
      );
    }
    const binary = await resolveDockerPath();
    try {
      await execFn(binary, ['--host', DOCKER_LOCAL_SOCKET, 'volume', 'rm', identity.volumeName]);
    } catch (error) {
      const stderr = String(error?.stderr ?? '').toLowerCase();
      if (stderr.includes('in use')) {
        throw new DockerVolumeManagerError('docker_volume_in_use', 'Docker volume is in use by a container', 409);
      }
      if (isMissingVolumeError(error)) {
        throw new DockerVolumeManagerError('docker_volume_not_found', 'Docker volume was already removed before deletion', 404);
      }
      throw new DockerVolumeManagerError('docker_volume_delete_failed', 'Docker volume deletion failed on the host', 500);
    }
    const after = await inspectVolumeDetail(identity.volumeName);
    if (after.present !== false) {
      throw new DockerVolumeManagerError('docker_volume_delete_unverified', 'Docker volume still exists after removal', 500);
    }
    return Object.freeze({
      version: 1,
      projectName: identity.projectName,
      volumeKey: identity.volumeKey,
      volumeName: identity.volumeName,
      volumeFingerprint: expectedFingerprint,
      deleted: true,
      sideEffects: true,
    });
  }

  return Object.freeze({
    inspectVolumeDetail,
    listVolumeContainers,
    deleteVolume,
  });
}

export const dockerVolumeManagerInternals = Object.freeze({
  allowedDockerPaths: ALLOWED_DOCKER_PATHS,
  assertSafeVolumeName,
  assertOwnedVolumeIdentity,
  computeVolumeFingerprint,
  normalizeVolumeInspect,
  parseVolumeContainersOutput,
  assertVolumeDeletableMetadata,
  isMissingVolumeError,
});
