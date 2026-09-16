import { chmod, chown, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

async function managedConfigSnapshot({ lstatFn, readFileFn }) {
  let info;
  try { info = await lstatFn(powerDnsTemplatePolicy.configPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ exists: false });
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_config_snapshot_failed',
      'PowerDNS managed configuration could not be snapshotted before apply',
    );
  }
  if (!info?.isFile?.() || info?.isSymbolicLink?.()) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_config_path_drift',
      'Managed PowerDNS configuration path must be a regular file when it already exists',
    );
  }
  try {
    const content = await readFileFn(powerDnsTemplatePolicy.configPath);
    return Object.freeze({
      exists: true,
      content,
      uid: info.uid,
      gid: info.gid,
      mode: info.mode & 0o777,
    });
  } catch {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_config_snapshot_failed',
      'PowerDNS managed configuration could not be snapshotted before apply',
    );
  }
}

async function restoreManagedConfig(snapshot, {
  chmodFn,
  chownFn,
  renameFn,
  rmFn,
  writeFileFn,
}) {
  const target = powerDnsTemplatePolicy.configPath;
  if (!snapshot.exists) {
    await rmFn(target, { force: true });
    return;
  }
  if (!Number.isInteger(snapshot.uid) || !Number.isInteger(snapshot.gid)
    || !Number.isInteger(snapshot.mode)) {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_config_snapshot_invalid',
      'PowerDNS managed configuration snapshot metadata is invalid',
    );
  }
  const temporary = `${target}.${process.pid}.rollback.tmp`;
  try {
    await writeFileFn(temporary, snapshot.content, { mode: snapshot.mode });
    await chownFn(temporary, snapshot.uid, snapshot.gid);
    await chmodFn(temporary, snapshot.mode);
    await renameFn(temporary, target);
  } finally {
    try { await rmFn(temporary, { force: true }); } catch { /* ignored */ }
  }
}

export function createPowerDnsAuthoritativeSecureManager({
  manager = createPowerDnsAuthoritativeManager(),
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (!manager || typeof manager.inspect !== 'function' || typeof manager.apply !== 'function'
    || typeof chmodFn !== 'function' || typeof chownFn !== 'function' || typeof lstatFn !== 'function'
    || typeof readFileFn !== 'function' || typeof renameFn !== 'function' || typeof rmFn !== 'function'
    || typeof writeFileFn !== 'function') {
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
    const configSnapshot = await managedConfigSnapshot({ lstatFn, readFileFn });
    let result;
    try { result = await manager.apply(intent); }
    catch (error) {
      if (error?.code === 'powerdns_config_invalid') {
        try {
          await restoreManagedConfig(configSnapshot, {
            chmodFn,
            chownFn,
            renameFn,
            rmFn,
            writeFileFn,
          });
        } catch (rollbackError) {
          if (rollbackError instanceof PowerDnsAuthoritativeManagerError
            && rollbackError.code === 'powerdns_config_snapshot_invalid') throw rollbackError;
          throw new PowerDnsAuthoritativeManagerError(
            'powerdns_config_rollback_failed',
            'PowerDNS rejected the candidate configuration and the previous managed configuration could not be restored',
          );
        }
      }
      throw error;
    }
    await assertManagedPaths();
    return result;
  }

  return Object.freeze({ inspect, apply });
}

export const powerDnsAuthoritativeSecureManagerInternals = Object.freeze({
  regularFileState,
  managedConfigSnapshot,
  restoreManagedConfig,
});
