#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createLocalMigrationBackup,
  localMigrationBackupInternals,
  verifyLocalMigrationBackup,
} from '../apps/api/src/local-migration-backup.js';

const scriptPath = fileURLToPath(import.meta.url);
const PACKAGED_SCRIPT_ROOT = '/usr/lib/yunpanel/scripts';
const BACKUP_ROOT = localMigrationBackupInternals.defaultRoot;
const USAGE = 'Usage: local-migration-backup.mjs create --confirm | verify <absolute-backup-directory>';

export function parseLocalMigrationBackupArguments(argv) {
  if (!Array.isArray(argv)) throw new Error(USAGE);
  if (argv.length === 2 && argv[0] === 'create' && argv[1] === '--confirm') {
    return { action: 'create', confirm: true };
  }
  if (argv.length === 2 && argv[0] === 'verify' && typeof argv[1] === 'string' && path.isAbsolute(argv[1])) {
    return { action: 'verify', backupDirectory: path.resolve(argv[1]) };
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
  const root = path.resolve(backupRoot);
  const resolved = path.resolve(backupDirectory);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Migration backup directory must be a snapshot below ${root}`);
  }
  return resolved;
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

export async function runLocalMigrationBackupCli({
  argv = process.argv.slice(2),
  filePath = scriptPath,
  uid = process.getuid?.(),
  backupRoot = BACKUP_ROOT,
  createBackup = createLocalMigrationBackup,
  verifyBackup = verifyLocalMigrationBackup,
  stdout = process.stdout,
} = {}) {
  const parsed = parseLocalMigrationBackupArguments(argv);
  const packaged = isPackagedMigrationBackupScript(filePath);
  assertPackagedMigrationBackupRoot({ packaged, uid });
  if (typeof createBackup !== 'function' || typeof verifyBackup !== 'function' || !stdout || typeof stdout.write !== 'function') {
    throw new Error('Migration backup CLI dependencies are invalid');
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
});
