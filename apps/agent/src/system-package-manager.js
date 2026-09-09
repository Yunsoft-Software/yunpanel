import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = 'yunpanel';
const VERSION_PATTERN = /^[A-Za-z0-9.+:~_-]{1,100}$/;

export class SystemPackageManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SystemPackageManagerError';
    this.code = code;
  }
}

function normalizeVersion(value) {
  const version = typeof value === 'string' ? value.trim() : '';
  return VERSION_PATTERN.test(version) && version !== '(none)' ? version : null;
}

function parsePolicy(output) {
  const installed = output.match(/^\s*Installed:\s*(\S+)\s*$/m)?.[1] ?? null;
  const candidate = output.match(/^\s*Candidate:\s*(\S+)\s*$/m)?.[1] ?? null;
  return { installedVersion: normalizeVersion(installed), candidateVersion: normalizeVersion(candidate) };
}

function packageState({ installedVersion, candidateVersion }) {
  return {
    packageName: PACKAGE_NAME,
    installed: Boolean(installedVersion),
    installedVersion,
    candidateVersion,
    updateAvailable: Boolean(installedVersion && candidateVersion && installedVersion !== candidateVersion),
  };
}

export function createSystemPackageManager({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    timeout: 10 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  }),
  restartDelaySeconds = 10,
  now = Date.now,
} = {}) {
  let activeUpgrade = null;

  async function inspect() {
    let policy;
    try {
      policy = await run('/usr/bin/apt-cache', ['policy', PACKAGE_NAME], {
        env: { ...process.env, LC_ALL: 'C' },
      });
    } catch {
      throw new SystemPackageManagerError('apt_inspection_failed', 'Unable to inspect the YunPanel APT package');
    }
    return packageState(parsePolicy(policy.stdout));
  }

  async function scheduleServiceRestart() {
    const unitName = `yunpanel-upgrade-restart-${now()}`;
    try {
      await run('/usr/bin/systemd-run', [
        `--unit=${unitName}`,
        `--on-active=${restartDelaySeconds}s`,
        '--timer-property=AccuracySec=1s',
        '/bin/systemctl',
        'restart',
        'yunpanel-api.service',
        'yunpanel-web.service',
        'yun-agent.service',
      ]);
    } catch {
      throw new SystemPackageManagerError('restart_schedule_failed', 'YunPanel was upgraded but its service restart could not be scheduled');
    }
  }

  async function performUpgrade() {
    const before = await inspect();
    if (!before.installed) throw new SystemPackageManagerError('yunpanel_not_packaged', 'YunPanel is not installed as an APT package');

    try {
      await run('/usr/bin/apt-get', ['update'], {
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
      });
    } catch {
      throw new SystemPackageManagerError('apt_update_failed', 'APT package indexes could not be refreshed');
    }

    const available = await inspect();
    if (!available.updateAvailable) {
      return { ...available, previousVersion: before.installedVersion, upgraded: false, restartScheduled: false };
    }

    try {
      await run('/usr/bin/apt-get', [
        'install',
        '--only-upgrade',
        '--yes',
        '--no-install-recommends',
        PACKAGE_NAME,
      ], {
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
      });
    } catch {
      throw new SystemPackageManagerError('yunpanel_upgrade_failed', 'APT could not upgrade the YunPanel package');
    }

    const after = await inspect();
    if (!after.installedVersion || after.installedVersion === before.installedVersion) {
      throw new SystemPackageManagerError('yunpanel_upgrade_incomplete', 'APT completed without installing the expected YunPanel update');
    }
    await scheduleServiceRestart();
    return {
      ...after,
      previousVersion: before.installedVersion,
      upgraded: true,
      restartScheduled: true,
    };
  }

  async function upgrade() {
    if (activeUpgrade) throw new SystemPackageManagerError('upgrade_in_progress', 'A YunPanel package upgrade is already running');
    const operation = performUpgrade();
    activeUpgrade = operation;
    try {
      return await operation;
    } finally {
      if (activeUpgrade === operation) activeUpgrade = null;
    }
  }

  return { inspect, upgrade };
}

export const systemPackageManager = createSystemPackageManager();
export const systemPackageManagerInternals = Object.freeze({ normalizeVersion, parsePolicy, packageState });
