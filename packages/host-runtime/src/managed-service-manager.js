import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSystemdProperties } from './systemd-inspector.js';

const execFileAsync = promisify(execFile);
const DPKG_QUERY = '/usr/bin/dpkg-query';
const APT_GET = '/usr/bin/apt-get';
const SYSTEMCTL = '/usr/bin/systemctl';
const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart']);
const CONFIGURATION_STATES = Object.freeze({
  NOT_CHECKED: 'not_checked',
  NOT_APPLICABLE: 'not_applicable',
  VALID: 'valid',
  INVALID: 'invalid',
});

function service(definition) {
  return Object.freeze({
    ...definition,
    packages: Object.freeze([...definition.packages]),
    units: Object.freeze([...definition.units]),
    configurationChecks: Object.freeze((definition.configurationChecks ?? []).map((check) => Object.freeze({
      file: check.file,
      args: Object.freeze([...check.args]),
    }))),
    conflicts: Object.freeze([...(definition.conflicts ?? [])]),
  });
}

const SERVICE_CATALOG = Object.freeze([
  service({ id: 'nginx', label: 'Nginx', category: 'web', packages: ['nginx'], units: ['nginx.service'] }),
  service({ id: 'mariadb', label: 'MariaDB', category: 'database', packages: ['mariadb-server'], units: ['mariadb.service'], conflicts: ['mysql'] }),
  service({ id: 'mysql', label: 'MySQL', category: 'database', packages: ['mysql-server'], units: ['mysql.service'], conflicts: ['mariadb'] }),
  service({ id: 'docker', label: 'Docker', category: 'containers', packages: ['docker.io'], units: ['docker.service'] }),
  service({ id: 'cron', label: 'Cron', category: 'scheduler', packages: ['cron'], units: ['cron.service'] }),
  service({
    id: 'postfix', label: 'Postfix', category: 'mail', packages: ['postfix'], units: ['postfix.service'],
    configurationChecks: [{ file: '/usr/sbin/postfix', args: ['check'] }],
  }),
  service({
    id: 'dovecot',
    label: 'Dovecot',
    category: 'mail',
    packages: ['dovecot-imapd', 'dovecot-lmtpd', 'dovecot-sieve'],
    units: ['dovecot.service'],
    configurationChecks: [{ file: '/usr/bin/doveconf', args: ['-n'] }],
  }),
  service({
    id: 'rspamd', label: 'Rspamd', category: 'mail', packages: ['rspamd'], units: ['rspamd.service'],
    configurationChecks: [{ file: '/usr/bin/rspamadm', args: ['configtest'] }],
  }),
  service({
    id: 'roundcube', label: 'Roundcube', category: 'mail', packages: ['roundcube-core'], units: [],
    configurationChecks: [
      { file: '/usr/bin/test', args: ['-f', '/usr/share/roundcube/index.php'] },
      { file: '/usr/bin/test', args: ['-f', '/etc/roundcube/config.inc.php'] },
      { file: '/usr/bin/php', args: ['-l', '/etc/roundcube/config.inc.php'] },
    ],
  }),
]);
const SERVICE_BY_ID = new Map(SERVICE_CATALOG.map((entry) => [entry.id, entry]));

export class ManagedServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedServiceError';
    this.code = code;
  }
}

function parsePackageStatus(packageName, output) {
  const [status = '', version = ''] = String(output ?? '').trim().split('\t');
  const installed = status === 'install ok installed';
  return { packageName, installed, version: installed && version ? version : null };
}

function requireService(serviceId) {
  const definition = SERVICE_BY_ID.get(serviceId);
  if (!definition) throw new ManagedServiceError('unsupported_managed_service', 'Managed service is not supported');
  return definition;
}

function requireAction(action) {
  if (!SERVICE_ACTIONS.has(action)) {
    throw new ManagedServiceError('unsupported_managed_service_action', 'Managed service action is not supported');
  }
  return action;
}

export function createManagedServiceManager({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    ...options,
  }),
} = {}) {
  let activeMutation = null;

  async function inspectPackage(packageName) {
    try {
      const { stdout } = await run(DPKG_QUERY, ['-W', '-f=${Status}\t${Version}', packageName], {
        env: { ...process.env, LC_ALL: 'C' },
      });
      return parsePackageStatus(packageName, stdout);
    } catch {
      return { packageName, installed: false, version: null };
    }
  }

  async function inspectUnit(unit) {
    const args = ['show', unit, '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=UnitFileState', '--no-pager'];
    try {
      const { stdout } = await run(SYSTEMCTL, args, { timeout: 5000, maxBuffer: 128 * 1024 });
      return { unit, ...parseSystemdProperties(stdout), inspectionError: false };
    } catch (error) {
      const parsed = typeof error?.stdout === 'string' ? parseSystemdProperties(error.stdout) : null;
      return {
        unit,
        loadState: parsed?.loadState ?? 'unknown',
        activeState: parsed?.activeState ?? 'unknown',
        subState: parsed?.subState ?? 'unknown',
        unitFileState: parsed?.unitFileState ?? 'unknown',
        inspectionError: true,
      };
    }
  }

  async function inspectConfiguration(definition, installed) {
    if (!installed) return CONFIGURATION_STATES.NOT_CHECKED;
    if (definition.configurationChecks.length === 0) return CONFIGURATION_STATES.NOT_APPLICABLE;
    try {
      for (const check of definition.configurationChecks) {
        await run(check.file, check.args, {
          timeout: 30_000,
          maxBuffer: 128 * 1024,
          env: { ...process.env, LC_ALL: 'C' },
        });
      }
      return CONFIGURATION_STATES.VALID;
    } catch {
      return CONFIGURATION_STATES.INVALID;
    }
  }

  function healthFor({ installed, active, units, configuration }) {
    if (!installed) return { status: 'not_installed', configuration };
    if (units.some((entry) => entry.inspectionError)) return { status: 'unknown', configuration };
    if (configuration === CONFIGURATION_STATES.INVALID) return { status: 'configuration_invalid', configuration };
    if (units.length === 0) return { status: 'installed', configuration };
    if (units.length > 0 && !active) return { status: 'inactive', configuration };
    return { status: 'ready', configuration };
  }

  async function inspectOne(serviceId) {
    const definition = requireService(serviceId);
    const [packages, units] = await Promise.all([
      Promise.all(definition.packages.map(inspectPackage)),
      Promise.all(definition.units.map(inspectUnit)),
    ]);
    const installed = packages.every((entry) => entry.installed);
    const active = units.length > 0 && units.every((entry) => entry.activeState === 'active');
    const configuration = await inspectConfiguration(definition, installed);
    return {
      id: definition.id,
      label: definition.label,
      category: definition.category,
      installed,
      active,
      packages,
      units,
      health: healthFor({ installed, active, units, configuration }),
    };
  }

  async function inspect(serviceId = null) {
    if (serviceId !== null) return inspectOne(serviceId);
    return Promise.all(SERVICE_CATALOG.map((entry) => inspectOne(entry.id)));
  }

  async function withMutation(operation) {
    if (activeMutation) {
      throw new ManagedServiceError('managed_service_operation_in_progress', 'Another managed service operation is already running');
    }
    const pending = Promise.resolve().then(operation);
    activeMutation = pending;
    try {
      return await pending;
    } finally {
      if (activeMutation === pending) activeMutation = null;
    }
  }

  async function assertNoConflict(definition) {
    for (const conflictId of definition.conflicts) {
      const conflict = await inspectOne(conflictId);
      if (conflict.installed) {
        throw new ManagedServiceError('managed_service_conflict', `${definition.label} conflicts with installed ${conflict.label}`);
      }
    }
  }

  async function install(serviceId) {
    const definition = requireService(serviceId);
    return withMutation(async () => {
      const before = await inspectOne(serviceId);
      if (!before.installed) {
        await assertNoConflict(definition);
        try {
          await run(APT_GET, ['update'], {
            env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
          });
        } catch {
          throw new ManagedServiceError('managed_service_apt_update_failed', 'APT package indexes could not be refreshed');
        }
        try {
          await run(APT_GET, ['install', '--yes', '--no-install-recommends', ...definition.packages], {
            env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
          });
        } catch {
          throw new ManagedServiceError('managed_service_install_failed', `${definition.label} packages could not be installed`);
        }
      }

      if (definition.units.length > 0) {
        try {
          for (const unit of definition.units) await run(SYSTEMCTL, ['enable', '--now', unit]);
        } catch {
          throw new ManagedServiceError('managed_service_enable_failed', `${definition.label} was installed but could not be enabled and started`);
        }
      }

      const after = await inspectOne(serviceId);
      if (!after.installed) throw new ManagedServiceError('managed_service_install_incomplete', `${definition.label} package installation could not be confirmed`);
      if (definition.units.length > 0 && !after.active) throw new ManagedServiceError('managed_service_not_active', `${definition.label} is installed but not active`);
      return { ...after, changed: !before.installed };
    });
  }

  async function control(serviceId, action) {
    const definition = requireService(serviceId);
    const safeAction = requireAction(action);
    if (definition.units.length === 0) {
      throw new ManagedServiceError('managed_service_not_controllable', 'Managed application does not expose a systemd service control');
    }
    return withMutation(async () => {
      const before = await inspectOne(serviceId);
      if (!before.installed) throw new ManagedServiceError('managed_service_not_installed', `${definition.label} is not installed`);
      try {
        for (const unit of definition.units) await run(SYSTEMCTL, [safeAction, unit]);
      } catch {
        throw new ManagedServiceError('managed_service_action_failed', `${definition.label} ${safeAction} failed`);
      }
      const after = await inspectOne(serviceId);
      if ((safeAction === 'start' || safeAction === 'restart') && !after.active) {
        throw new ManagedServiceError('managed_service_not_active', `${definition.label} did not become active`);
      }
      if (safeAction === 'stop' && after.active) {
        throw new ManagedServiceError('managed_service_still_active', `${definition.label} remained active after stop`);
      }
      return { ...after, action: safeAction };
    });
  }

  return { inspect, install, control };
}

export const managedServiceManager = createManagedServiceManager();
export const managedServicePolicy = Object.freeze({
  dpkgQueryPath: DPKG_QUERY,
  aptGetPath: APT_GET,
  systemctlPath: SYSTEMCTL,
  services: SERVICE_CATALOG,
  actions: Object.freeze([...SERVICE_ACTIONS]),
});
export const managedServiceInternals = Object.freeze({ parsePackageStatus, requireService, requireAction, CONFIGURATION_STATES });