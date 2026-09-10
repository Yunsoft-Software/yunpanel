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

const scriptPath = fileURLToPath(import.meta.url);
const PACKAGED_SCRIPT_ROOT = '/usr/lib/yunpanel/scripts';
const BACKUP_ROOT = localMigrationBackupInternals.defaultRoot;
const USAGE = 'Usage: local-migration-backup.mjs create --confirm | verify <absolute-backup-directory> | preview <absolute-backup-directory>';

export function parseLocalMigrationBackupArguments(argv) {
  if (!Array.isArray(argv)) throw new Error(USAGE);
  if (argv.length === 2 && argv[0] === 'create' && argv[1] === '--confirm') {
    return { action: 'create', confirm: true };
  }
  if (argv.length === 2 && ['verify', 'preview'].includes(argv[0]) && typeof argv[1] === 'string' && path.isAbsolute(argv[1])) {
    return { action: argv[0], backupDirectory: path.resolve(argv[1]) };
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
  const lines = [
    'action=preview',
    'destructive=false',
    `backupDirectory=${result.backupDirectory}`,
    `sha256=${result.sha256}`,
    `restoreTargets=${result.counts.restore}`,
    `identityReferences=${result.counts.identityReferences}`,
    `preservedCurrent=${result.counts.preserved}`,
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
  return lines.join('\n');
}

export async function runLocalMigrationBackupCli({
  argv = process.argv.slice(2),
  filePath = scriptPath,
  uid = process.getuid?.(),
  backupRoot = BACKUP_ROOT,
  createBackup = createLocalMigrationBackup,
  verifyBackup = verifyLocalMigrationBackup,
  previewRestore = previewLocalMigrationRestore,
  stdout = process.stdout,
} = {}) {
  const parsed = parseLocalMigrationBackupArguments(argv);
  const packaged = isPackagedMigrationBackupScript(filePath);
  assertPackagedMigrationBackupRoot({ packaged, uid });
  if (typeof createBackup !== 'function' || typeof verifyBackup !== 'function' || typeof previewRestore !== 'function'
    || !stdout || typeof stdout.write !== 'function') {
    throw new Error('Migration backup CLI dependencies are invalid');
  }

  if (parsed.action === 'preview') {
    const directory = assertPackagedBackupDirectory(parsed.backupDirectory, backupRoot);
    const result = await previewRestore({ backupDirectory: directory, verifyBackup });
    if (!result || result.destructive !== false || result.backupDirectory !== directory
      || !result.counts || !Array.isArray(result.targets) || typeof result.sha256 !== 'string') {
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
  formatResult,
  formatPreview,
});
