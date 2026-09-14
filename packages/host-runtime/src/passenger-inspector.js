import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PASSENGER_CONFIG = '/usr/bin/passenger-config';
const NGINX = '/usr/sbin/nginx';
const NODE = '/usr/bin/node';
const DPKG_QUERY = '/usr/bin/dpkg-query';
const PACKAGE = 'libnginx-mod-http-passenger';
const VERSION_PATTERN = /^[A-Za-z0-9.+:~_-]{1,120}$/;
const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;

export class PassengerInspectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PassengerInspectorError';
    this.code = code;
  }
}

function parsePackage(stdout) {
  const match = String(stdout ?? '').trim().match(/^install ok installed\t([^\s]+)$/);
  if (!match || !VERSION_PATTERN.test(match[1])) return null;
  return match[1];
}

function parseRoot(stdout) {
  const value = String(stdout ?? '').trim();
  return value.startsWith('/') && !/[\r\n\0]/.test(value) ? value : null;
}

function parseNginxConfig(output) {
  const text = String(output ?? '');
  const moduleLoaded = /(?:^|\n)\s*load_module\s+[^;]*ngx_http_passenger_module\.so\s*;/m.test(text);
  const rootMatches = [...text.matchAll(/(?:^|\n)\s*passenger_root\s+([^;\s]+)\s*;/gm)];
  const roots = [...new Set(rootMatches.map((match) => match[1]))];
  return Object.freeze({ moduleLoaded, roots: Object.freeze(roots) });
}

function commandFailure(error, code, message) {
  const wrapped = new PassengerInspectorError(code, message);
  wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null;
  return wrapped;
}

export function createPassengerInspector({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 15_000,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  }),
} = {}) {
  if (typeof run !== 'function') throw new PassengerInspectorError('passenger_inspector_dependencies_invalid', 'Passenger inspector dependencies are invalid');

  async function packageVersion() {
    try {
      const result = await run(DPKG_QUERY, ['-W', '-f=${Status}\t${Version}', PACKAGE], { timeout: 5_000 });
      return parsePackage(result?.stdout);
    } catch (error) {
      if (Number.isInteger(error?.code) && error.code === 1) return null;
      throw commandFailure(error, 'passenger_package_inspection_failed', 'Passenger package state could not be inspected');
    }
  }

  async function passengerRoot() {
    try {
      const result = await run(PASSENGER_CONFIG, ['--root'], { timeout: 5_000 });
      const root = parseRoot(result?.stdout);
      if (!root) throw new PassengerInspectorError('passenger_root_invalid', 'Passenger reported an invalid root path');
      return root;
    } catch (error) {
      if (error instanceof PassengerInspectorError) throw error;
      throw commandFailure(error, 'passenger_config_unavailable', 'Passenger configuration tool is unavailable');
    }
  }

  async function validateInstall() {
    try {
      await run(PASSENGER_CONFIG, ['validate-install'], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      return true;
    } catch (error) {
      throw commandFailure(error, 'passenger_install_invalid', 'Passenger installation validation failed');
    }
  }

  async function nginxConfiguration() {
    let result;
    try {
      result = await run(NGINX, ['-T'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      throw commandFailure(error, 'passenger_nginx_config_invalid', 'Nginx configuration could not be validated for Passenger');
    }
    return parseNginxConfig(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`);
  }

  async function optionalSystemNodeVersion() {
    try {
      const result = await run(NODE, ['--version'], { timeout: 5_000 });
      const value = String(result?.stdout ?? '').trim();
      return NODE_VERSION_PATTERN.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function inspect() {
    const installedVersion = await packageVersion();
    if (!installedVersion) {
      return Object.freeze({
        packageName: PACKAGE,
        installed: false,
        installedVersion: null,
        passengerRoot: null,
        nginxPassengerRoots: Object.freeze([]),
        moduleLoaded: false,
        installValid: false,
        systemNodeVersion: null,
        healthy: false,
      });
    }

    const [root, config, systemNodeVersion] = await Promise.all([
      passengerRoot(),
      nginxConfiguration(),
      optionalSystemNodeVersion(),
    ]);
    await validateInstall();
    const rootConfigured = config.roots.length === 1 && config.roots[0] === root;
    return Object.freeze({
      packageName: PACKAGE,
      installed: true,
      installedVersion,
      passengerRoot: root,
      nginxPassengerRoots: config.roots,
      moduleLoaded: config.moduleLoaded,
      installValid: true,
      systemNodeVersion,
      healthy: config.moduleLoaded && rootConfigured,
    });
  }

  return Object.freeze({ inspect });
}

export const passengerInspectorInternals = Object.freeze({
  parsePackage,
  parseRoot,
  parseNginxConfig,
  PACKAGE,
});
