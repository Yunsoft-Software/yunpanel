import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
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
const APT_CACHE = '/usr/bin/apt-cache';
const DPKG_QUERY = '/usr/bin/dpkg-query';
const CURL = '/usr/bin/curl';
const GPG = '/usr/bin/gpg';
const SYSTEMCTL = '/usr/bin/systemctl';
const PACKAGE = 'libnginx-mod-http-passenger';
const VERSION_PATTERN = /^[A-Za-z0-9.+:~_-]{1,120}$/;
const NGINX_PACKAGE_PATTERN = /^nginx(?:-[a-z0-9.+-]+)?$/;
const SUPPORTED = Object.freeze({ id: 'ubuntu', versionId: '24.04', codename: 'noble' });
const APPLY_CHECKPOINTS = Object.freeze([
  'before-repository',
  'after-repository',
  'after-package-install',
  'after-module-link',
  'after-nginx-restart',
  'after-apply-inspection',
]);
const UPGRADE_CHECKPOINTS = Object.freeze([
  'before-package-upgrade',
  'after-package-upgrade',
  'after-nginx-restart',
  'after-upgrade-inspection',
]);

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

function parseAptPolicy(output) {
  const candidate = String(output ?? '').match(/^\s*Candidate:\s*(\S+)\s*$/m)?.[1] ?? null;
  return candidate && candidate !== '(none)' && VERSION_PATTERN.test(candidate) ? candidate : null;
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
  rmFn = rm,
  symlinkFn = symlink,
  writeFileFn = writeFile,
  checkpoint = async () => {},
} = {}) {
  if (!inspector || typeof inspector.inspect !== 'function' || typeof run !== 'function'
    || typeof rmFn !== 'function' || typeof checkpoint !== 'function') {
    throw new PassengerManagerError('passenger_manager_dependencies_invalid', 'Passenger manager dependencies are invalid');
  }
  let activeApply = null;
  let activeUpgrade = null;

  async function runSafe(file, args, options, code, message) {
    try { return await run(file, args, options); }
    catch (error) { throw commandError(error, code, message); }
  }

  async function mutationCheckpoint(name) {
    try { await checkpoint(name); }
    catch {
      throw new PassengerManagerError('passenger_failure_injected', `Passenger mutation stopped at ${name}`);
    }
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

  async function atomicRestore(targetPath, content, mode) {
    const temporary = `${targetPath}.${process.pid}.rollback.tmp`;
    await writeFileFn(temporary, content, { mode });
    await renameFn(temporary, targetPath);
  }

  async function snapshotManagedPath(targetPath, kind) {
    let info;
    try { info = await lstatFn(targetPath); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ kind: 'absent' });
      throw new PassengerManagerError('passenger_install_snapshot_failed', 'Passenger managed state could not be snapshotted');
    }
    if (kind === 'link') {
      if (!info.isSymbolicLink?.()) {
        throw new PassengerManagerError('passenger_module_link_conflict', 'Passenger Nginx module path is not a symbolic link');
      }
      try { return Object.freeze({ kind: 'symlink', target: await readlinkFn(targetPath) }); }
      catch { throw new PassengerManagerError('passenger_install_snapshot_failed', 'Passenger module link could not be snapshotted'); }
    }
    if (!info.isFile?.()) {
      throw new PassengerManagerError('passenger_install_snapshot_failed', 'Passenger managed file state is not a regular file');
    }
    try {
      return Object.freeze({
        kind: 'file',
        content: await readFileFn(targetPath),
        mode: Number.isInteger(info.mode) ? info.mode & 0o777 : 0o644,
      });
    } catch {
      throw new PassengerManagerError('passenger_install_snapshot_failed', 'Passenger managed file content could not be snapshotted');
    }
  }

  async function snapshotManagedState() {
    const [key, repository, moduleLink] = await Promise.all([
      snapshotManagedPath(KEY_PATH, 'file'),
      snapshotManagedPath(REPOSITORY_PATH, 'file'),
      snapshotManagedPath(MODULE_LINK, 'link'),
    ]);
    return Object.freeze({ key, repository, moduleLink });
  }

  async function restoreManagedPath(targetPath, snapshot) {
    try {
      await rmFn(targetPath, { force: true });
      if (snapshot.kind === 'absent') return;
      if (snapshot.kind === 'symlink') {
        await symlinkFn(snapshot.target, targetPath);
        return;
      }
      if (snapshot.kind === 'file') {
        await atomicRestore(targetPath, snapshot.content, snapshot.mode);
        return;
      }
      throw new Error('unsupported snapshot');
    } catch {
      throw new PassengerManagerError('passenger_install_rollback_failed', 'Passenger managed configuration could not be restored');
    }
  }

  async function restoreManagedState(snapshot) {
    await restoreManagedPath(MODULE_LINK, snapshot.moduleLink);
    await restoreManagedPath(REPOSITORY_PATH, snapshot.repository);
    await restoreManagedPath(KEY_PATH, snapshot.key);
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
      if (!info.isSymbolicLink()) {
        throw new PassengerManagerError('passenger_module_link_conflict', 'Passenger Nginx module path is not a symbolic link');
      }
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

  async function rollbackNginxInstalledByApply() {
    let owner = null;
    try {
      const result = await run(DPKG_QUERY, ['-S', NGINX_PATH], { timeout: 5_000 });
      owner = nginxPackageOwner(result?.stdout);
      if (!owner || !NGINX_PACKAGE_PATTERN.test(owner)) {
        throw new PassengerManagerError('passenger_install_rollback_failed', 'New Nginx package ownership is not safely identifiable');
      }
    } catch (error) {
      if (error instanceof PassengerManagerError) throw error;
      if (!Number.isInteger(error?.code) || error.code !== 1) {
        throw new PassengerManagerError('passenger_install_rollback_failed', 'New Nginx package ownership could not be inspected');
      }
    }

    if (owner) {
      const packages = [...new Set(['nginx', owner])];
      await runSafe(
        APT_GET,
        ['remove', '--yes', '--purge', ...packages],
        { timeout: 10 * 60 * 1000 },
        'passenger_install_rollback_failed',
        'New Nginx package could not be removed during Passenger rollback',
      );
    }

    try {
      await lstatFn(NGINX_PATH);
      throw new PassengerManagerError('passenger_install_rollback_incomplete', 'New Nginx binary remains after Passenger rollback');
    } catch (error) {
      if (error instanceof PassengerManagerError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new PassengerManagerError('passenger_install_rollback_failed', 'Nginx rollback state could not be verified');
      }
    }
  }

  async function rollbackApply({ before, nginxBefore, snapshot }) {
    try {
      if (before.installed) {
        if (typeof before.installedVersion !== 'string' || !VERSION_PATTERN.test(before.installedVersion)) {
          throw new PassengerManagerError('passenger_install_rollback_failed', 'Previous Passenger package version is not recoverable');
        }
        await runSafe(
          APT_GET,
          ['install', '--allow-downgrades', '--yes', '--no-install-recommends', `${PACKAGE}=${before.installedVersion}`],
          { timeout: 10 * 60 * 1000 },
          'passenger_install_rollback_failed',
          'Previous Passenger package could not be restored',
        );
      } else {
        await runSafe(
          APT_GET,
          ['remove', '--yes', '--purge', PACKAGE],
          { timeout: 10 * 60 * 1000 },
          'passenger_install_rollback_failed',
          'New Passenger package could not be removed during rollback',
        );
      }
      if (!nginxBefore.installed) await rollbackNginxInstalledByApply();
      await restoreManagedState(snapshot);
      if (nginxBefore.installed) {
        await runSafe(
          NGINX_PATH,
          ['-t'],
          { timeout: 30_000 },
          'passenger_install_rollback_failed',
          'Nginx rejected restored Passenger configuration',
        );
        await runSafe(
          SYSTEMCTL,
          ['restart', 'nginx'],
          { timeout: 60_000 },
          'passenger_install_rollback_failed',
          'Nginx could not restart after Passenger rollback',
        );
      }
      const restored = await inspector.inspect();
      if (restored?.installed !== before.installed
        || (before.installed && restored.installedVersion !== before.installedVersion)
        || restored?.healthy !== before.healthy) {
        throw new PassengerManagerError('passenger_install_rollback_failed', 'Passenger rollback did not restore the previous runtime state');
      }
      return restored;
    } catch (error) {
      if (error instanceof PassengerManagerError
        && ['passenger_install_rollback_failed', 'passenger_install_rollback_incomplete'].includes(error.code)) throw error;
      throw new PassengerManagerError('passenger_install_rollback_failed', 'Passenger rollback could not restore the previous runtime state');
    }
  }

  async function applyUnlocked() {
    const before = await inspector.inspect();
    if (before.healthy) return Object.freeze({ changed: false, ...before });

    await platform();
    const nginxBefore = await assertCompatibleNginx();
    const snapshot = await snapshotManagedState();
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
    await mutationCheckpoint('before-repository');
    let mutationAttempted = false;
    try {
      mutationAttempted = true;
      await installRepository();
      await mutationCheckpoint('after-repository');
      await runSafe(
        APT_GET,
        ['update'],
        { timeout: 10 * 60 * 1000 },
        'passenger_repository_update_failed',
        'Passenger APT repository could not be refreshed',
      );
      await runSafe(
        APT_GET,
        ['install', '--yes', '--no-install-recommends', 'nginx', PACKAGE],
        { timeout: 10 * 60 * 1000 },
        'passenger_package_install_failed',
        'Passenger Nginx package could not be installed',
      );
      await mutationCheckpoint('after-package-install');
      await ensureModuleLink();
      await mutationCheckpoint('after-module-link');
      await runSafe(NGINX_PATH, ['-t'], { timeout: 30_000 }, 'passenger_nginx_config_invalid', 'Nginx rejected the Passenger installation');
      await runSafe(SYSTEMCTL, ['restart', 'nginx'], { timeout: 60_000 }, 'passenger_nginx_restart_failed', 'Nginx could not restart with Passenger enabled');
      await mutationCheckpoint('after-nginx-restart');

      const after = await inspector.inspect();
      await mutationCheckpoint('after-apply-inspection');
      if (!after.healthy) {
        throw new PassengerManagerError('passenger_install_incomplete', 'Passenger installation completed without a healthy Nginx integration');
      }
      return Object.freeze({ changed: true, ...after });
    } catch (error) {
      if (mutationAttempted) {
        try { await rollbackApply({ before, nginxBefore, snapshot }); }
        catch (rollbackError) { throw rollbackError; }
      }
      if (error instanceof PassengerManagerError) throw error;
      throw new PassengerManagerError('passenger_install_failed', 'Passenger installation failed');
    }
  }

  async function upgradeCandidate() {
    const result = await runSafe(
      APT_CACHE,
      ['policy', PACKAGE],
      { timeout: 30_000 },
      'passenger_upgrade_inspection_failed',
      'Passenger upgrade candidate could not be inspected',
    );
    const candidateVersion = parseAptPolicy(result?.stdout);
    if (!candidateVersion) {
      throw new PassengerManagerError('passenger_upgrade_candidate_missing', 'Passenger APT repository does not provide an upgrade candidate');
    }
    return candidateVersion;
  }

  async function rollbackUpgrade(previousVersion) {
    try {
      await runSafe(
        APT_GET,
        ['install', '--allow-downgrades', '--yes', '--no-install-recommends', `${PACKAGE}=${previousVersion}`],
        { timeout: 10 * 60 * 1000 },
        'passenger_upgrade_rollback_failed',
        'Passenger package rollback failed',
      );
      await runSafe(
        NGINX_PATH,
        ['-t'],
        { timeout: 30_000 },
        'passenger_upgrade_rollback_failed',
        'Nginx rejected the rolled-back Passenger configuration',
      );
      await runSafe(
        SYSTEMCTL,
        ['restart', 'nginx'],
        { timeout: 60_000 },
        'passenger_upgrade_rollback_failed',
        'Nginx could not restart after Passenger rollback',
      );
      const restored = await inspector.inspect();
      if (!restored?.healthy || restored.installedVersion !== previousVersion) {
        throw new PassengerManagerError('passenger_upgrade_rollback_failed', 'Passenger rollback did not restore the previous healthy package');
      }
      return restored;
    } catch (error) {
      if (error instanceof PassengerManagerError && error.code === 'passenger_upgrade_rollback_failed') throw error;
      throw new PassengerManagerError('passenger_upgrade_rollback_failed', 'Passenger rollback could not restore the previous healthy package');
    }
  }

  async function upgradeUnlocked() {
    const before = await inspector.inspect();
    if (!before?.installed || !before.healthy || typeof before.installedVersion !== 'string' || !VERSION_PATTERN.test(before.installedVersion)) {
      throw new PassengerManagerError('passenger_upgrade_requires_healthy_install', 'Passenger must be healthy before an in-place upgrade');
    }
    await platform();
    await assertCompatibleNginx();
    await runSafe(
      APT_GET,
      ['update'],
      { timeout: 10 * 60 * 1000 },
      'passenger_apt_update_failed',
      'APT package indexes could not be refreshed for Passenger',
    );
    const candidateVersion = await upgradeCandidate();
    if (candidateVersion === before.installedVersion) {
      return Object.freeze({
        changed: false,
        upgraded: false,
        previousVersion: before.installedVersion,
        candidateVersion,
        ...before,
      });
    }

    await mutationCheckpoint('before-package-upgrade');
    let mutationAttempted = false;
    try {
      mutationAttempted = true;
      await runSafe(
        APT_GET,
        ['install', '--only-upgrade', '--yes', '--no-install-recommends', PACKAGE],
        { timeout: 10 * 60 * 1000 },
        'passenger_package_upgrade_failed',
        'Passenger package could not be upgraded',
      );
      await mutationCheckpoint('after-package-upgrade');
      await runSafe(NGINX_PATH, ['-t'], { timeout: 30_000 }, 'passenger_nginx_config_invalid', 'Nginx rejected the upgraded Passenger installation');
      await runSafe(SYSTEMCTL, ['restart', 'nginx'], { timeout: 60_000 }, 'passenger_nginx_restart_failed', 'Nginx could not restart after Passenger upgrade');
      await mutationCheckpoint('after-nginx-restart');
      const after = await inspector.inspect();
      await mutationCheckpoint('after-upgrade-inspection');
      if (!after?.healthy || after.installedVersion !== candidateVersion || after.installedVersion === before.installedVersion) {
        throw new PassengerManagerError('passenger_upgrade_incomplete', 'Passenger upgrade did not reach the expected healthy package version');
      }
      return Object.freeze({
        changed: true,
        upgraded: true,
        previousVersion: before.installedVersion,
        candidateVersion,
        ...after,
      });
    } catch (error) {
      if (mutationAttempted) {
        try { await rollbackUpgrade(before.installedVersion); }
        catch (rollbackError) { throw rollbackError; }
      }
      if (error instanceof PassengerManagerError) throw error;
      throw new PassengerManagerError('passenger_upgrade_failed', 'Passenger upgrade failed');
    }
  }

  async function apply() {
    if (activeUpgrade) throw new PassengerManagerError('passenger_mutation_in_progress', 'Passenger upgrade is already running');
    if (activeApply) return activeApply;
    activeApply = applyUnlocked();
    try { return await activeApply; }
    finally { activeApply = null; }
  }

  async function upgrade() {
    if (activeApply || activeUpgrade) {
      throw new PassengerManagerError('passenger_mutation_in_progress', 'Another Passenger mutation is already running');
    }
    activeUpgrade = upgradeUnlocked();
    try { return await activeUpgrade; }
    finally { activeUpgrade = null; }
  }

  return Object.freeze({ inspect: () => inspector.inspect(), apply, upgrade });
}

export const passengerManagerInternals = Object.freeze({
  parseOsRelease,
  supportedPlatform,
  nginxPackageOwner,
  repositoryContent,
  parseAptPolicy,
  supportedPlatformIdentity: SUPPORTED,
  keyUrl: KEY_URL,
  keyPath: KEY_PATH,
  repositoryPath: REPOSITORY_PATH,
  moduleSource: MODULE_SOURCE,
  moduleLink: MODULE_LINK,
  packageName: PACKAGE,
  applyCheckpoints: APPLY_CHECKPOINTS,
  upgradeCheckpoints: UPGRADE_CHECKPOINTS,
});
