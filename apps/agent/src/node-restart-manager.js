import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { nodeServiceName } from '@yunpanel/config-templates';
import { normalizeNodeRestartSpec } from '@yunpanel/shared';
import { nodeEnvironmentWriter, NodeEnvironmentWriteError } from './node-environment-writer.js';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const SYSTEMCTL_PATHS = Object.freeze(['/usr/bin/systemctl', '/bin/systemctl']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NodeRestartError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeRestartError';
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

export function createNodeRestartManager({
  appRoot = APP_ROOT,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  }),
  readlinkFn = readlink,
  waitForHealth = defaultWaitForHealth,
  writeEnvironment = (input) => nodeEnvironmentWriter.writeEnvironment(input),
  systemctlPaths = SYSTEMCTL_PATHS,
} = {}) {
  const restartLocks = new Map();

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

  async function runSafe(file, args, options = {}) {
    try {
      return await run(file, args, options);
    } catch (error) {
      const wrapped = new NodeRestartError('node_restart_command_failed', 'Node restart command failed');
      wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null;
      throw wrapped;
    }
  }

  async function restartUnlocked(rawSpec) {
    let spec;
    try {
      spec = normalizeNodeRestartSpec(rawSpec);
    } catch {
      throw new NodeRestartError('invalid_node_restart', 'Node restart specification is invalid');
    }

    const currentPath = path.join(appRoot, spec.applicationId, 'current');
    let currentReleaseId = null;
    try {
      currentReleaseId = parseCurrentRelease(await readlinkFn(currentPath));
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') throw error;
    }
    if (!currentReleaseId) {
      throw new NodeRestartError('node_restart_current_missing', 'Managed Node application does not have a valid active release');
    }
    if (currentReleaseId !== spec.releaseId) {
      throw new NodeRestartError('node_restart_release_drift', 'Managed Node current release does not match control-plane state');
    }

    const systemctlPath = await findSystemctl();
    if (!systemctlPath) throw new NodeRestartError('systemd_not_available', 'systemctl is not available on the managed server');

    let environmentTransaction;
    try {
      environmentTransaction = await writeEnvironment({
        applicationId: spec.applicationId,
        runtime: spec.runtime,
        environment: rawSpec.environment ?? {},
      });
    } catch (error) {
      if (error instanceof NodeEnvironmentWriteError) {
        throw new NodeRestartError(error.code, error.message);
      }
      throw error;
    }
    if (!environmentTransaction || typeof environmentTransaction.restore !== 'function' || typeof environmentTransaction.commit !== 'function') {
      throw new NodeRestartError('node_environment_write_failed', 'Node environment writer did not return a transaction');
    }

    const serviceName = nodeServiceName(spec.applicationId);
    let restartError = null;
    try {
      await runSafe(systemctlPath, ['restart', serviceName], { timeout: 30_000 });
      const healthy = await waitForHealth({
        port: spec.runtime.port,
        healthPath: spec.runtime.healthPath,
        timeoutSeconds: spec.runtime.healthTimeoutSeconds,
      });
      if (!healthy) {
        restartError = new NodeRestartError('node_restart_health_failed', 'Node service restart completed but the application failed health checks');
      }
    } catch (error) {
      restartError = error;
    }

    if (restartError) {
      try {
        await environmentTransaction.restore();
        await runSafe(systemctlPath, ['restart', serviceName], { timeout: 30_000 });
        const restoredHealthy = await waitForHealth({
          port: spec.runtime.port,
          healthPath: spec.runtime.healthPath,
          timeoutSeconds: spec.runtime.healthTimeoutSeconds,
        });
        if (!restoredHealthy) throw new Error('previous environment failed health check');
      } catch {
        throw new NodeRestartError('node_restart_restore_failed', 'Node restart failed and the previous environment could not be restored safely');
      }
      throw restartError;
    }

    environmentTransaction.commit();
    return {
      releaseId: currentReleaseId,
      serviceName,
      port: spec.runtime.port,
      healthPath: spec.runtime.healthPath,
      healthy: true,
      restarted: true,
    };
  }

  function restartNode(spec) {
    const key = spec?.applicationId ?? 'invalid';
    const previous = restartLocks.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => restartUnlocked(spec));
    let tracked;
    tracked = operation.finally(() => {
      if (restartLocks.get(key) === tracked) restartLocks.delete(key);
    });
    restartLocks.set(key, tracked);
    return operation;
  }

  return { restartNode };
}

export const nodeRestartManager = createNodeRestartManager();
