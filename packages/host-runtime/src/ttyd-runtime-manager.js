import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DPKG_QUERY = '/usr/bin/dpkg-query';
const APT_GET = '/usr/bin/apt-get';
const SYSTEMCTL = '/usr/bin/systemctl';
const TTYD = '/usr/bin/ttyd';
const PACKAGE = 'ttyd';
const SERVICE = 'ttyd.service';
const MAX_OUTPUT = 64 * 1024;
const VERSION_PATTERN = /^ttyd version ([0-9]+\.[0-9]+\.[0-9]+)$/;

export class TtydRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TtydRuntimeError';
    this.code = code;
  }
}

function boundedOutput(result) {
  const stdout = String(result?.stdout ?? '');
  const stderr = String(result?.stderr ?? '');
  if (Buffer.byteLength(stdout) > MAX_OUTPUT || Buffer.byteLength(stderr) > MAX_OUTPUT) {
    throw new Error('ttyd command output exceeded bound');
  }
  return stdout.trim();
}

function modeOf(info) {
  return Number(info?.mode ?? 0) & 0o7777;
}

function parseServiceState(value) {
  const fields = {};
  for (const line of String(value ?? '').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  if (!['loaded', 'masked'].includes(fields.LoadState)
    || !['inactive', 'failed'].includes(fields.ActiveState)
    || fields.UnitFileState !== 'masked') return null;
  return Object.freeze({
    loadState: fields.LoadState,
    activeState: fields.ActiveState,
    unitFileState: fields.UnitFileState,
  });
}

export function createTtydRuntimeManager({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: MAX_OUTPUT,
    env: options.env,
    windowsHide: true,
  }),
  lstatFn = lstat,
  getuid = process.getuid?.bind(process),
} = {}) {
  if (typeof run !== 'function' || typeof lstatFn !== 'function' || typeof getuid !== 'function') {
    throw new TypeError('ttyd runtime dependencies are invalid');
  }

  async function inspectPackage() {
    try {
      const result = await run(DPKG_QUERY, ['-W', '-f=${Status}\t${Version}', PACKAGE], {
        timeout: 10_000,
      });
      const output = boundedOutput(result);
      const match = output.match(/^install ok installed\t([^\s]+)$/);
      return Object.freeze({ installed: Boolean(match), packageVersion: match?.[1] ?? null });
    } catch (error) {
      if (Number.isInteger(error?.code) && error.code === 1) {
        return Object.freeze({ installed: false, packageVersion: null });
      }
      throw new TtydRuntimeError(
        'ttyd_package_inspection_failed',
        'ttyd package state could not be inspected',
      );
    }
  }

  async function inspectBinary() {
    let info;
    try { info = await lstatFn(TTYD); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ satisfied: false, reason: 'ttyd_binary_missing' });
      throw new TtydRuntimeError(
        'ttyd_binary_inspection_failed',
        'ttyd binary state could not be inspected',
      );
    }
    if (!info?.isFile?.() || info.isSymbolicLink?.() || info.uid !== 0 || info.gid !== 0
      || (modeOf(info) & 0o022) !== 0) {
      throw new TtydRuntimeError(
        'ttyd_binary_unsafe',
        'ttyd binary ownership or permissions are unsafe',
      );
    }
    try {
      const version = boundedOutput(await run(TTYD, ['--version'], { timeout: 10_000 }));
      const match = version.match(VERSION_PATTERN);
      if (!match) throw new Error('invalid version');
      return Object.freeze({ satisfied: true, binaryVersion: match[1] });
    } catch {
      throw new TtydRuntimeError(
        'ttyd_binary_unverified',
        'ttyd binary version could not be verified',
      );
    }
  }

  async function inspectService() {
    try {
      const result = await run(SYSTEMCTL, [
        'show',
        SERVICE,
        '--no-pager',
        '--property=LoadState',
        '--property=ActiveState',
        '--property=UnitFileState',
      ], { timeout: 10_000 });
      const state = parseServiceState(boundedOutput(result));
      return state
        ? Object.freeze({ satisfied: true, ...state })
        : Object.freeze({ satisfied: false, reason: 'ttyd_service_not_masked' });
    } catch {
      return Object.freeze({ satisfied: false, reason: 'ttyd_service_state_unavailable' });
    }
  }

  async function inspect() {
    const packageState = await inspectPackage();
    if (!packageState.installed) {
      return Object.freeze({ satisfied: false, reason: 'ttyd_package_missing' });
    }
    const binary = await inspectBinary();
    if (!binary.satisfied) return binary;
    const service = await inspectService();
    if (!service.satisfied) return service;
    return Object.freeze({
      satisfied: true,
      packageName: PACKAGE,
      packageVersion: packageState.packageVersion,
      binaryPath: TTYD,
      binaryVersion: binary.binaryVersion,
      distroService: SERVICE,
      distroServiceMasked: true,
      distroServiceActive: false,
    });
  }

  async function maskService({ now = false } = {}) {
    try {
      await run(SYSTEMCTL, now ? ['mask', '--now', SERVICE] : ['mask', SERVICE], {
        timeout: 30_000,
      });
    } catch {
      throw new TtydRuntimeError(
        'ttyd_service_mask_failed',
        'ttyd distro service could not be masked',
      );
    }
  }

  async function apply() {
    if (getuid() !== 0) {
      throw new TtydRuntimeError(
        'ttyd_root_runtime_required',
        'ttyd package provisioning requires the root panel service',
      );
    }

    const current = await inspect();
    if (current.satisfied) return Object.freeze({ ...current, changed: false });

    await maskService();
    const packageState = await inspectPackage();
    if (!packageState.installed) {
      try {
        await run(APT_GET, ['install', '--yes', '--no-install-recommends', PACKAGE], {
          timeout: 10 * 60_000,
          env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
        });
      } catch {
        throw new TtydRuntimeError(
          'ttyd_package_install_failed',
          'ttyd package could not be installed',
        );
      }
    }
    await maskService({ now: true });

    const verified = await inspect();
    if (!verified.satisfied) {
      throw new TtydRuntimeError(
        'ttyd_runtime_unverified',
        'ttyd runtime could not be verified after installation',
      );
    }
    return Object.freeze({ ...verified, changed: true });
  }

  return Object.freeze({ inspect, apply });
}

export const ttydRuntimeInternals = Object.freeze({
  paths: Object.freeze({ DPKG_QUERY, APT_GET, SYSTEMCTL, TTYD }),
  packageName: PACKAGE,
  serviceUnit: SERVICE,
  versionPattern: VERSION_PATTERN,
  boundedOutput,
  modeOf,
  parseServiceState,
});
