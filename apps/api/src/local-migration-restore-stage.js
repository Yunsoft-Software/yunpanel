import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  localMigrationBackupInternals,
  resolveLocalMigrationBackupDirectory,
} from './local-migration-backup.js';
import { localMigrationArchiveInspectionInternals } from './local-migration-archive-inspection.js';
import {
  LocalMigrationRestoreMetadataPlanError,
  planVerifiedLocalMigrationRestoreMetadata,
} from './local-migration-restore-metadata-plan.js';
import { previewLocalMigrationRestore } from './local-migration-restore-preview.js';

const execFileAsync = promisify(execFile);
const DEFAULT_STAGE_ROOT = '/var/backups/yunpanel/.restore-staging';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_STAGE_MEMBERS = localMigrationArchiveInspectionInternals.maxMembers;
const METADATA_MARKERS = new Set([null, '+', '*', '.']);
const METADATA_PLAN_BLOCKS = new Set([
  'unix_identity_drift',
  'restore_target_type_mismatch',
  'privileged_mode_requires_policy',
  'extended_metadata_unvalidated',
]);

export class LocalMigrationRestoreStageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalMigrationRestoreStageError';
    this.code = code;
  }
}

function normalizeStageRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000\r\n]/.test(value)) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_root_invalid', 'Migration restore stage root must be an absolute path');
  }
  const resolved = path.resolve(value);
  if (resolved === '/' || resolved === localMigrationBackupInternals.defaultRoot) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_root_invalid', 'Migration restore stage root is too broad');
  }
  return resolved;
}

function insideArchiveRoot(target, rootPath) {
  const root = localMigrationBackupInternals.relativeArchivePath(rootPath);
  return target === root || target.startsWith(`${root}/`);
}

function validMemberMetadata(member) {
  return Number.isInteger(member.uid) && member.uid >= 0 && member.uid <= 0xffff_ffff
    && Number.isInteger(member.gid) && member.gid >= 0 && member.gid <= 0xffff_ffff
    && Number.isInteger(member.mode) && member.mode >= 0 && member.mode <= 0o7777
    && METADATA_MARKERS.has(member.metadataMarker);
}

function validatePreview(preview, directory) {
  if (!preview || preview.destructive !== false || preview.backupDirectory !== directory
    || preview.archivePath !== path.join(directory, 'state.tar')
    || preview.manifestPath !== path.join(directory, 'manifest.json')
    || typeof preview.sha256 !== 'string' || !HASH_PATTERN.test(preview.sha256)
    || !preview.archiveInspection || preview.archiveInspection.linksSafe !== true
    || preview.archiveInspection.ownershipMetadata !== true
    || preview.archiveInspection.extendedMetadataValidated !== false
    || preview.archiveInspection.destructive !== false
    || preview.archiveInspection.backupDirectory !== directory
    || preview.archiveInspection.sha256 !== preview.sha256
    || !Array.isArray(preview.archiveInspection.members)
    || !preview.archiveInspection.counts
    || preview.archiveInspection.members.length !== preview.archiveInspection.counts.total) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_preview_invalid', 'Migration restore staging requires a complete safe restore preview');
  }
  const seen = new Set();
  const allowedRoots = new Set(localMigrationBackupInternals.requiredEntries.map((entry) => entry.path));
  const members = preview.archiveInspection.members.map((member) => {
    if (!member || typeof member.name !== 'string' || !['-', 'd', 'l', 'h'].includes(member.type)
      || typeof member.root !== 'string' || !allowedRoots.has(member.root)
      || seen.has(member.name) || !validMemberMetadata(member)) {
      throw new LocalMigrationRestoreStageError('migration_restore_stage_preview_invalid', 'Migration restore preview contains invalid archive member metadata');
    }
    const name = localMigrationArchiveInspectionInternals.normalizeMemberName(member.name);
    seen.add(name);
    let resolvedLinkTarget = null;
    if (member.type === 'l' || member.type === 'h') {
      if (typeof member.resolvedLinkTarget !== 'string') {
        throw new LocalMigrationRestoreStageError('migration_restore_stage_preview_invalid', 'Migration restore preview is missing safe link metadata');
      }
      resolvedLinkTarget = localMigrationArchiveInspectionInternals.normalizeMemberName(member.resolvedLinkTarget);
      if (!insideArchiveRoot(resolvedLinkTarget, member.root)) {
        throw new LocalMigrationRestoreStageError('migration_restore_stage_preview_invalid', 'Migration restore preview contains a link outside its verified source root');
      }
    } else if (member.resolvedLinkTarget !== null) {
      throw new LocalMigrationRestoreStageError('migration_restore_stage_preview_invalid', 'Migration restore preview contains unexpected link metadata');
    }
    return Object.freeze({
      name,
      type: member.type,
      root: member.root,
      resolvedLinkTarget,
      uid: member.uid,
      gid: member.gid,
      mode: member.mode,
      metadataMarker: member.metadataMarker,
    });
  });
  const extendedMetadata = members.filter((member) => member.metadataMarker !== null).length;
  if (!Number.isInteger(preview.archiveInspection.counts.extendedMetadata)
    || preview.archiveInspection.counts.extendedMetadata !== extendedMetadata) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_preview_invalid', 'Migration restore preview extended metadata count is invalid');
  }
  return Object.freeze(members);
}

function summarizeMetadataPlan(plan, directory, sha256, members) {
  const memberCount = members.length;
  if (!plan || plan.destructive !== false || plan.liveMutation !== false || plan.liveApplyEnabled !== false
    || plan.ownershipMetadata !== true || plan.extendedMetadataValidated !== false
    || plan.backupDirectory !== directory || plan.sha256 !== sha256
    || !plan.counts || !Array.isArray(plan.blocks) || !Array.isArray(plan.targets)
    || plan.counts.members !== memberCount || plan.targets.length !== localMigrationBackupInternals.requiredEntries.length) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_metadata_plan_invalid', 'Migration restore staging requires a complete read-only metadata plan');
  }
  const countKeys = [
    'members',
    'restoreTargets',
    'identityReferences',
    'preservedTargets',
    'privilegedModeMembers',
    'extendedMetadataMembers',
    'identityDrift',
    'identityMissingCurrent',
    'identityAddedCurrent',
  ];
  const uniqueBlocks = new Set(plan.blocks);
  const privilegedModeMembers = members.filter((member) => (member.mode & 0o7000) !== 0).length;
  const extendedMetadataMembers = members.filter((member) => member.metadataMarker !== null).length;
  if (!countKeys.every((key) => Number.isInteger(plan.counts[key]) && plan.counts[key] >= 0)
    || plan.counts.privilegedModeMembers !== privilegedModeMembers
    || plan.counts.extendedMetadataMembers !== extendedMetadataMembers
    || uniqueBlocks.size !== plan.blocks.length
    || plan.blocks.some((block) => typeof block !== 'string' || !METADATA_PLAN_BLOCKS.has(block))
    || uniqueBlocks.has('privileged_mode_requires_policy') !== (privilegedModeMembers > 0)
    || uniqueBlocks.has('extended_metadata_unvalidated') !== (extendedMetadataMembers > 0)) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_metadata_plan_invalid', 'Migration restore staging metadata plan summary is invalid');
  }
  return Object.freeze({
    counts: Object.freeze({ ...plan.counts }),
    blocks: Object.freeze([...plan.blocks]),
    ownershipMetadata: true,
    extendedMetadataValidated: false,
    liveApplyEnabled: false,
  });
}

async function ensurePrivateDirectory(target, { mkdirFn, lstatFn, chmodFn, recursive }) {
  try {
    await mkdirFn(target, { recursive, mode: 0o700 });
  } catch {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_directory_failed', 'Migration restore staging directory could not be prepared');
  }
  let metadata;
  try {
    metadata = await lstatFn(target);
  } catch {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_directory_failed', 'Migration restore staging directory could not be inspected');
  }
  if (!metadata || typeof metadata.isDirectory !== 'function' || typeof metadata.isSymbolicLink !== 'function'
    || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_directory_unsafe', 'Migration restore staging directory is not a real directory');
  }
  try {
    await chmodFn(target, 0o700);
  } catch {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_directory_failed', 'Migration restore staging directory permissions could not be secured');
  }
}

function actualType(metadata) {
  if (metadata.isSymbolicLink()) return 'l';
  if (metadata.isDirectory()) return 'd';
  if (metadata.isFile()) return '-';
  return 'other';
}

async function collectStageEntries(stageDirectory, { readdirFn, lstatFn, readlinkFn }) {
  const entries = new Map();
  async function visit(relativeDirectory) {
    const absoluteDirectory = relativeDirectory ? path.join(stageDirectory, relativeDirectory) : stageDirectory;
    let children;
    try {
      children = await readdirFn(absoluteDirectory, { withFileTypes: true });
    } catch {
      throw new LocalMigrationRestoreStageError('migration_restore_stage_unreadable', 'Migration restore staged tree could not be read');
    }
    for (const child of children) {
      if (entries.size >= MAX_STAGE_MEMBERS) {
        throw new LocalMigrationRestoreStageError('migration_restore_stage_too_many_members', 'Migration restore staged tree contains too many members');
      }
      const relativeNative = relativeDirectory ? path.join(relativeDirectory, child.name) : child.name;
      const name = localMigrationArchiveInspectionInternals.normalizeMemberName(relativeNative.split(path.sep).join('/'));
      const absolute = path.join(stageDirectory, relativeNative);
      let metadata;
      try {
        metadata = await lstatFn(absolute);
      } catch {
        throw new LocalMigrationRestoreStageError('migration_restore_stage_unreadable', 'Migration restore staged member could not be inspected');
      }
      const type = actualType(metadata);
      if (type === 'other' || entries.has(name)) {
        throw new LocalMigrationRestoreStageError('migration_restore_stage_member_invalid', 'Migration restore staged tree contains an invalid member');
      }
      let linkTarget = null;
      if (type === 'l') {
        try {
          linkTarget = await readlinkFn(absolute);
        } catch {
          throw new LocalMigrationRestoreStageError('migration_restore_stage_unreadable', 'Migration restore staged link could not be inspected');
        }
      }
      entries.set(name, Object.freeze({ name, type, metadata, linkTarget }));
      if (type === 'd') await visit(relativeNative);
    }
  }
  await visit('');
  return entries;
}

function expectedActualType(member) {
  return member.type === 'h' ? '-' : member.type;
}

function memberRootArchivePath(member) {
  return localMigrationBackupInternals.relativeArchivePath(member.root);
}

function validateStagedSymlink(member, actual) {
  const resolved = localMigrationArchiveInspectionInternals.normalizeLinkTarget(member.name, actual.linkTarget);
  if (resolved !== member.resolvedLinkTarget) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_link_mismatch', 'Migration restore staged link does not match the verified archive');
  }
  const root = memberRootArchivePath(member);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_link_escape', 'Migration restore staged link escapes its verified source root');
  }
}

function validateHardlink(member, actualEntries) {
  const actual = actualEntries.get(member.name);
  const target = actualEntries.get(member.resolvedLinkTarget);
  if (!actual || !target || actual.type !== '-' || target.type !== '-') {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_hardlink_invalid', 'Migration restore staged hard link target is invalid');
  }
  const comparable = Number.isInteger(actual.metadata?.ino) && Number.isInteger(target.metadata?.ino)
    && Number.isInteger(actual.metadata?.dev) && Number.isInteger(target.metadata?.dev);
  if (comparable && (actual.metadata.ino !== target.metadata.ino || actual.metadata.dev !== target.metadata.dev)) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_hardlink_mismatch', 'Migration restore staged hard link does not match the verified archive');
  }
}

async function validateStagedTree(stageDirectory, members, dependencies) {
  const actualEntries = await collectStageEntries(stageDirectory, dependencies);
  const expectedNames = new Set(members.map((member) => member.name));
  const implicitDirectories = new Set();
  for (const member of members) {
    let parent = path.posix.dirname(member.name);
    while (parent !== '.') {
      if (!expectedNames.has(parent)) implicitDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const expectedEntryCount = expectedNames.size + implicitDirectories.size;
  if (actualEntries.size !== expectedEntryCount) {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_member_mismatch', 'Migration restore staged tree does not match the verified archive member count');
  }
  for (const directory of implicitDirectories) {
    if (actualEntries.get(directory)?.type !== 'd') {
      throw new LocalMigrationRestoreStageError('migration_restore_stage_member_mismatch', 'Migration restore staged tree is missing a required parent directory');
    }
  }
  for (const member of members) {
    const actual = actualEntries.get(member.name);
    if (!actual || actual.type !== expectedActualType(member)) {
      throw new LocalMigrationRestoreStageError('migration_restore_stage_member_mismatch', 'Migration restore staged tree does not match the verified archive');
    }
    if (member.type === 'l') validateStagedSymlink(member, actual);
  }
  for (const member of members.filter((entry) => entry.type === 'h')) validateHardlink(member, actualEntries);
  return Object.freeze({ members: members.length });
}

function defaultRunTar(args) {
  return execFileAsync(localMigrationBackupInternals.tarPath, args, {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export async function stageLocalMigrationRestore({
  backupDirectory,
  stageRoot = DEFAULT_STAGE_ROOT,
  previewRestore = previewLocalMigrationRestore,
  planMetadata = planVerifiedLocalMigrationRestoreMetadata,
  mkdirFn = mkdir,
  mkdtempFn = mkdtemp,
  lstatFn = lstat,
  chmodFn = chmod,
  readdirFn = readdir,
  readlinkFn = readlink,
  rmFn = rm,
  runTar = defaultRunTar,
} = {}) {
  if (typeof previewRestore !== 'function' || typeof planMetadata !== 'function'
    || typeof mkdirFn !== 'function' || typeof mkdtempFn !== 'function'
    || typeof lstatFn !== 'function' || typeof chmodFn !== 'function' || typeof readdirFn !== 'function'
    || typeof readlinkFn !== 'function' || typeof rmFn !== 'function' || typeof runTar !== 'function') {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_dependencies_invalid', 'Migration restore staging dependencies are invalid');
  }
  const directory = resolveLocalMigrationBackupDirectory(backupDirectory);
  const safeStageRoot = normalizeStageRoot(stageRoot);
  let preview;
  try {
    preview = await previewRestore({ backupDirectory: directory });
  } catch (error) {
    if (error instanceof LocalMigrationRestoreStageError) throw error;
    throw new LocalMigrationRestoreStageError('migration_restore_stage_preview_failed', 'Migration restore staging requires a successful restore preview');
  }
  const members = validatePreview(preview, directory);

  let metadataPlan;
  try {
    metadataPlan = await planMetadata({ backupDirectory: directory, preview });
  } catch (error) {
    if (error instanceof LocalMigrationRestoreMetadataPlanError) {
      throw new LocalMigrationRestoreStageError('migration_restore_stage_metadata_plan_invalid', 'Migration restore staging requires a complete read-only metadata plan');
    }
    throw new LocalMigrationRestoreStageError('migration_restore_stage_metadata_plan_failed', 'Migration restore staging metadata plan could not be produced safely');
  }
  const metadataSummary = summarizeMetadataPlan(metadataPlan, directory, preview.sha256, members);

  await ensurePrivateDirectory(safeStageRoot, { mkdirFn, lstatFn, chmodFn, recursive: true });
  let stageDirectory;
  try {
    stageDirectory = await mkdtempFn(path.join(safeStageRoot, `${path.basename(directory)}-`));
  } catch {
    throw new LocalMigrationRestoreStageError('migration_restore_stage_directory_failed', 'Migration restore staging directory could not be created');
  }
  const resolvedStage = path.resolve(stageDirectory);
  if (path.dirname(resolvedStage) !== safeStageRoot) {
    await rmFn(resolvedStage, { recursive: true, force: true }).catch(() => {});
    throw new LocalMigrationRestoreStageError('migration_restore_stage_directory_unsafe', 'Migration restore staging directory escaped the private staging root');
  }

  try {
    await ensurePrivateDirectory(resolvedStage, { mkdirFn, lstatFn, chmodFn, recursive: true });
    await runTar([
      '--extract',
      '--file', preview.archivePath,
      '--directory', resolvedStage,
      '--no-same-owner',
      '--no-same-permissions',
      '--delay-directory-restore',
      '--numeric-owner',
    ]);
    const validation = await validateStagedTree(resolvedStage, members, { readdirFn, lstatFn, readlinkFn });
    return Object.freeze({
      backupDirectory: directory,
      sha256: preview.sha256,
      stageDirectory: resolvedStage,
      members: validation.members,
      ownershipMetadata: true,
      extendedMetadata: members.filter((member) => member.metadataMarker !== null).length,
      extendedMetadataValidated: false,
      metadataPlan: metadataSummary,
      liveMutation: false,
      destructive: false,
      validated: true,
    });
  } catch (error) {
    await rmFn(resolvedStage, { recursive: true, force: true }).catch(() => {});
    if (error instanceof LocalMigrationRestoreStageError) throw error;
    throw new LocalMigrationRestoreStageError('migration_restore_stage_extract_failed', 'Migration restore archive could not be staged safely');
  }
}

export const localMigrationRestoreStageInternals = Object.freeze({
  defaultStageRoot: DEFAULT_STAGE_ROOT,
  maxStageMembers: MAX_STAGE_MEMBERS,
  normalizeStageRoot,
  validMemberMetadata,
  validatePreview,
  summarizeMetadataPlan,
  actualType,
  collectStageEntries,
  validateStagedSymlink,
  validateHardlink,
  validateStagedTree,
});
