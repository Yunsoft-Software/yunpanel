import { lstat } from 'node:fs/promises';
import { powerDnsTemplatePolicy } from '@yunpanel/config-templates/powerdns';
import {
  createPowerDnsAuthoritativeManager,
  PowerDnsAuthoritativeManagerError,
} from './powerdns-authoritative-manager.js';

async function regularFileState(target, lstatFn) {
  try {
    const info = await lstatFn(target);
    return Object.freeze({
      exists: true,
      regular: Boolean(info?.isFile?.()) && !Boolean(info?.isSymbolicLink?.()),
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ exists: false, regular: false });
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_managed_path_inspection_failed',
      'PowerDNS managed filesystem state could not be inspected',
    );
  }
}

export function createPowerDnsAuthoritativeSecureManager({
  manager = createPowerDnsAuthoritativeManager(),
  lstatFn = lstat,
} = {}) {
  if (!manager || typeof manager.inspect !== 'function' || typeof manager.apply !== 'function'
    || typeof lstatFn !== 'function') {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_secure_manager_dependencies_invalid',
      'PowerDNS secure manager dependencies are unavailable',
    );
  }

  async function assertManagedPaths() {
    for (const [target, code, message] of [
      [
        powerDnsTemplatePolicy.configPath,
        'powerdns_config_path_drift',
        'Managed PowerDNS configuration path must be a regular file when it already exists',
      ],
      [
        powerDnsTemplatePolicy.databasePath,
        'powerdns_database_path_drift',
        'Managed PowerDNS SQLite database path must be a regular file when it already exists',
      ],
    ]) {
      const state = await regularFileState(target, lstatFn);
      if (state.exists && !state.regular) throw new PowerDnsAuthoritativeManagerError(code, message);
    }
  }

  async function inspect(intent) {
    await assertManagedPaths();
    return manager.inspect(intent);
  }

  async function apply(intent) {
    await assertManagedPaths();
    const result = await manager.apply(intent);
    await assertManagedPaths();
    return result;
  }

  return Object.freeze({ inspect, apply });
}

export const powerDnsAuthoritativeSecureManagerInternals = Object.freeze({ regularFileState });
