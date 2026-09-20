import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SYSTEMCTL_PATH = '/usr/bin/systemctl';
const SYSTEMD_ROOT = '/etc/systemd/system';
const POLICY_MODE = 0o027;
const DROPIN_MODE = 0o644;
const SERVICES = Object.freeze({
  passenger: 'nginx.service',
  php: 'php8.3-fpm.service',
});

export class ServiceUmaskManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceUmaskManagerError';
    this.code = code;
  }
}

function normalizeRuntime(value) {
  if (typeof value !== 'string' || !Object.hasOwn(SERVICES, value)) {
    throw new ServiceUmaskManagerError('service_umask_runtime_invalid', 'Managed runtime umask target is invalid');
  }
  return Object.freeze({ runtime: value, serviceUnit: SERVICES[value] });
}

function dropInPath(serviceUnit) {
  return path.posix.join(SYSTEMD_ROOT, `${serviceUnit}.d`, '90-yunpanel-umask.conf');
}

function desiredConfig() {
  return `[Service]\nUMask=0027\n`;
}

function modeOf(stat) {
  return Number(stat?.mode ?? 0) & 0o777;
}

function missing(error) {
  return error?.code === 'ENOENT';
}

function parseUmask(value) {
  const raw = String(value ?? '').trim();
  if (!/^0?[0-7]{3,4}$/.test(raw)) return null;
  return Number.parseInt(raw, 8);
}

export function createServiceUmaskManager({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: 256 * 1024,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
  chmodFn = chmod,
} = {}) {
  if (typeof run !== 'function' || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function'
    || typeof readFileFn !== 'function' || typeof renameFn !== 'function' || typeof rmFn !== 'function'
    || typeof writeFileFn !== 'function' || typeof chmodFn !== 'function') {
    throw new ServiceUmaskManagerError('service_umask_dependencies_invalid', 'Managed runtime umask dependencies are invalid');
  }

  async function readOptional(file) {
    try { return await readFileFn(file, 'utf8'); }
    catch (error) {
      if (missing(error)) return null;
      throw new ServiceUmaskManagerError('service_umask_config_unavailable', 'Managed runtime umask configuration could not be read');
    }
  }

  async function atomicWrite(file, content) {
    const temporary = `${file}.${process.pid}.tmp`;
    await rmFn(temporary, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporary, content, { encoding: 'utf8', mode: DROPIN_MODE });
      // writeFile's mode is filtered by the root API service's process umask.
      await chmodFn(temporary, DROPIN_MODE);
      await renameFn(temporary, file);
    } finally {
      await rmFn(temporary, { force: true }).catch(() => {});
    }
  }

  async function effectiveUmask(serviceUnit) {
    try {
      const result = await run(SYSTEMCTL_PATH, ['show', serviceUnit, '--property=UMask', '--value'], { timeout: 10_000 });
      return parseUmask(result?.stdout);
    } catch {
      throw new ServiceUmaskManagerError('service_umask_unit_unavailable', 'Managed runtime service unit is unavailable');
    }
  }

  async function serviceActive(serviceUnit) {
    try {
      await run(SYSTEMCTL_PATH, ['is-active', '--quiet', serviceUnit], { timeout: 10_000 });
      return true;
    } catch { return false; }
  }

  async function inspect(runtime) {
    const target = normalizeRuntime(runtime);
    const file = dropInPath(target.serviceUnit);
    let info;
    let content;
    try { [info, content] = await Promise.all([lstatFn(file), readFileFn(file, 'utf8')]); }
    catch (error) {
      if (missing(error)) {
        return Object.freeze({
          satisfied: false,
          reason: 'service_umask_config_missing',
          runtime: target.runtime,
          serviceUnit: target.serviceUnit,
          dropInPath: file,
        });
      }
      throw new ServiceUmaskManagerError('service_umask_config_unavailable', 'Managed runtime umask configuration could not be inspected');
    }
    if (!info?.isFile?.() || info.isSymbolicLink?.() || info.uid !== 0 || info.gid !== 0 || modeOf(info) !== DROPIN_MODE) {
      throw new ServiceUmaskManagerError('service_umask_config_drift', 'Managed runtime umask file ownership or mode has drifted');
    }
    if (content !== desiredConfig()) {
      throw new ServiceUmaskManagerError('service_umask_config_drift', 'Managed runtime umask configuration has drifted');
    }
    if (!(await serviceActive(target.serviceUnit))) {
      return Object.freeze({
        satisfied: false,
        reason: 'service_umask_service_inactive',
        runtime: target.runtime,
        serviceUnit: target.serviceUnit,
        dropInPath: file,
      });
    }
    const effective = await effectiveUmask(target.serviceUnit);
    if (effective !== POLICY_MODE) {
      return Object.freeze({
        satisfied: false,
        reason: 'service_umask_not_effective',
        runtime: target.runtime,
        serviceUnit: target.serviceUnit,
        dropInPath: file,
        effectiveUmask: effective,
      });
    }
    return Object.freeze({
      satisfied: true,
      adapter: 'systemd-umask',
      runtime: target.runtime,
      serviceUnit: target.serviceUnit,
      dropInPath: file,
      umask: '0027',
    });
  }

  async function reloadAndRestart(serviceUnit) {
    try {
      await run(SYSTEMCTL_PATH, ['daemon-reload'], { timeout: 30_000 });
      await run(SYSTEMCTL_PATH, ['restart', serviceUnit], { timeout: 60_000 });
    } catch {
      throw new ServiceUmaskManagerError('service_umask_activation_failed', 'Managed runtime service could not activate UMask=0027');
    }
  }

  async function apply(runtime) {
    const target = normalizeRuntime(runtime);
    const file = dropInPath(target.serviceUnit);
    const current = await readOptional(file);
    if (current !== null && current !== desiredConfig()) {
      throw new ServiceUmaskManagerError('service_umask_config_conflict', 'Existing runtime umask drop-in is not managed by YunPanel');
    }
    if (current === desiredConfig()) {
      const before = await inspect(runtime);
      if (before.satisfied) return before;
    }

    await mkdirFn(path.posix.dirname(file), { recursive: true, mode: 0o755 });
    const created = current === null;
    if (created) await atomicWrite(file, desiredConfig());
    try {
      await reloadAndRestart(target.serviceUnit);
      const verified = await inspect(runtime);
      if (!verified.satisfied) {
        throw new ServiceUmaskManagerError('service_umask_unverified', 'Managed runtime UMask=0027 could not be verified');
      }
      return Object.freeze({ ...verified, created });
    } catch (error) {
      if (created) {
        await rmFn(file, { force: true }).catch(() => {});
        try { await reloadAndRestart(target.serviceUnit); } catch { /* Preserve primary failure. */ }
      }
      if (error instanceof ServiceUmaskManagerError) throw error;
      throw new ServiceUmaskManagerError('service_umask_apply_failed', 'Managed runtime UMask=0027 activation failed');
    }
  }

  return Object.freeze({ inspect, apply });
}

export const serviceUmaskManagerInternals = Object.freeze({
  services: SERVICES,
  policyMode: POLICY_MODE,
  dropInMode: DROPIN_MODE,
  dropInPath,
  desiredConfig,
  parseUmask,
});
