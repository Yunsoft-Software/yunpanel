import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { nodeServiceName } from '@yunpanel/config-templates';
import { normalizeNodeProcessSpec } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const SYSTEMCTL_PATHS = Object.freeze(['/usr/bin/systemctl', '/bin/systemctl']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NodeProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeProcessError';
    this.code = code;
  }
}

function parseCurrentRelease(linkTarget) {
  if (typeof linkTarget !== 'string') return null;
  const match = linkTarget.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

function parseProperties(output) {
  const values = {};
  for (const line of String(output ?? '').split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const mainPid = Number.parseInt(values.MainPID ?? '0', 10);
  return {
    loadState: values.LoadState || 'unknown',
    activeState: values.ActiveState || 'unknown',
    subState: values.SubState || 'unknown',
    unitFileState: values.UnitFileState || 'unknown',
    mainPid: Number.isSafeInteger(mainPid) && mainPid >= 0 ? mainPid : 0,
  };
}

function requestHealth({ port, healthPath, timeoutMs = 2_000 }) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1', port, path: healthPath, method: 'GET', timeout: timeoutMs,
      headers: { host: 'localhost', connection: 'close' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
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

export function createNodeProcessManager({
  appRoot = APP_ROOT,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8', timeout: options.timeout ?? 30_000, maxBuffer: options.maxBuffer ?? 64 * 1024,
  }),
  readlinkFn = readlink,
  healthCheck = requestHealth,
  waitForHealth = defaultWaitForHealth,
  systemctlPaths = SYSTEMCTL_PATHS,
} = {}) {
  const locks = new Map();

  async function findSystemctl() {
    for (const candidate of systemctlPaths) {
      try { await run(candidate, ['--version'], { timeout: 5_000 }); return candidate; }
      catch { /* Continue through fixed allowlisted paths. */ }
    }
    return null;
  }

  async function currentRelease(spec) {
    let current = null;
    try { current = parseCurrentRelease(await readlinkFn(path.join(appRoot, spec.applicationId, 'current'))); }
    catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') throw error; }
    if (!current) throw new NodeProcessError('node_process_current_missing', 'Managed Node application does not have a valid active release');
    if (current !== spec.releaseId) throw new NodeProcessError('node_process_release_drift', 'Managed Node current release does not match control-plane state');
    return current;
  }

  async function inspectWith(spec, systemctlPath) {
    const serviceName = nodeServiceName(spec.applicationId);
    let stdout;
    try {
      ({ stdout } = await run(systemctlPath, [
        'show', serviceName,
        '--property=LoadState', '--property=ActiveState', '--property=SubState',
        '--property=UnitFileState', '--property=MainPID', '--no-pager',
      ], { timeout: 5_000, maxBuffer: 64 * 1024 }));
    } catch {
      throw new NodeProcessError('node_process_inspection_failed', 'Managed Node service state could not be inspected');
    }
    const state = parseProperties(stdout);
    const healthy = state.activeState === 'active'
      ? await healthCheck({ port: spec.runtime.port, healthPath: spec.runtime.healthPath })
      : false;
    return {
      releaseId: spec.releaseId,
      serviceName,
      action: spec.action,
      port: spec.runtime.port,
      healthPath: spec.runtime.healthPath,
      ...state,
      enabled: state.unitFileState === 'enabled',
      active: state.activeState === 'active',
      healthy,
    };
  }

  async function normalized(rawSpec) {
    try { return normalizeNodeProcessSpec(rawSpec); }
    catch { throw new NodeProcessError('invalid_node_process', 'Node process specification is invalid'); }
  }

  async function inspectNodeProcess(rawSpec) {
    const spec = await normalized(rawSpec);
    await currentRelease(spec);
    const systemctlPath = await findSystemctl();
    if (!systemctlPath) throw new NodeProcessError('systemd_not_available', 'systemctl is not available on the managed server');
    return inspectWith(spec, systemctlPath);
  }

  async function controlUnlocked(rawSpec) {
    const spec = await normalized(rawSpec);
    await currentRelease(spec);
    const systemctlPath = await findSystemctl();
    if (!systemctlPath) throw new NodeProcessError('systemd_not_available', 'systemctl is not available on the managed server');
    const serviceName = nodeServiceName(spec.applicationId);
    try { await run(systemctlPath, [spec.action, serviceName], { timeout: 30_000, maxBuffer: 64 * 1024 }); }
    catch { throw new NodeProcessError('node_process_command_failed', 'Node process action failed'); }

    let state = await inspectWith(spec, systemctlPath);
    if (state.loadState !== 'loaded') {
      throw new NodeProcessError('node_process_unit_unavailable', 'Managed Node service unit is not loaded');
    }
    if (spec.action === 'enable' && !state.enabled) {
      throw new NodeProcessError('node_process_enable_unconfirmed', 'Node service was not enabled');
    }
    if (spec.action === 'disable' && state.unitFileState !== 'disabled') {
      throw new NodeProcessError('node_process_disable_unconfirmed', 'Node service was not disabled');
    }
    if (spec.action === 'stop' && (state.activeState !== 'inactive' || state.mainPid !== 0)) {
      throw new NodeProcessError('node_process_stop_unconfirmed', 'Node service remained active after stop');
    }
    if (spec.action === 'start' && (!state.active || state.mainPid < 1 || !await waitForHealth({
      port: spec.runtime.port,
      healthPath: spec.runtime.healthPath,
      timeoutSeconds: spec.runtime.healthTimeoutSeconds,
    }))) {
      try {
        await run(systemctlPath, ['stop', serviceName], { timeout: 30_000, maxBuffer: 64 * 1024 });
        state = await inspectWith(spec, systemctlPath);
        if (state.active) throw new Error('still active');
      } catch {
        throw new NodeProcessError('node_process_start_rollback_failed', 'Unhealthy Node start could not be returned to stopped state');
      }
      throw new NodeProcessError('node_process_start_health_failed', 'Node service started but failed health checks and was stopped');
    }
    if (spec.action === 'start') state = { ...state, healthy: true };
    return state;
  }

  function controlNodeProcess(spec) {
    const key = spec?.applicationId ?? 'invalid';
    const previous = locks.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => controlUnlocked(spec));
    let tracked;
    tracked = operation.finally(() => { if (locks.get(key) === tracked) locks.delete(key); });
    locks.set(key, tracked);
    return tracked;
  }

  return Object.freeze({ controlNodeProcess, inspectNodeProcess });
}

export const nodeProcessManager = createNodeProcessManager();
export const nodeProcessInternals = Object.freeze({ parseCurrentRelease, parseProperties });
