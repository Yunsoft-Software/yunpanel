import { execFile } from 'node:child_process';
import { lstat, readlink, rename, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { nodeServiceName } from '@yunpanel/config-templates';
import { normalizeNodeRollbackSpec } from '@yunpanel/shared';
import { nodeEnvironmentWriter, NodeEnvironmentWriteError } from './node-environment-writer.js';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const SYSTEMCTL_PATHS = Object.freeze(['/usr/bin/systemctl', '/bin/systemctl']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NodeRollbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeRollbackError';
    this.code = code;
  }
}

function parseCurrentRelease(linkTarget) {
  if (typeof linkTarget !== 'string') return null;
  const match = linkTarget.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

function requestHealth({ port, healthPath, timeoutMs = 2_000 }) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: healthPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: { host: 'localhost', connection: 'close' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function defaultWaitForHealth({ port, healthPath, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  do {
    if (await requestHealth({ port, healthPath })) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return false;
}

export function createNodeRollbackManager({
  appRoot = APP_ROOT,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  }),
  lstatFn = lstat,
  readlinkFn = readlink,
  renameFn = rename,
  rmFn = rm,
  symlinkFn = symlink,
  waitForHealth = defaultWaitForHealth,
  writeEnvironment = (input) => nodeEnvironmentWriter.writeEnvironment(input),
  systemctlPaths = SYSTEMCTL_PATHS,
} = {}) {
  const rollbackLocks = new Map();

  async function runSafe(file, args, options = {}) {
    try {
      return await run(file, args, options);
    } catch (error) {
      const wrapped = new NodeRollbackError('node_rollback_command_failed', 'Node rollback command failed');
      wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null;
      throw wrapped;
    }
  }

  async function findSystemctl() {
    for (const candidate of systemctlPaths) {
      try {
        await run(candidate, ['--version'], { timeout: 5_000 });
        return candidate;
      } catch {
        // Continue through fixed allowlisted paths only.
      }
    }
    return null;
  }

  async function switchCurrent(currentPath, releaseId, suffix) {
    const temporaryPath = `${currentPath}.${suffix}-${process.pid}`;
    await rmFn(temporaryPath, { force: true });
    try {
      await symlinkFn(path.join('releases', releaseId), temporaryPath);
      await renameFn(temporaryPath, currentPath);
    } finally {
      await rmFn(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async function rollbackUnlocked(rawSpec) {
    let spec;
    try {
      spec = normalizeNodeRollbackSpec(rawSpec);
    } catch {
      throw new NodeRollbackError('invalid_node_rollback', 'Node rollback specification is invalid');
    }

    const applicationDirectory = path.join(appRoot, spec.applicationId);
    const releasesDirectory = path.join(applicationDirectory, 'releases');
    const targetReleasePath = path.join(releasesDirectory, spec.releaseId);
    const currentPath = path.join(applicationDirectory, 'current');
    const serviceName = nodeServiceName(spec.applicationId);

    let targetInfo;
    try {
      targetInfo = await lstatFn(targetReleasePath);
    } catch {
      throw new NodeRollbackError('rollback_release_missing', 'Rollback release does not exist on the managed server');
    }
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
      throw new NodeRollbackError('rollback_release_invalid', 'Rollback release must be a real directory');
    }

    let previousReleaseId = null;
    try {
      previousReleaseId = parseCurrentRelease(await readlinkFn(currentPath));
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') throw error;
    }
    if (!previousReleaseId) {
      throw new NodeRollbackError('rollback_current_missing', 'Managed Node application does not have a valid active release');
    }
    if (previousReleaseId === spec.releaseId) {
      throw new NodeRollbackError('rollback_target_current', 'Requested rollback release is already active');
    }

    const systemctlPath = await findSystemctl();
    if (!systemctlPath) throw new NodeRollbackError('systemd_not_available', 'systemctl is not available on the managed server');

    try {
      await writeEnvironment({
        applicationId: spec.applicationId,
        runtime: spec.runtime,
        environment: rawSpec.environment ?? {},
      });
    } catch (error) {
      if (error instanceof NodeEnvironmentWriteError) {
        throw new NodeRollbackError(error.code, error.message);
      }
      throw error;
    }

    await switchCurrent(currentPath, spec.releaseId, 'rollback');

    let activationError = null;
    try {
      await runSafe(systemctlPath, ['restart', serviceName], { timeout: 30_000 });
      const healthy = await waitForHealth({
        port: spec.runtime.port,
        healthPath: spec.runtime.healthPath,
        timeoutSeconds: spec.runtime.healthTimeoutSeconds,
      });
      if (!healthy) {
        activationError = new NodeRollbackError('node_rollback_health_failed', 'Rollback release failed health checks and was not kept active');
      }
    } catch (error) {
      activationError = error;
    }

    if (activationError) {
      try {
        await switchCurrent(currentPath, previousReleaseId, 'restore');
        await runSafe(systemctlPath, ['restart', serviceName], { timeout: 30_000 });
        const restoredHealthy = await waitForHealth({
          port: spec.runtime.port,
          healthPath: spec.runtime.healthPath,
          timeoutSeconds: spec.runtime.healthTimeoutSeconds,
        });
        if (!restoredHealthy) throw new Error('previous release failed health check');
      } catch {
        throw new NodeRollbackError('node_rollback_restore_failed', 'Rollback failed and the previous Node release could not be restored');
      }
      throw activationError;
    }

    return {
      releaseId: spec.releaseId,
      previousReleaseId,
      serviceName,
      port: spec.runtime.port,
      healthPath: spec.runtime.healthPath,
      healthy: true,
      active: true,
    };
  }

  function rollbackNode(spec) {
    const key = spec?.applicationId ?? 'invalid';
    const previous = rollbackLocks.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => rollbackUnlocked(spec));
    let tracked;
    tracked = operation.finally(() => {
      if (rollbackLocks.get(key) === tracked) rollbackLocks.delete(key);
    });
    rollbackLocks.set(key, tracked);
    return operation;
  }

  return { rollbackNode };
}

export const nodeRollbackManager = createNodeRollbackManager();
