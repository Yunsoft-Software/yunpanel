import path from 'node:path';
import { localMigrationBackupInternals, resolveLocalMigrationBackupDirectory } from './local-migration-backup.js';
import {
  localMigrationRestorePreviewInternals,
  previewLocalMigrationRestore,
} from './local-migration-restore-preview.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TARGET_ACTIONS = new Set([
  'restore_replace',
  'restore_missing',
  'restore_type_mismatch',
  'identity_reference',
  'preserve_current',
  'not_present',
]);
const RESTORE_ACTIONS = new Set(['restore_replace', 'restore_missing', 'restore_type_mismatch']);

export class LocalMigrationRestoreMetadataPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalMigrationRestoreMetadataPlanError';
    this.code = code;
  }
}

function assertTargets(targets) {
  if (!Array.isArray(targets)) {
    throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_targets_invalid', 'Migration restore metadata plan requires complete restore target metadata');
  }
  const expected = new Set(localMigrationBackupInternals.requiredEntries.map((entry) => entry.path));
  const seen = new Set();
  const normalized = targets.map((target) => {
    if (!target || typeof target.path !== 'string' || !expected.has(target.path) || seen.has(target.path)
      || !TARGET_ACTIONS.has(target.action) || typeof target.snapshotPresent !== 'boolean'
      || !['file', 'directory'].includes(target.snapshotType)
      || !target.current || typeof target.current.present !== 'boolean') {
      throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_targets_invalid', 'Migration restore metadata target is invalid');
    }
    seen.add(target.path);
    return Object.freeze({
      path: target.path,
      action: target.action,
      snapshotPresent: target.snapshotPresent,
      snapshotType: target.snapshotType,
    });
  });
  if (seen.size !== expected.size || [...expected].some((entry) => !seen.has(entry))) {
    throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_targets_invalid', 'Migration restore metadata plan is missing a fixed restore target');
  }
  return Object.freeze(normalized);
}

function rootPlan(root, target, members) {
  const rootMember = members.find((member) => member.name === localMigrationBackupInternals.relativeArchivePath(root));
  if (target.snapshotPresent && !rootMember) {
    throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_root_missing', 'Migration restore metadata plan is missing source-root ownership metadata');
  }
  if (!target.snapshotPresent && members.length !== 0) {
    throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_root_unexpected', 'Migration restore metadata plan contains members for an absent source root');
  }
  const privileged = members.filter((member) => (member.mode & 0o7000) !== 0).length;
  const extended = members.filter((member) => member.metadataMarker !== null).length;
  const ownershipPairs = new Set(members.map((member) => `${member.uid}:${member.gid}`));
  return Object.freeze({
    path: root,
    action: target.action,
    snapshotPresent: target.snapshotPresent,
    snapshotType: target.snapshotType,
    members: members.length,
    files: members.filter((member) => member.type === '-').length,
    directories: members.filter((member) => member.type === 'd').length,
    symlinks: members.filter((member) => member.type === 'l').length,
    hardlinks: members.filter((member) => member.type === 'h').length,
    ownershipPairs: ownershipPairs.size,
    privilegedModeMembers: privileged,
    extendedMetadataMembers: extended,
    rootMetadata: rootMember ? Object.freeze({
      uid: rootMember.uid,
      gid: rootMember.gid,
      mode: rootMember.mode,
      metadataMarker: rootMember.metadataMarker,
    }) : null,
  });
}

function buildBlocks({ identity, targets, members }) {
  const blocks = [];
  if (identity.counts.drift + identity.counts.missingCurrent + identity.counts.addedCurrent > 0) {
    blocks.push('unix_identity_drift');
  }
  if (targets.some((target) => target.action === 'restore_type_mismatch')) {
    blocks.push('restore_target_type_mismatch');
  }
  if (members.some((member) => (member.mode & 0o7000) !== 0)) {
    blocks.push('privileged_mode_requires_policy');
  }
  if (members.some((member) => member.metadataMarker !== null)) {
    blocks.push('extended_metadata_unvalidated');
  }
  return Object.freeze(blocks);
}

function buildPlan(directory, preview) {
  if (!preview || preview.destructive !== false || preview.backupDirectory !== directory
    || preview.archivePath !== path.join(directory, 'state.tar')
    || preview.manifestPath !== path.join(directory, 'manifest.json')
    || typeof preview.sha256 !== 'string' || !HASH_PATTERN.test(preview.sha256)) {
    throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_preview_invalid', 'Migration restore metadata preview acknowledgement is invalid');
  }

  let archive;
  let identity;
  try {
    archive = localMigrationRestorePreviewInternals.assertArchiveInspection(preview.archiveInspection, directory, preview.sha256);
    identity = localMigrationRestorePreviewInternals.assertIdentityComparison(preview.identityComparison, directory, preview.sha256);
  } catch {
    throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_preview_invalid', 'Migration restore metadata preview evidence is incomplete');
  }
  const targets = assertTargets(preview.targets);
  const targetByPath = new Map(targets.map((target) => [target.path, target]));
  const groupedMembers = new Map(localMigrationBackupInternals.requiredEntries.map((entry) => [entry.path, []]));
  for (const member of archive.members) {
    const group = groupedMembers.get(member.root);
    if (!group) {
      throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_member_scope_invalid', 'Migration restore metadata contains a member outside fixed restore roots');
    }
    group.push(member);
  }

  const targetPlans = Object.freeze(localMigrationBackupInternals.requiredEntries.map((entry) => (
    rootPlan(entry.path, targetByPath.get(entry.path), groupedMembers.get(entry.path))
  )));
  const blocks = buildBlocks({ identity, targets, members: archive.members });
  const counts = Object.freeze({
    members: archive.members.length,
    restoreTargets: targets.filter((target) => RESTORE_ACTIONS.has(target.action)).length,
    identityReferences: targets.filter((target) => target.action === 'identity_reference').length,
    preservedTargets: targets.filter((target) => target.action === 'preserve_current' || target.action === 'not_present').length,
    privilegedModeMembers: targetPlans.reduce((sum, target) => sum + target.privilegedModeMembers, 0),
    extendedMetadataMembers: targetPlans.reduce((sum, target) => sum + target.extendedMetadataMembers, 0),
    identityDrift: identity.counts.drift,
    identityMissingCurrent: identity.counts.missingCurrent,
    identityAddedCurrent: identity.counts.addedCurrent,
  });

  return Object.freeze({
    backupDirectory: directory,
    sha256: preview.sha256,
    counts,
    targets: targetPlans,
    blocks,
    ownershipMetadata: true,
    extendedMetadataValidated: false,
    liveMutation: false,
    destructive: false,
    liveApplyEnabled: false,
  });
}

export function planVerifiedLocalMigrationRestoreMetadata({ backupDirectory, preview } = {}) {
  const directory = resolveLocalMigrationBackupDirectory(backupDirectory);
  return buildPlan(directory, preview);
}

export async function planLocalMigrationRestoreMetadata({
  backupDirectory,
  previewRestore = previewLocalMigrationRestore,
} = {}) {
  if (typeof previewRestore !== 'function') {
    throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_dependencies_invalid', 'Migration restore metadata plan dependencies are invalid');
  }
  const directory = resolveLocalMigrationBackupDirectory(backupDirectory);
  let preview;
  try {
    preview = await previewRestore({ backupDirectory: directory });
  } catch (error) {
    if (error instanceof LocalMigrationRestoreMetadataPlanError) throw error;
    throw new LocalMigrationRestoreMetadataPlanError('migration_restore_metadata_preview_failed', 'Migration restore metadata plan requires a successful restore preview');
  }
  return buildPlan(directory, preview);
}

export const localMigrationRestoreMetadataPlanInternals = Object.freeze({
  targetActions: Object.freeze([...TARGET_ACTIONS]),
  restoreActions: Object.freeze([...RESTORE_ACTIONS]),
  assertTargets,
  rootPlan,
  buildBlocks,
  buildPlan,
});
