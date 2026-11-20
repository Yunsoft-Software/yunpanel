import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { dockerComposeManagerInternals } from './docker-compose-manager.js';

const DOCKER_PATHS = Object.freeze(['/usr/bin/docker', '/usr/local/bin/docker']);
const DOCKER_LOCAL_SOCKET = 'unix:///var/run/docker.sock';
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SHELLS = Object.freeze(['/bin/bash', '/bin/sh']);
const PROBE_COMMAND = 'printf "%s:%s:" "$(id -u)" "$(id -g)"; if [ -x /bin/bash ]; then printf "/bin/bash"; elif [ -x /bin/sh ]; then printf "/bin/sh"; fi';

const FORBIDDEN_CAPABILITIES = Object.freeze(new Set([
  'ALL',
  'SYS_ADMIN',
  'SYS_PTRACE',
  'SYS_MODULE',
  'SYS_RAWIO',
  'SYS_BOOT',
  'SYS_CHROOT',
  'DAC_OVERRIDE',
  'DAC_READ_SEARCH',
  'NET_ADMIN',
  'BPF',
  'PERFMON',
  'CHECKPOINT_RESTORE',
  'MKNOD',
  'MAC_ADMIN',
  'MAC_OVERRIDE',
]));

const FORBIDDEN_SECURITY_OPTS = Object.freeze(new Set([
  'seccomp=unconfined',
  'seccomp:unconfined',
  'apparmor=unconfined',
  'apparmor:unconfined',
  'label=disable',
  'label:disable',
  'systempaths=unconfined',
  'systempaths:unconfined',
  'no-new-privileges=false',
  'no-new-privileges:false',
]));

const FORBIDDEN_SOCKET_BASENAMES = Object.freeze([
  'docker.sock',
  'containerd.sock',
  'podman.sock',
  'crio.sock',
]);

const SENSITIVE_HOST_ROOTS = Object.freeze([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/run',
  '/var/lib/docker',
  '/var/lib/containerd',
  '/var/lib/yunpanel',
]);

const REASON_MESSAGES = Object.freeze({
  container_console_not_found: 'Konteyner bulunamadı.',
  container_console_ownership_mismatch: 'Konteyner bu Compose projesine ait değil.',
  container_console_not_running: 'Konsol yalnız çalışan konteynerler için açılabilir.',
  container_console_privileged_forbidden: 'Ayrıcalıklı konteynerler için konsol erişimi kapalıdır.',
  container_console_unsafe_capability_forbidden: 'Yüksek yetkili Linux capability tanımlı konteynerler için konsol kapalıdır.',
  container_console_unsafe_security_opt_forbidden: 'Güvenlik profili devre dışı bırakılmış konteynerler için konsol kapalıdır.',
  container_console_host_device_forbidden: 'Host cihazı bağlı konteynerler için konsol kapalıdır.',
  container_console_host_namespace_forbidden: 'Host veya paylaşımlı namespace kullanan konteynerler için konsol kapalıdır.',
  container_console_unsafe_mount_forbidden: 'Hassas host yolu veya Docker soketi bağlı konteynerler için konsol kapalıdır.',
  container_console_root_user_forbidden: 'Root kullanıcısıyla çalışan konteynerlerde konsol erişimi güvenlik nedeniyle kapalıdır.',
  container_console_shell_unavailable: 'Konteyner içinde desteklenen bir kabuk bulunamadı.',
  container_console_cwd_invalid: 'Konteyner çalışma dizini doğrulanamadı.',
});

export class DockerContainerConsoleInspectorError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DockerContainerConsoleInspectorError';
    this.code = code;
    this.status = status;
  }
}

function execFileSafe(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      env: Object.freeze({
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        DOCKER_HOST: DOCKER_LOCAL_SOCKET,
        DOCKER_CONFIG: '/nonexistent',
      }),
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function findDockerPath(accessFn) {
  for (const candidate of DOCKER_PATHS) {
    try {
      await accessFn(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* Continue through fixed executable allowlist. */ }
  }
  return null;
}

function normalizePosixPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function pathMatchesRoot(targetPath, rootPath) {
  if (rootPath === '/') return targetPath === '/';
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}/`);
}

function isSensitiveHostBind(sourcePath, expectedWorkingDir) {
  const normalized = normalizePosixPath(sourcePath);
  if (!normalized) return true;
  if (expectedWorkingDir && pathMatchesRoot(normalized, expectedWorkingDir)) {
    return false;
  }
  return SENSITIVE_HOST_ROOTS.some((root) => pathMatchesRoot(normalized, root));
}

function touchesContainerSocket(value) {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return FORBIDDEN_SOCKET_BASENAMES.some((name) => lower === `/${name}` || lower.endsWith(`/${name}`) || lower.includes(`/${name}/`));
}

function assertNonRootUserSpec(rawUser) {
  if (typeof rawUser !== 'string') {
    throw new DockerContainerConsoleInspectorError(
      'container_console_root_user_forbidden',
      REASON_MESSAGES.container_console_root_user_forbidden,
      409,
    );
  }
  const trimmed = rawUser.trim();
  if (!trimmed || trimmed.length > 128 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_root_user_forbidden',
      REASON_MESSAGES.container_console_root_user_forbidden,
      409,
    );
  }
  const parts = trimmed.split(':');
  if (parts.length > 2) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_root_user_forbidden',
      REASON_MESSAGES.container_console_root_user_forbidden,
      409,
    );
  }
  const [userPart, groupPart] = parts;
  if (!userPart || userPart.toLowerCase() === 'root' || /^0+$/.test(userPart)) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_root_user_forbidden',
      REASON_MESSAGES.container_console_root_user_forbidden,
      409,
    );
  }
  if (groupPart !== undefined && (!groupPart || groupPart.toLowerCase() === 'root' || /^0+$/.test(groupPart))) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_root_user_forbidden',
      REASON_MESSAGES.container_console_root_user_forbidden,
      409,
    );
  }
  return trimmed;
}

function normalizeWorkingDir(rawWorkingDir) {
  if (rawWorkingDir === undefined || rawWorkingDir === null || rawWorkingDir === '') return '/';
  if (typeof rawWorkingDir !== 'string' || rawWorkingDir.length > 256 || !rawWorkingDir.startsWith('/')
    || /[\u0000-\u001f\u007f]/.test(rawWorkingDir)) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_cwd_invalid',
      REASON_MESSAGES.container_console_cwd_invalid,
      409,
    );
  }
  return path.posix.normalize(rawWorkingDir);
}

function normalizeContainerName(rawName, containerId) {
  if (typeof rawName === 'string' && rawName.trim()) {
    return rawName.trim().replace(/^\/+/, '');
  }
  return containerId.slice(0, 12);
}

function isForbiddenNamespace(mode) {
  if (typeof mode !== 'string') return false;
  const lower = mode.trim().toLowerCase();
  return lower === 'host' || lower.startsWith('container:') || lower.startsWith('service:');
}

export function evaluateContainerConsoleInspect(rawInspect, {
  projectId,
  projectName,
  allowedServices = [],
  expectedContainerId = null,
  composeRoot = dockerComposeManagerInternals.defaultRoot,
} = {}) {
  if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) {
    throw new DockerContainerConsoleInspectorError('container_console_project_invalid', 'Docker project identity is invalid', 400);
  }
  if (typeof projectName !== 'string' || !PROJECT_NAME_PATTERN.test(projectName)) {
    throw new DockerContainerConsoleInspectorError('container_console_project_invalid', 'Docker project name is invalid', 400);
  }
  const serviceSet = new Set(
    (Array.isArray(allowedServices) ? allowedServices : [])
      .filter((name) => typeof name === 'string' && SERVICE_NAME_PATTERN.test(name)),
  );
  if (serviceSet.size === 0) {
    throw new DockerContainerConsoleInspectorError('container_console_project_invalid', 'Docker project has no valid services', 409);
  }
  if (!rawInspect || typeof rawInspect !== 'object' || Array.isArray(rawInspect)) {
    throw new DockerContainerConsoleInspectorError('container_console_not_found', REASON_MESSAGES.container_console_not_found, 404);
  }

  const containerId = typeof rawInspect.Id === 'string' ? rawInspect.Id.toLowerCase() : '';
  if (!CONTAINER_ID_PATTERN.test(containerId) || (expectedContainerId && containerId !== expectedContainerId.toLowerCase())) {
    throw new DockerContainerConsoleInspectorError('container_console_not_found', REASON_MESSAGES.container_console_not_found, 404);
  }

  const labels = rawInspect.Config?.Labels && typeof rawInspect.Config.Labels === 'object' && !Array.isArray(rawInspect.Config.Labels)
    ? rawInspect.Config.Labels
    : {};
  const labelProject = typeof labels['com.docker.compose.project'] === 'string' ? labels['com.docker.compose.project'] : null;
  const labelService = typeof labels['com.docker.compose.service'] === 'string' ? labels['com.docker.compose.service'] : null;
  const labelWorkingDir = normalizePosixPath(labels['com.docker.compose.project.working_dir']);
  const expectedWorkingDir = normalizePosixPath(dockerComposeManagerInternals.projectWorkspacePath(composeRoot, projectId));

  if (labelProject !== projectName || !labelService || !serviceSet.has(labelService)
    || !expectedWorkingDir || labelWorkingDir !== expectedWorkingDir) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_ownership_mismatch',
      REASON_MESSAGES.container_console_ownership_mismatch,
      409,
    );
  }

  const state = rawInspect.State && typeof rawInspect.State === 'object' ? rawInspect.State : {};
  if (state.Running !== true || state.Paused === true || state.Restarting === true || state.Dead === true) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_not_running',
      REASON_MESSAGES.container_console_not_running,
      409,
    );
  }

  const hostConfig = rawInspect.HostConfig && typeof rawInspect.HostConfig === 'object' ? rawInspect.HostConfig : {};
  if (hostConfig.Privileged === true) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_privileged_forbidden',
      REASON_MESSAGES.container_console_privileged_forbidden,
      409,
    );
  }

  const capAdd = Array.isArray(hostConfig.CapAdd) ? hostConfig.CapAdd : [];
  for (const rawCap of capAdd) {
    if (typeof rawCap !== 'string') continue;
    const normalizedCap = rawCap.trim().toUpperCase().replace(/^CAP_/, '');
    if (FORBIDDEN_CAPABILITIES.has(normalizedCap)) {
      throw new DockerContainerConsoleInspectorError(
        'container_console_unsafe_capability_forbidden',
        REASON_MESSAGES.container_console_unsafe_capability_forbidden,
        409,
      );
    }
  }

  const securityOpts = Array.isArray(hostConfig.SecurityOpt) ? hostConfig.SecurityOpt : [];
  for (const rawOpt of securityOpts) {
    if (typeof rawOpt !== 'string') continue;
    const normalizedOpt = rawOpt.trim().toLowerCase().replace(/\s+/g, '');
    if (FORBIDDEN_SECURITY_OPTS.has(normalizedOpt)) {
      throw new DockerContainerConsoleInspectorError(
        'container_console_unsafe_security_opt_forbidden',
        REASON_MESSAGES.container_console_unsafe_security_opt_forbidden,
        409,
      );
    }
  }

  if (Array.isArray(hostConfig.Devices) && hostConfig.Devices.length > 0) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_host_device_forbidden',
      REASON_MESSAGES.container_console_host_device_forbidden,
      409,
    );
  }

  for (const mode of [hostConfig.PidMode, hostConfig.NetworkMode, hostConfig.IpcMode, hostConfig.UTSMode]) {
    if (isForbiddenNamespace(mode)) {
      throw new DockerContainerConsoleInspectorError(
        'container_console_host_namespace_forbidden',
        REASON_MESSAGES.container_console_host_namespace_forbidden,
        409,
      );
    }
  }
  if (typeof hostConfig.CgroupnsMode === 'string') {
    const cg = hostConfig.CgroupnsMode.trim().toLowerCase();
    if (cg.startsWith('container:') || cg.startsWith('service:')) {
      throw new DockerContainerConsoleInspectorError(
        'container_console_host_namespace_forbidden',
        REASON_MESSAGES.container_console_host_namespace_forbidden,
        409,
      );
    }
  }

  const mounts = Array.isArray(rawInspect.Mounts) ? rawInspect.Mounts : [];
  for (const mount of mounts) {
    if (!mount || typeof mount !== 'object') continue;
    if (touchesContainerSocket(mount.Source) || touchesContainerSocket(mount.Destination)) {
      throw new DockerContainerConsoleInspectorError(
        'container_console_unsafe_mount_forbidden',
        REASON_MESSAGES.container_console_unsafe_mount_forbidden,
        409,
      );
    }
    if (mount.Type === 'bind' && isSensitiveHostBind(mount.Source, expectedWorkingDir)) {
      throw new DockerContainerConsoleInspectorError(
        'container_console_unsafe_mount_forbidden',
        REASON_MESSAGES.container_console_unsafe_mount_forbidden,
        409,
      );
    }
  }

  const userSpec = assertNonRootUserSpec(rawInspect.Config?.User);
  const cwd = normalizeWorkingDir(rawInspect.Config?.WorkingDir);

  return Object.freeze({
    containerId,
    containerName: normalizeContainerName(rawInspect.Name, containerId),
    serviceName: labelService,
    projectName,
    userSpec,
    cwd,
  });
}

export function parseContainerShellProbe(rawStdout) {
  if (typeof rawStdout !== 'string') {
    throw new DockerContainerConsoleInspectorError(
      'container_console_shell_unavailable',
      REASON_MESSAGES.container_console_shell_unavailable,
      409,
    );
  }
  const trimmed = rawStdout.trim();
  const match = /^([0-9]{1,10}):([0-9]{1,10}):(.*)$/.exec(trimmed);
  if (!match) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_shell_unavailable',
      REASON_MESSAGES.container_console_shell_unavailable,
      409,
    );
  }
  const uid = Number.parseInt(match[1], 10);
  const gid = Number.parseInt(match[2], 10);
  const shell = match[3];
  if (!Number.isSafeInteger(uid) || uid < 1 || uid > 2_147_483_647
    || !Number.isSafeInteger(gid) || gid < 1 || gid > 2_147_483_647) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_root_user_forbidden',
      REASON_MESSAGES.container_console_root_user_forbidden,
      409,
    );
  }
  if (!ALLOWED_SHELLS.includes(shell)) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_shell_unavailable',
      REASON_MESSAGES.container_console_shell_unavailable,
      409,
    );
  }
  return Object.freeze({
    uid,
    gid,
    user: `${uid}:${gid}`,
    shell,
  });
}

function isNotFoundError(error) {
  const stderr = String(error?.stderr ?? '').toLowerCase();
  return stderr.includes('no such container') || stderr.includes('no such object');
}

export function createDockerContainerConsoleInspector({
  accessFn = access,
  execFn = execFileSafe,
  composeRoot = dockerComposeManagerInternals.defaultRoot,
} = {}) {
  if (typeof accessFn !== 'function' || typeof execFn !== 'function'
    || typeof composeRoot !== 'string' || !path.isAbsolute(composeRoot)) {
    throw new DockerContainerConsoleInspectorError(
      'container_console_inspector_dependencies_invalid',
      'Docker container console inspector dependencies are invalid',
      500,
    );
  }

  async function requireDockerBinary() {
    const binary = await findDockerPath(accessFn);
    if (!binary) {
      throw new DockerContainerConsoleInspectorError(
        'docker_console_unavailable',
        'Docker CLI is not installed on this host',
        503,
      );
    }
    return binary;
  }

  async function inspectRawContainer(binary, containerId) {
    let stdout;
    try {
      ({ stdout } = await execFn(binary, ['--host', DOCKER_LOCAL_SOCKET, 'inspect', '--type', 'container', '--', containerId], {
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      }));
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new DockerContainerConsoleInspectorError('container_console_not_found', REASON_MESSAGES.container_console_not_found, 404);
      }
      throw new DockerContainerConsoleInspectorError(
        'docker_console_inspect_failed',
        'Docker container inspection failed',
        503,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new DockerContainerConsoleInspectorError(
        'docker_console_inspect_invalid',
        'Docker container inspection output is invalid',
        503,
      );
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
      throw new DockerContainerConsoleInspectorError('container_console_not_found', REASON_MESSAGES.container_console_not_found, 404);
    }
    return parsed[0];
  }

  async function inspectContainer({
    projectId,
    projectName,
    allowedServices,
    containerId,
    probeShell = true,
  } = {}) {
    if (typeof containerId !== 'string' || !CONTAINER_ID_PATTERN.test(containerId)) {
      throw new DockerContainerConsoleInspectorError('container_console_id_invalid', 'Docker container ID must be a 64-character hex identifier', 400);
    }
    const binary = await requireDockerBinary();
    const raw = await inspectRawContainer(binary, containerId);
    const verified = evaluateContainerConsoleInspect(raw, {
      projectId,
      projectName,
      allowedServices,
      expectedContainerId: containerId,
      composeRoot,
    });

    if (!probeShell) {
      return Object.freeze({
        ...verified,
        dockerBinary: binary,
        eligible: true,
      });
    }

    let probeStdout;
    try {
      ({ stdout: probeStdout } = await execFn(binary, [
        '--host', DOCKER_LOCAL_SOCKET,
        'exec',
        '--user', verified.userSpec,
        '--',
        verified.containerId,
        '/bin/sh',
        '-c',
        PROBE_COMMAND,
      ], { timeout: 5_000, maxBuffer: 16 * 1024 }));
    } catch {
      throw new DockerContainerConsoleInspectorError(
        'container_console_shell_unavailable',
        REASON_MESSAGES.container_console_shell_unavailable,
        409,
      );
    }
    const probe = parseContainerShellProbe(probeStdout);
    return Object.freeze({
      containerId: verified.containerId,
      containerName: verified.containerName,
      serviceName: verified.serviceName,
      projectName: verified.projectName,
      uid: probe.uid,
      gid: probe.gid,
      user: probe.user,
      cwd: verified.cwd,
      shell: probe.shell,
      dockerBinary: binary,
      eligible: true,
    });
  }

  async function listProjectConsoleTargets({
    projectId,
    projectName,
    allowedServices,
    containers = [],
  } = {}) {
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)
      || typeof projectName !== 'string' || !PROJECT_NAME_PATTERN.test(projectName)) {
      throw new DockerContainerConsoleInspectorError('container_console_project_invalid', 'Docker project identity is invalid', 400);
    }
    const list = Array.isArray(containers) ? containers : [];
    if (list.length === 0) return Object.freeze([]);
    const binary = await requireDockerBinary();

    const results = [];
    for (const item of list) {
      const id = typeof item?.id === 'string' ? item.id.toLowerCase() : '';
      const fallbackName = normalizeContainerName(item?.name, id || 'unknown');
      const fallbackService = typeof item?.service === 'string' ? item.service : null;
      if (!CONTAINER_ID_PATTERN.test(id)) {
        results.push(Object.freeze({
          containerId: id || null,
          containerName: fallbackName,
          serviceName: fallbackService,
          running: item?.runtime?.running === true,
          eligible: false,
          reasonCode: 'container_console_id_invalid',
          reason: 'Konteyner kimliği doğrulanamadı.',
        }));
        continue;
      }
      try {
        const raw = await inspectRawContainer(binary, id);
        const verified = evaluateContainerConsoleInspect(raw, {
          projectId,
          projectName,
          allowedServices,
          expectedContainerId: id,
          composeRoot,
        });
        results.push(Object.freeze({
          containerId: verified.containerId,
          containerName: verified.containerName,
          serviceName: verified.serviceName,
          running: true,
          eligible: true,
          user: verified.userSpec,
          cwd: verified.cwd,
          reasonCode: null,
          reason: null,
        }));
      } catch (error) {
        if (error instanceof DockerContainerConsoleInspectorError && error.status === 503) {
          throw error;
        }
        const code = error instanceof DockerContainerConsoleInspectorError ? error.code : 'container_console_unavailable';
        results.push(Object.freeze({
          containerId: id,
          containerName: fallbackName,
          serviceName: fallbackService,
          running: item?.runtime?.running === true,
          eligible: false,
          user: null,
          cwd: null,
          reasonCode: code,
          reason: REASON_MESSAGES[code] ?? 'Bu konteyner için konsol erişimi kullanılamıyor.',
        }));
      }
    }
    return Object.freeze(results);
  }

  return Object.freeze({
    inspectContainer,
    listProjectConsoleTargets,
  });
}

export const dockerContainerConsoleInspectorInternals = Object.freeze({
  dockerPaths: DOCKER_PATHS,
  dockerSocket: DOCKER_LOCAL_SOCKET,
  allowedShells: ALLOWED_SHELLS,
  forbiddenCapabilities: FORBIDDEN_CAPABILITIES,
  forbiddenSecurityOpts: FORBIDDEN_SECURITY_OPTS,
  reasonMessages: REASON_MESSAGES,
  probeCommand: PROBE_COMMAND,
  assertNonRootUserSpec,
  normalizeWorkingDir,
  isSensitiveHostBind,
  touchesContainerSocket,
  evaluateContainerConsoleInspect,
  parseContainerShellProbe,
});
