import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { nodeServiceName } from '@yunpanel/config-templates';
import { normalizeNodeStatusSpec } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const SYSTEMCTL_PATHS = Object.freeze(['/usr/bin/systemctl', '/bin/systemctl']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NodeStatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeStatusError';
    this.code = code;
  }
}

function parseCurrentRelease(linkTarget) {
  if (typeof linkTarget !== 'string') return null;
  const match = linkTarget.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

export function parseNodeServiceProperties(output) {
  const properties = {};
  for (const line of String(output ?? '').split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }

  const restartCount = Number.parseInt(properties.NRestarts ?? '0', 10);
  const mainPid = Number.parseInt(properties.MainPID ?? '0', 10);
  return {
    loadState: properties.LoadState || 'unknown',
    activeState: properties.ActiveState || 'unknown',
    subState: properties.SubState || 'unknown',
    restartCount: Number.isSafeInteger(restartCount) && restartCount >= 0 ? restartCount : 0,
    mainPid: Number.isSafeInteger(mainPid) && mainPid >= 0 ? mainPid : 0,
  };
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

export function createNodeStatusInspector({
  appRoot = APP_ROOT,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024,
  }),
  readlinkFn = readlink,
  healthCheck = requestHealth,
  systemctlPaths = SYSTEMCTL_PATHS,
} = {}) {
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

  async function inspectNodeStatus(rawSpec) {
    let spec;
    try {
      spec = normalizeNodeStatusSpec(rawSpec);
    } catch {
      throw new NodeStatusError('invalid_node_status', 'Node status specification is invalid');
    }

    const currentPath = path.join(appRoot, spec.applicationId, 'current');
    let currentReleaseId = null;
    try {
      currentReleaseId = parseCurrentRelease(await readlinkFn(currentPath));
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') throw error;
    }
    if (!currentReleaseId) {
      throw new NodeStatusError('node_status_current_missing', 'Managed Node application does not have a valid active release');
    }
    if (currentReleaseId !== spec.releaseId) {
      throw new NodeStatusError('node_status_release_drift', 'Managed Node current release does not match control-plane state');
    }

    const systemctlPath = await findSystemctl();
    if (!systemctlPath) throw new NodeStatusError('systemd_not_available', 'systemctl is not available on the managed server');

    const serviceName = nodeServiceName(spec.applicationId);
    const args = [
      'show',
      serviceName,
      '--property=LoadState',
      '--property=ActiveState',
      '--property=SubState',
      '--property=NRestarts',
      '--property=MainPID',
      '--no-pager',
    ];

    let stdout = '';
    let inspectionError = false;
    try {
      ({ stdout } = await run(systemctlPath, args, { timeout: 5_000, maxBuffer: 64 * 1024 }));
    } catch (error) {
      stdout = typeof error?.stdout === 'string' ? error.stdout : '';
      inspectionError = true;
    }

    const service = parseNodeServiceProperties(stdout);
    const healthy = service.activeState === 'active'
      ? await healthCheck({ port: spec.runtime.port, healthPath: spec.runtime.healthPath })
      : false;

    return {
      releaseId: currentReleaseId,
      serviceName,
      port: spec.runtime.port,
      healthPath: spec.runtime.healthPath,
      ...service,
      healthy,
      inspectionError,
    };
  }

  return { inspectNodeStatus };
}

export const nodeStatusInspector = createNodeStatusInspector();
