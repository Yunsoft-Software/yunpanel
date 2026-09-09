import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SYSTEMCTL_PATHS = Object.freeze(['/usr/bin/systemctl', '/bin/systemctl']);
const MANAGED_UNITS = Object.freeze([
  'nginx.service', 'apache2.service', 'docker.service', 'mysql.service', 'mariadb.service',
  'postfix.service', 'dovecot.service', 'rspamd.service',
]);

async function findSystemctl() {
  for (const candidate of SYSTEMCTL_PATHS) {
    try { await access(candidate); return candidate; } catch { /* fixed allowlist */ }
  }
  return null;
}

export function parseSystemdProperties(output) {
  const properties = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return {
    loadState: properties.LoadState ?? 'unknown',
    activeState: properties.ActiveState ?? 'unknown',
    subState: properties.SubState ?? 'unknown',
    unitFileState: properties.UnitFileState ?? 'unknown',
  };
}

async function inspectUnit(systemctlPath, unit) {
  const args = ['show', unit, '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=UnitFileState', '--no-pager'];
  try {
    const { stdout } = await execFileAsync(systemctlPath, args, { encoding: 'utf8', timeout: 2500, maxBuffer: 64 * 1024, windowsHide: true });
    return { unit, ...parseSystemdProperties(stdout) };
  } catch (error) {
    const parsed = typeof error.stdout === 'string' ? parseSystemdProperties(error.stdout) : null;
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

export async function inspectAllowlistedServices() {
  const systemctlPath = await findSystemctl();
  if (!systemctlPath) return { systemdAvailable: false, services: [] };
  const services = await Promise.all(MANAGED_UNITS.map((unit) => inspectUnit(systemctlPath, unit)));
  return { systemdAvailable: true, services };
}

export const systemdInspectionPolicy = Object.freeze({ systemctlPaths: SYSTEMCTL_PATHS, units: MANAGED_UNITS });
