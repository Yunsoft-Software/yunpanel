import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveLocalMigrationBackupDirectory,
  verifyLocalMigrationBackup,
} from './local-migration-backup.js';
import {
  compareLocalMigrationUnixIdentities,
  LocalMigrationUnixIdentityError,
} from './local-migration-unix-identity.js';

const IDENTITY_REFERENCES = new Set(['/etc/passwd', '/etc/group']);
const RESTORE_TARGETS = new Set([
  '/etc/yunpanel',
  '/var/lib/yunpanel',
  '/etc/nginx',
  '/etc/letsencrypt',
  '/etc/systemd/system/yunpanel-api.service',
  '/etc/systemd/system/yunpanel-web.service',
  '/etc/systemd/system/yun-agent.service',
]);

export class LocalMigrationRestorePreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalMigrationRestorePreviewError';
    this.code = code;
  }
}

function currentType(metadata) {
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isFile()) return 'file';
  return 'other';
}

async function inspectCurrentPath(entry, lstatFn) {
  let metadata;
  try {
    metadata = await lstatFn(entry.path);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ present: false, type: null, uid: null, gid: null, mode: null });
    throw new LocalMigrationRestorePreviewError('migration_restore_target_unreadable', `Restore target could not be inspected: ${entry.path}`);
  }
  if (!metadata || typeof metadata.isSymbolicLink !== 'function') {
    throw new LocalMigrationRestorePreviewError('migration_restore_target_invalid', `Restore target metadata is invalid: ${entry.path}`);
  }
  if (metadata.isSymbolicLink()) {
    throw new LocalMigrationRestorePreviewError('migration_restore_target_symlink', `Restore target must not be a symbolic link: ${entry.path}`);
  }
  return Object.freeze({
    present: true,
    type: currentType(metadata),
    uid: Number.isInteger(metadata.uid) ? metadata.uid : null,
    gid: Number.isInteger(metadata.gid) ? metadata.gid : null,
    mode: Number.isInteger(metadata.mode) ? metadata.mode & 0o7777 : null,
  });
}

function restoreAction(entry, current) {
  if (IDENTITY_REFERENCES.has(entry.path)) return 'identity_reference';
  if (!RESTORE_TARGETS.has(entry.path)) {
    throw new LocalMigrationRestorePreviewError('migration_restore_manifest_scope_invalid', 'Verified backup contains an unsupported restore target');
  }
  if (!entry.present) return current.present ? 'preserve_current' : 'not_present';
  if (!current.present) return 'restore_missing';
  return current.type === entry.type ? 'restore_replace' : 'restore_type_mismatch';
}

function assertIdentityComparison(result, directory, sha256) {
  if (!result || result.destructive !== false || result.backupDirectory !== directory || result.sha256 !== sha256
    || !Number.isInteger(result.snapshotUsers) || !Number.isInteger(result.currentUsers)
    || !result.counts || typeof result.counts !== 'object' || !Array.isArray(result.identities)) {
    throw new LocalMigrationRestorePreviewError('migration_restore_identity_result_invalid', 'Migration restore Unix identity comparison result is invalid');
  }
  for (const key of ['match', 'drift', 'missingCurrent', 'addedCurrent']) {
    if (!Number.isInteger(result.counts[key]) || result.counts[key] < 0) {
      throw new LocalMigrationRestorePreviewError('migration_restore_identity_result_invalid', 'Migration restore Unix identity comparison counts are invalid');
    }
  }
  return result;
}

export async function previewLocalMigrationRestore({
  backupDirectory,
  verifyBackup = verifyLocalMigrationBackup,
  compareIdentities = compareLocalMigrationUnixIdentities,
  lstatFn = lstat,
} = {}) {
  if (typeof verifyBackup !== 'function' || typeof compareIdentities !== 'function' || typeof lstatFn !== 'function') {
    throw new LocalMigrationRestorePreviewError('migration_restore_preview_dependencies_invalid', 'Migration restore preview dependencies are invalid');
  }
  const directory = resolveLocalMigrationBackupDirectory(backupDirectory);
  let verification;
  try {
    verification = await verifyBackup({ backupDirectory: directory });
  } catch {
    throw new LocalMigrationRestorePreviewError('migration_restore_backup_invalid', 'Migration restore preview requires a valid verified backup');
  }
  if (!verification || verification.verified !== true || verification.backupDirectory !== directory
    || verification.archivePath !== path.join(directory, 'state.tar')
    || verification.manifestPath !== path.join(directory, 'manifest.json')
    || !Array.isArray(verification.entries)) {
    throw new LocalMigrationRestorePreviewError('migration_restore_backup_invalid', 'Migration restore backup acknowledgement is invalid');
  }

  const targets = [];
  for (const entry of verification.entries) {
    if (!entry || typeof entry.path !== 'string' || !['file', 'directory'].includes(entry.type) || typeof entry.present !== 'boolean') {
      throw new LocalMigrationRestorePreviewError('migration_restore_manifest_invalid', 'Migration restore manifest entry is invalid');
    }
    const current = await inspectCurrentPath(entry, lstatFn);
    targets.push(Object.freeze({
      path: entry.path,
      snapshotPresent: entry.present,
      snapshotType: entry.type,
      current,
      action: restoreAction(entry, current),
    }));
  }

  let identityComparison;
  try {
    identityComparison = await compareIdentities({ backupDirectory: directory, verifyBackup });
  } catch (error) {
    if (error instanceof LocalMigrationUnixIdentityError) throw error;
    throw new LocalMigrationRestorePreviewError('migration_restore_identity_unavailable', 'Migration restore Unix identity comparison could not be completed');
  }
  assertIdentityComparison(identityComparison, directory, verification.sha256);

  const counts = Object.freeze({
    restore: targets.filter((target) => target.action === 'restore_replace' || target.action === 'restore_missing' || target.action === 'restore_type_mismatch').length,
    identityReferences: targets.filter((target) => target.action === 'identity_reference').length,
    preserved: targets.filter((target) => target.action === 'preserve_current').length,
  });

  return Object.freeze({
    backupDirectory: directory,
    archivePath: verification.archivePath,
    manifestPath: verification.manifestPath,
    sha256: verification.sha256,
    targets: Object.freeze(targets),
    counts,
    identityComparison,
    destructive: false,
  });
}

export const localMigrationRestorePreviewInternals = Object.freeze({
  identityReferences: Object.freeze([...IDENTITY_REFERENCES]),
  restoreTargets: Object.freeze([...RESTORE_TARGETS]),
  currentType,
  restoreAction,
  assertIdentityComparison,
});
