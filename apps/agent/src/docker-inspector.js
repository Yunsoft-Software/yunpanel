import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';

const DOCKER_PATHS = Object.freeze([
  '/usr/bin/docker',
  '/usr/local/bin/docker',
]);

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) return reject(error);
      return resolve(stdout);
    });
  });
}

async function findDockerPath(accessFn) {
  for (const candidate of DOCKER_PATHS) {
    try {
      await accessFn(candidate);
      return candidate;
    } catch {
      // Continue through the fixed path allowlist.
    }
  }
  return null;
}

export function parseDockerPsOutput(output) {
  const containers = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const item = JSON.parse(trimmed);
      containers.push({
        id: item.ID ?? null,
        name: item.Names ?? null,
        image: item.Image ?? null,
        state: item.State ?? null,
        status: item.Status ?? null,
        ports: item.Ports ?? null,
        networks: item.Networks ?? null,
        mounts: item.Mounts ?? null,
        labels: item.Labels ?? null,
        createdAt: item.CreatedAt ?? null,
      });
    } catch {
      // Ignore malformed lines instead of failing the complete inventory.
    }
  }

  return containers;
}

function safeFailureCode(error) {
  if (error?.code === 'EACCES') return 'permission_denied';
  if (error?.code === 'ENOENT') return 'docker_missing';
  if (error?.killed) return 'docker_timeout';
  if (Number.isInteger(error?.code)) return `docker_exit_${error.code}`;
  return 'docker_unavailable';
}

export function createDockerInspector({ accessFn = access, execFn = execFileText } = {}) {
  return async function inspectDocker() {
    const dockerPath = await findDockerPath(accessFn);
    if (!dockerPath) {
      return {
        installed: false,
        reachable: false,
        path: null,
        version: null,
        composeVersion: null,
        containers: [],
        errorCode: null,
      };
    }

    try {
      const [versionOutput, composeOutput, containersOutput] = await Promise.all([
        execFn(dockerPath, ['version', '--format', '{{.Server.Version}}']),
        execFn(dockerPath, ['compose', 'version', '--short']).catch(() => ''),
        execFn(dockerPath, ['ps', '-a', '--no-trunc', '--format', '{{json .}}']),
      ]);

      return {
        installed: true,
        reachable: true,
        path: dockerPath,
        version: versionOutput.trim() || null,
        composeVersion: composeOutput.trim() || null,
        containers: parseDockerPsOutput(containersOutput),
        errorCode: null,
      };
    } catch (error) {
      return {
        installed: true,
        reachable: false,
        path: dockerPath,
        version: null,
        composeVersion: null,
        containers: [],
        errorCode: safeFailureCode(error),
      };
    }
  };
}

export const inspectDocker = createDockerInspector();
