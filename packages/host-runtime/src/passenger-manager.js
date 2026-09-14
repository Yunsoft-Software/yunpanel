import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPassengerInspector } from './passenger-inspector.js';

const execFileAsync = promisify(execFile);
const OS_RELEASE = '/etc/os-release';
const STAGING_ROOT = '/var/lib/yunpanel/staging/passenger';
const KEY_URL = 'https://oss-binaries.phusionpassenger.com/auto-software-signing-gpg-key-2025.txt';
const KEY_PATH = '/usr/share/keyrings/yunpanel-phusion-passenger.gpg';
const REPOSITORY_PATH = '/etc/apt/sources.list.d/passenger.list';
const MODULE_SOURCE = '/usr/share/nginx/modules-available/mod-http-passenger.load';
const MODULE_LINK = '/etc/nginx/modules-enabled/50-mod-http-passenger.conf';
const NGINX_PATH = '/usr/sbin/nginx';
const APT_GET = '/usr/bin/apt-get';
const DPKG_QUERY = '/usr/bin/dpkg-query';
const CURL = '/usr/bin/curl';
const GPG = '/usr/bin/gpg';
const SYSTEMCTL = '/usr/bin/systemctl';
const SUPPORTED = Object.freeze({ id: 'ubuntu', versionId: '24.04', codename: 'noble' });

export class PassengerManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PassengerManagerError';
    this.code = code;
  }
}

function parseOsRelease(content) {
  const values = new Map();
  for (const line of String(content ?? '').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/[\r\n\0]/.test(value)) values.set(match[1], value);
  }
  return Object.freeze({
    id: values.get('ID') ?? null,
    versionId: values.get('VERSION_ID') ?? null,
    codename: values.get('VERSION_CODENAME') ?? null,
  });
}

function supportedPlatform(platform) {
  return platform.id === SUPPORTED.id
    && platform.versionId === SUPPORTED.versionId
    && platform.codename === SUPPORTED.codename;
}

function nginxPackageOwner(stdout) {
  const value = String(stdout ?? '').trim();
  const match = value.match(/^([^:\s]+)(?::[^:]+)?:\s+\/usr\/sbin\/nginx$/);
  return match?.[1] ?? null;
}

function repositoryContent() {
  return `deb [signed-by=${KEY_PATH}] https://oss-binaries.phusionpassenger.com/apt/passenger ${SUPPORTED.codename} main\n`;
}

function commandError(error, code, message) {
  const wrapped = new PassengerManagerError(code, message);
  wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null;
  return wrapped;
}

export function createPassengerManager({
  inspector = createPassengerInspector(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    env: options.env ?? { ...process.env, LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' },
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  readlinkFn = readlink,
  renameFn = rename,
  symlinkFn = symlink,
  writeFileFn = writeFile,
} = {}) {
  if (!inspector || typeof inspector.inspect !== 'function' || typeof run !== 'function') {
    throw new PassengerManagerError('passenger_manager_dependencies_invalid', 'Passenger manager dependencies are invalid');
  }
  let activeApply = null;

  async function runSafe(file, args, options, code, message) {
    try { return await run(file, args, options); }
    catch (error) { throw commandError(error, code, message); }
  }

  async function platform() {
    let content;
    try { content = await readFileFn(OS_RELEASE, 'utf8'); }
    catch { throw new PassengerManagerError('passenger_platform_unavailable', 'Operating system identity could not be inspected'); }
    const parsed = parseOsRelease(content);
    if (!supportedPlatform(parsed)) {
      throw new PassengerManagerError('passenger_platform_unsupported', 'Managed Passenger installation currently requires Ubuntu 24.04 LTS');
    }
    return parsed;
  }

  async function assertCompatibleNginx() {
    try {
      const result = await run(DPKG_QUERY, ['-S', NGINX_PATH], { timeout: 5_000 });
      const owner = nginxPackageOwner(result?.stdout);
      if (!owner || !owner.startsWith('nginx')) {
        throw new PassengerManagerError('passenger_nginx_incompatible', 'Passenger packages require distro-managed Nginx');
      }
      return Object.freeze({ installed: true, packageName: owner });
    } catch (error) {
      if (error instanceof PassengerManagerError) throw error;
      if (Number.isInteger(error?.code) && error.code !== 1) {
        throw commandError(error, 'passenger_nginx_inspection_failed', 'Nginx package ownership could not be inspected');
      }
      try {
        await lstatFn(NGINX_PATH);
        throw new PassengerManagerError('passenger_nginx_incompatible', 'Existing Nginx is not owned by the distro package manager');
      } catch (statError) {
        if (statError instanceof PassengerManagerError) throw statError;
        if (statError?.code !== 'ENOENT') {
          throw new PassengerManagerError('passenger_nginx_inspection_failed', 'Nginx binary state could not be inspected');
        }
      }
      return Object.freeze({ installed: false, packageName: null });
    }
  }

  async function atomicWrite(targetPath, content, mode) {
    const temporary = `${targetPath}.${process.pid}.tmp`;
    await writeFileFn(temporary, content, { encoding: 'utf8', mode });
    await renameFn(temporary, targetPath);
  }

  async function installRepository() {
    await mkdirFn(STAGING_ROOT, { recursive: true, mode: 0o700 });
    await mkdirFn(path.dirname(KEY_PATH), { recursive: true, mode: 0o755 });
    const source = path.join(STAGING_ROOT, `phusion-key-${process.pid}.asc`);
    const dearmored = path.join(STAGING_ROOT, `phusion-key-${process.pid}.gpg`);
    await runSafe(
      CURL,
      ['--fail', '--silent', '--show-error', '--location', '--output', source, KEY_URL],
      { timeout: 60_000 },
      'passenger_repository_key_download_failed',
      'Passenger repository signing key could not be downloaded',
    );
    await runSafe(
      GPG,
      ['--batch', '--yes', '--dearmor', '--output', dearmored, source],
      { timeout: 30_000 },
      'passenger_repository_key_invalid',
      'Passenger repository signing key could not be prepared',
    );
    let key;
    try { key = await readFileFn(dearmored); }
    catch { throw new PassengerManagerError('passenger_repository_key_invalid', 'Passenger repository signing key could not be read'); }
    const keyTemp = `${KEY_PATH}.${process.pid}.tmp`;
    await writeFileFn(keyTemp, key, { mode: 0o644 });
    await renameFn(keyTemp, KEY_PATH);
    await atomicWrite(REPOSITORY_PATH, repositoryContent(), 0o644);
  }

  async function ensureModuleLink() {
    try {
      const info = await lstatFn(MODULE_LINK);
      if (!info.isSymbolicLink()) return;
      const target = await readlinkFn(MODULE_LINK);
      if (target === MODULE_SOURCE) return;
      throw new PassengerManagerError('passenger_module_link_conflict', 'Passenger Nginx module link points to an unexpected target');
    } catch (error) {
      if (error instanceof PassengerManagerError) throw error;
      if (error?.code !== 'ENOENT') throw new PassengerManagerError('passenger_module_link_inspection_failed', 'Passenger Nginx module link could not be inspected');
    }
    await mkdirFn(path.dirname(MODULE_LINK), { recursive: true, mode: 0o755 });
    try { await symlinkFn(MODULE_SOURCE, MODULE_LINK); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw new PassengerManagerError('passenger_module_link_failed', 'Passenger Nginx module could not be enabled');
    }
  }

  async function applyUnlocked() {
    const before = await inspector.inspect();
    if (before.healthy) return Object.freeze({ changed: false, ...before });

    await platform();
    await assertCompatibleNginx();
    await runSafe(
      APT_GET,
      ['update'],
      { timeout: 10 * 60 * 1000 },
      'passenger_apt_update_failed',
      'APT package indexes could not be refreshed for Passenger',
    );
    await runSafe(
      APT_GET,
      ['install', '--yes', '--no-install-recommends', 'ca-certificates', 'curl', 'gnupg'],
      { timeout: 10 * 60 * 1000 },
      'passenger_prerequisites_failed',
      'Passenger package prerequisites could not be installed',
    );
    await installRepository();
    await runSafe(
      APT_GET,
      ['update'],
      { timeout: 10 * 60 * 1000 },
      'passenger_repository_update_failed',
      'Passenger APT repository could not be refreshed',
    );
    await runSafe(
      APT_GET,
      ['install', '--yes', '--no-install-recommends', 'nginx', 'libnginx-mod-http-passenger'],
      { timeout: 10 * 60 * 1000 },
      'passenger_package_install_failed',
      'Passenger Nginx package could not be installed',
    );
    await ensureModuleLink();
    await runSafe(NGINX_PATH, ['-t'], { timeout: 30_000 }, 'passenger_nginx_config_invalid', 'Nginx rejected the Passenger installation');
    await runSafe(SYSTEMCTL, ['restart', 'nginx'], { timeout: 60_000 }, 'passenger_nginx_restart_failed', 'Nginx could not restart with Passenger enabled');

    const after = await inspector.inspect();
    if (!after.healthy) {
      throw new PassengerManagerError('passenger_install_incomplete', 'Passenger installation completed without a healthy Nginx integration');
    }
    return Object.freeze({ changed: true, ...after });
  }

  async function apply() {
    if (activeApply) return activeApply;
    activeApply = applyUnlocked();
    try { return await activeApply; }
    finally { activeApply = null; }
  }

  return Object.freeze({ inspect: () => inspector.inspect(), apply });
}

export const passengerManagerInternals = Object.freeze({
  parseOsRelease,
  supportedPlatform,
  nginxPackageOwner,
  repositoryContent,
  supportedPlatformIdentity: SUPPORTED,
  keyUrl: KEY_URL,
  keyPath: KEY_PATH,
  repositoryPath: REPOSITORY_PATH,
  moduleSource: MODULE_SOURCE,
  moduleLink: MODULE_LINK,
});
