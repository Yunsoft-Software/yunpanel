import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveLocalMigrationBackupDirectory,
  verifyLocalMigrationBackup,
} from './local-migration-backup.js';
import {
  inspectVerifiedLocalMigrationArchive,
  LocalMigrationArchiveInspectionError,
} from './local-migration-archive-inspection.js';
import {
  compareVerifiedLocalMigrationUnixIdentities,
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
const ARCHIVE_MEMBER_TYPES = new Set(['-', 'd', 'l', 'h']);
const ARCHIVE_METADATA_MARKERS = new Set([null, '+', '*', '.']);

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

function validArchiveMember(member) {
  if (!member || typeof member !== 'object' || Array.isArray(member)
    || typeof member.name !== 'string' || member.name.length === 0
    || !ARCHIVE_MEMBER_TYPES.has(member.type)
    || typeof member.root !== 'string' || !path.isAbsolute(member.root)
    || !Number.isInteger(member.uid) || member.uid < 0 || member.uid > 0xffff_ffff
    || !Number.isInteger(member.gid) || member.gid < 0 || member.gid > 0xffff_ffff
    || !Number.isInteger(member.mode) || member.mode < 0 || member.mode > 0o7777
    || !ARCHIVE_METADATA_MARKERS.has(member.metadataMarker)) return false;
  const isLink = member.type === 'l' || member.type === 'h';
  return isLink ? typeof member.resolvedLinkTarget === 'string' && member.resolvedLinkTarget.length > 0 : member.resolvedLinkTarget === null;
}

function assertArchiveInspection(result, directory, sha256) {
  if (!result || result.destructive !== false || result.linksSafe !== true
    || result.ownershipMetadata !== true || result.extendedMetadataValidated !== false
    || result.backupDirectory !== directory || result.sha256 !== sha256
    || !result.counts || typeof result.counts !== 'object' || !Array.isArray(result.members)) {
    throw new LocalMigrationRestorePreviewError('migration_restore_archive_result_invalid', 'Migration restore archive inspection result is invalid');
  }
  for (const key of ['total', 'files', 'directories', 'symlinks', 'hardlinks', 'extendedMetadata']) {
    if (!Number.isInteger(result.counts[key]) || result.counts[key] < 0) {
      throw new LocalMigrationRestorePreviewError('migration_restore_archive_result_invalid', 'Migration restore archive inspection counts are invalid');
    }
  }
  if (result.counts.files + result.counts.directories + result.counts.symlinks + result.counts.hardlinks !== result.counts.total
    || result.members.length !== result.counts.total
    || result.members.some((member) => !validArchiveMember(member))
    || result.members.filter((member) => member.metadataMarker !== null).length !== result.counts.extendedMetadata) {
    throw new LocalMigrationRestorePreviewError('migration_restore_archive_result_invalid', 'Migration restore archive inspection metadata does not match the member total');
  }
  return result;
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
  if (result.counts.match + result.counts.drift + result.counts.missingCurrent + result.counts.addedCurrent !== result.identities.length) {
    throw new LocalMigrationRestorePreviewError('migration_restore_identity_result_invalid', 'Migration restore Unix identity comparison counts do not match the result set');
  }
  return result;
}

export async function previewLocalMigrationRestore({
  backupDirectory,
  verifyBackup = verifyLocalMigrationBackup,
  inspectArchive = inspectVerifiedLocalMigrationArchive,
  compareIdentities = compareVerifiedLocalMigrationUnixIdentities,
  lstatFn = lstat,
} = {}) {
  if (typeof verifyBackup !== 'function' || typeof inspectArchive !== 'function'
    || typeof compareIdentities !== 'function' || typeof lstatFn !== 'function') {
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
    || typeof verification.sha256 !== 'string'
    || !Array.isArray(verification.entries)) {
    throw new LocalMigrationRestorePreviewError('migration_restore_backup_invalid', 'Migration restore backup acknowledgement is invalid');
  }

  let archiveInspection;
  try {
    archiveInspection = await inspectArchive({ backupDirectory: directory, verification });
  } catch (error) {
    if (error instanceof LocalMigrationArchiveInspectionError) throw error;
    throw new LocalMigrationRestorePreviewError('migration_restore_archive_unavailable', 'Migration restore archive inspection could not be completed');
  }
  assertArchiveInspection(archiveInspection, directory, verification.sha256);

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
    identityComparison = await compareIdentities({ backupDirectory: directory, verification });
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
    archiveInspection,
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
  validArchiveMember,
  assertArchiveInspection,
  assertIdentityComparison,
});
