import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSystemdProperties } from './systemd-inspector.js';

const execFileAsync = promisify(execFile);
const DPKG_QUERY = '/usr/bin/dpkg-query';
const SYSTEMCTL = '/usr/bin/systemctl';

function service(definition) {
  return Object.freeze({
    ...definition,
    packages: Object.freeze([...definition.packages]),
    units: Object.freeze([...definition.units]),
  });
}

const SERVICE_CATALOG = Object.freeze([
  service({ id: 'nginx', label: 'Nginx', category: 'web', packages: ['nginx'], units: ['nginx.service'] }),
  service({ id: 'mariadb', label: 'MariaDB', category: 'database', packages: ['mariadb-server'], units: ['mariadb.service'] }),
  service({ id: 'mysql', label: 'MySQL', category: 'database', packages: ['mysql-server'], units: ['mysql.service'] }),
  service({ id: 'docker', label: 'Docker', category: 'containers', packages: ['docker.io'], units: ['docker.service'] }),
  service({ id: 'cron', label: 'Cron', category: 'scheduler', packages: ['cron'], units: ['cron.service'] }),
  service({ id: 'postfix', label: 'Postfix', category: 'mail', packages: ['postfix'], units: ['postfix.service'] }),
  service({ id: 'dovecot', label: 'Dovecot', category: 'mail', packages: ['dovecot-imapd'], units: ['dovecot.service'] }),
  service({ id: 'rspamd', label: 'Rspamd', category: 'mail', packages: ['rspamd'], units: ['rspamd.service'] }),
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

export function createManagedServiceManager({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
    ...options,
  }),
} = {}) {
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
      const { stdout } = await run(SYSTEMCTL, args);
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

  async function inspectOne(serviceId) {
    const definition = requireService(serviceId);
    const [packages, units] = await Promise.all([
      Promise.all(definition.packages.map(inspectPackage)),
      Promise.all(definition.units.map(inspectUnit)),
    ]);
    return {
      id: definition.id,
      label: definition.label,
      category: definition.category,
      installed: packages.every((entry) => entry.installed),
      active: units.length > 0 && units.every((entry) => entry.activeState === 'active'),
      packages,
      units,
    };
  }

  async function inspect(serviceId = null) {
    if (serviceId !== null) return inspectOne(serviceId);
    return Promise.all(SERVICE_CATALOG.map((entry) => inspectOne(entry.id)));
  }

  return { inspect };
}

export const managedServiceManager = createManagedServiceManager();
export const managedServicePolicy = Object.freeze({
  dpkgQueryPath: DPKG_QUERY,
  systemctlPath: SYSTEMCTL,
  services: SERVICE_CATALOG,
});
export const managedServiceInternals = Object.freeze({ parsePackageStatus, requireService });
