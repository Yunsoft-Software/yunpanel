#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createLocalMigrationBackup,
  localMigrationBackupInternals,
  resolveLocalMigrationBackupDirectory,
  verifyLocalMigrationBackup,
} from '../apps/api/src/local-migration-backup.js';
import { previewLocalMigrationRestore } from '../apps/api/src/local-migration-restore-preview.js';
import {
  localMigrationRestoreStageInternals,
  stageLocalMigrationRestore,
} from '../apps/api/src/local-migration-restore-stage.js';

const scriptPath = fileURLToPath(import.meta.url);
const PACKAGED_SCRIPT_ROOT = '/usr/lib/yunpanel/scripts';
const BACKUP_ROOT = localMigrationBackupInternals.defaultRoot;
const STAGE_ROOT = localMigrationRestoreStageInternals.defaultStageRoot;
const USAGE = 'Usage: local-migration-backup.mjs create --confirm | verify <absolute-backup-directory> | preview <absolute-backup-directory> | stage <absolute-backup-directory> --confirm';

export function parseLocalMigrationBackupArguments(argv) {
  if (!Array.isArray(argv)) throw new Error(USAGE);
  if (argv.length === 2 && argv[0] === 'create' && argv[1] === '--confirm') {
    return { action: 'create', confirm: true };
  }
  if (argv.length === 2 && ['verify', 'preview'].includes(argv[0]) && typeof argv[1] === 'string' && path.isAbsolute(argv[1])) {
    return { action: argv[0], backupDirectory: path.resolve(argv[1]) };
  }
  if (argv.length === 3 && argv[0] === 'stage' && typeof argv[1] === 'string'
    && path.isAbsolute(argv[1]) && argv[2] === '--confirm') {
    return { action: 'stage', backupDirectory: path.resolve(argv[1]), confirm: true };
  }
  throw new Error(USAGE);
}

export function isPackagedMigrationBackupScript(filePath = scriptPath) {
  const resolved = path.resolve(filePath);
  return resolved === PACKAGED_SCRIPT_ROOT || resolved.startsWith(`${PACKAGED_SCRIPT_ROOT}${path.sep}`);
}

export function assertPackagedMigrationBackupRoot({ packaged, uid = process.getuid?.() } = {}) {
  if (!packaged) throw new Error('Migration backup commands are available only from the packaged YunPanel installation');
  if (uid !== 0) throw new Error('Packaged migration backup commands must be run as root');
}

export function assertPackagedBackupDirectory(backupDirectory, backupRoot = BACKUP_ROOT) {
  return resolveLocalMigrationBackupDirectory(backupDirectory, backupRoot);
}

function formatResult(result, action) {
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const present = entries.filter((entry) => entry?.present === true).length;
  const missing = entries.length - present;
  return [
    `action=${action}`,
    'verified=true',
    `backupDirectory=${result.backupDirectory}`,
    `archive=${result.archivePath}`,
    `manifest=${result.manifestPath}`,
    `sha256=${result.sha256}`,
    `sourcesPresent=${present}`,
    `sourcesMissingOptional=${missing}`,
  ].join('\n');
}

function formatPreview(result) {
  const archive = result.archiveInspection;
  const identity = result.identityComparison;
  const lines = [
    'action=preview',
    'destructive=false',
    `backupDirectory=${result.backupDirectory}`,
    `sha256=${result.sha256}`,
    `archiveMembers=${archive.counts.total}`,
    `archiveFiles=${archive.counts.files}`,
    `archiveDirectories=${archive.counts.directories}`,
    `archiveSymlinks=${archive.counts.symlinks}`,
    `archiveHardlinks=${archive.counts.hardlinks}`,
    `archiveExtendedMetadata=${archive.counts.extendedMetadata}`,
    'archiveLinksSafe=true',
    'archiveOwnershipMetadata=true',
    'archiveExtendedMetadataValidated=false',
    `restoreTargets=${result.counts.restore}`,
    `identityReferences=${result.counts.identityReferences}`,
    `preservedCurrent=${result.counts.preserved}`,
    `identitySnapshotUsers=${identity.snapshotUsers}`,
    `identityCurrentUsers=${identity.currentUsers}`,
    `identityMatched=${identity.counts.match}`,
    `identityDrift=${identity.counts.drift}`,
    `identityMissingCurrent=${identity.counts.missingCurrent}`,
    `identityAddedCurrent=${identity.counts.addedCurrent}`,
  ];
  for (const target of result.targets) {
    lines.push([
      'target',
      `path=${target.path}`,
      `action=${target.action}`,
      `snapshot=${target.snapshotPresent ? target.snapshotType : 'absent'}`,
      `current=${target.current.present ? target.current.type : 'absent'}`,
    ].join(' '));
  }
  for (const entry of identity.identities.filter((candidate) => candidate.status !== 'match')) {
    lines.push([
      'identity',
      `name=${entry.name}`,
      `status=${entry.status}`,
      `changed=${entry.changedFields.length > 0 ? entry.changedFields.join(',') : '-'}`,
    ].join(' '));
  }
  return lines.join('\n');
}

function formatStage(result) {
  return [
    'action=stage',
    'validated=true',
    'destructive=false',
    'liveMutation=false',
    'ownershipMetadata=true',
    `extendedMetadata=${result.extendedMetadata}`,
    'extendedMetadataValidated=false',
    `backupDirectory=${result.backupDirectory}`,
    `sha256=${result.sha256}`,
    `stageDirectory=${result.stageDirectory}`,
    `members=${result.members}`,
  ].join('\n');
}

function validArchivePreview(archive, result, directory) {
  if (!archive || archive.destructive !== false || archive.linksSafe !== true
    || archive.ownershipMetadata !== true || archive.extendedMetadataValidated !== false
    || archive.backupDirectory !== directory || archive.sha256 !== result.sha256
    || !archive.counts || typeof archive.counts !== 'object' || !Array.isArray(archive.members)) return false;
  for (const key of ['total', 'files', 'directories', 'symlinks', 'hardlinks', 'extendedMetadata']) {
    if (!Number.isInteger(archive.counts[key]) || archive.counts[key] < 0) return false;
  }
  return archive.counts.files + archive.counts.directories + archive.counts.symlinks + archive.counts.hardlinks === archive.counts.total
    && archive.members.length === archive.counts.total
    && archive.members.filter((member) => member?.metadataMarker != null).length === archive.counts.extendedMetadata;
}

function validIdentityPreview(identity, result, directory) {
  if (!identity || identity.destructive !== false || identity.backupDirectory !== directory || identity.sha256 !== result.sha256
    || !Number.isInteger(identity.snapshotUsers) || !Number.isInteger(identity.currentUsers)
    || !identity.counts || !Array.isArray(identity.identities)) return false;
  if (!['match', 'drift', 'missingCurrent', 'addedCurrent']
    .every((key) => Number.isInteger(identity.counts[key]) && identity.counts[key] >= 0)) return false;
  return identity.counts.match + identity.counts.drift + identity.counts.missingCurrent + identity.counts.addedCurrent === identity.identities.length;
}

function validStageResult(result, directory) {
  if (!result || result.validated !== true || result.destructive !== false || result.liveMutation !== false
    || result.ownershipMetadata !== true || result.extendedMetadataValidated !== false
    || result.backupDirectory !== directory || typeof result.sha256 !== 'string'
    || typeof result.stageDirectory !== 'string' || !path.isAbsolute(result.stageDirectory)
    || !Number.isInteger(result.members) || result.members < 1
    || !Number.isInteger(result.extendedMetadata) || result.extendedMetadata < 0 || result.extendedMetadata > result.members) return false;
  const resolvedStage = path.resolve(result.stageDirectory);
  return path.dirname(resolvedStage) === STAGE_ROOT;
}

export async function runLocalMigrationBackupCli({
  argv = process.argv.slice(2),
  filePath = scriptPath,
  uid = process.getuid?.(),
  backupRoot = BACKUP_ROOT,
  createBackup = createLocalMigrationBackup,
  verifyBackup = verifyLocalMigrationBackup,
  previewRestore = previewLocalMigrationRestore,
  stageRestore = stageLocalMigrationRestore,
  stdout = process.stdout,
} = {}) {
  const parsed = parseLocalMigrationBackupArguments(argv);
  const packaged = isPackagedMigrationBackupScript(filePath);
  assertPackagedMigrationBackupRoot({ packaged, uid });
  if (typeof createBackup !== 'function' || typeof verifyBackup !== 'function' || typeof previewRestore !== 'function'
    || typeof stageRestore !== 'function' || !stdout || typeof stdout.write !== 'function') {
    throw new Error('Migration backup CLI dependencies are invalid');
  }

  if (parsed.action === 'stage') {
    const directory = assertPackagedBackupDirectory(parsed.backupDirectory, backupRoot);
    const result = await stageRestore({ backupDirectory: directory });
    if (!validStageResult(result, directory)) throw new Error('Migration restore staging result is invalid');
    stdout.write(`${formatStage(result)}\n`);
    return result;
  }

  if (parsed.action === 'preview') {
    const directory = assertPackagedBackupDirectory(parsed.backupDirectory, backupRoot);
    const result = await previewRestore({ backupDirectory: directory, verifyBackup });
    if (!result || result.destructive !== false || result.backupDirectory !== directory
      || !result.counts || !Array.isArray(result.targets) || typeof result.sha256 !== 'string'
      || !validArchivePreview(result.archiveInspection, result, directory)
      || !validIdentityPreview(result.identityComparison, result, directory)) {
      throw new Error('Migration restore preview result is invalid');
    }
    stdout.write(`${formatPreview(result)}\n`);
    return result;
  }

  let result;
  if (parsed.action === 'create') {
    const created = await createBackup({ root: backupRoot });
    const directory = assertPackagedBackupDirectory(created.backupDirectory, backupRoot);
    result = await verifyBackup({ backupDirectory: directory });
  } else {
    const directory = assertPackagedBackupDirectory(parsed.backupDirectory, backupRoot);
    result = await verifyBackup({ backupDirectory: directory });
  }

  if (!result || result.verified !== true || typeof result.backupDirectory !== 'string'
    || typeof result.archivePath !== 'string' || typeof result.manifestPath !== 'string'
    || typeof result.sha256 !== 'string' || !Array.isArray(result.entries)) {
    throw new Error('Migration backup verification result is invalid');
  }
  stdout.write(`${formatResult(result, parsed.action)}\n`);
  return result;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runLocalMigrationBackupCli().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  });
}

export const localMigrationBackupCliInternals = Object.freeze({
  packagedScriptRoot: PACKAGED_SCRIPT_ROOT,
  backupRoot: BACKUP_ROOT,
  stageRoot: STAGE_ROOT,
  formatResult,
  formatPreview,
  formatStage,
  validArchivePreview,
  validIdentityPreview,
  validStageResult,
});
