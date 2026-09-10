import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  localMigrationBackupInternals,
  resolveLocalMigrationBackupDirectory,
  verifyLocalMigrationBackup,
} from './local-migration-backup.js';

const execFileAsync = promisify(execFile);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;
const MAX_LISTING_BYTES = 32 * 1024 * 1024;
const MAX_MEMBERS = 200_000;
const SAFE_TYPES = new Set(['-', 'd', 'l', 'h']);

export class LocalMigrationArchiveInspectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalMigrationArchiveInspectionError';
    this.code = code;
  }
}

function decodeCStringAt(value, start) {
  if (value[start] !== '"') throw new LocalMigrationArchiveInspectionError('migration_archive_listing_invalid', 'Migration archive listing contains invalid quoted metadata');
  let output = '';
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') return { value: output, end: index + 1 };
    if (character !== '\\') {
      output += character;
      continue;
    }
    index += 1;
    if (index >= value.length) break;
    const escaped = value[index];
    const simple = {
      a: String.fromCharCode(7),
      b: String.fromCharCode(8),
      f: String.fromCharCode(12),
      n: String.fromCharCode(10),
      r: String.fromCharCode(13),
      t: String.fromCharCode(9),
      v: String.fromCharCode(11),
      '\\': '\\',
      '"': '"',
    };
    if (Object.hasOwn(simple, escaped)) {
      output += simple[escaped];
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && index + 1 < value.length && /[0-7]/.test(value[index + 1])) {
        index += 1;
        octal += value[index];
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }
    if (escaped === 'x') {
      let hex = '';
      while (hex.length < 2 && index + 1 < value.length && /[a-f0-9]/i.test(value[index + 1])) {
        index += 1;
        hex += value[index];
      }
      if (hex.length === 0) break;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      continue;
    }
    break;
  }
  throw new LocalMigrationArchiveInspectionError('migration_archive_listing_invalid', 'Migration archive listing contains invalid C quoting');
}

function extractCStringLiterals(line) {
  const values = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '"') continue;
    const decoded = decodeCStringAt(line, index);
    values.push(decoded.value);
    index = decoded.end - 1;
  }
  return values;
}

function normalizeMemberName(value) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value) || value.startsWith('/')) {
    throw new LocalMigrationArchiveInspectionError('migration_archive_member_invalid', 'Migration archive contains an unsafe member path');
  }
  const stripped = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (!stripped || stripped === '.' || stripped === '..' || stripped.startsWith('../') || stripped.includes('/../')) {
    throw new LocalMigrationArchiveInspectionError('migration_archive_member_invalid', 'Migration archive contains an unsafe member path');
  }
  const normalized = path.posix.normalize(stripped);
  if (normalized !== stripped || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new LocalMigrationArchiveInspectionError('migration_archive_member_invalid', 'Migration archive contains a non-canonical member path');
  }
  return normalized;
}

function normalizeLinkTarget(member, target, { hardlink = false } = {}) {
  if (typeof target !== 'string' || target.length === 0 || CONTROL_CHARACTER_PATTERN.test(target)) {
    throw new LocalMigrationArchiveInspectionError('migration_archive_link_invalid', 'Migration archive contains an invalid link target');
  }
  if (hardlink) return normalizeMemberName(target);
  let resolved;
  if (target.startsWith('/')) {
    resolved = path.posix.normalize(target).replace(/^\/+/, '');
  } else {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(member), target));
  }
  if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw new LocalMigrationArchiveInspectionError('migration_archive_link_escape', 'Migration archive link target escapes its managed root');
  }
  return resolved;
}

function manifestRoots(verification, directory) {
  if (!verification || verification.verified !== true || verification.backupDirectory !== directory
    || verification.archivePath !== path.join(directory, 'state.tar')
    || verification.manifestPath !== path.join(directory, 'manifest.json')
    || typeof verification.sha256 !== 'string' || !HASH_PATTERN.test(verification.sha256)
    || !Array.isArray(verification.entries)) {
    throw new LocalMigrationArchiveInspectionError('migration_archive_backup_invalid', 'Migration archive inspection requires an exact verified backup acknowledgement');
  }
  const roots = verification.entries.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || !['file', 'directory'].includes(entry.type) || typeof entry.present !== 'boolean') {
      throw new LocalMigrationArchiveInspectionError('migration_archive_backup_invalid', 'Migration archive inspection received invalid manifest metadata');
    }
    return Object.freeze({
      path: entry.path,
      archivePath: localMigrationBackupInternals.relativeArchivePath(entry.path),
      type: entry.type,
      present: entry.present,
    });
  });
  return Object.freeze(roots.sort((left, right) => right.archivePath.length - left.archivePath.length));
}

function rootForMember(member, roots) {
  return roots.find((root) => root.present && (member === root.archivePath || member.startsWith(`${root.archivePath}/`))) ?? null;
}

function insideRoot(target, root) {
  return target === root.archivePath || target.startsWith(`${root.archivePath}/`);
}

function parseVerboseListing(stdout, roots) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_LISTING_BYTES) {
    throw new LocalMigrationArchiveInspectionError('migration_archive_listing_invalid', 'Migration archive listing is invalid or unexpectedly large');
  }
  const members = [];
  const seen = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (members.length >= MAX_MEMBERS) {
      throw new LocalMigrationArchiveInspectionError('migration_archive_too_many_members', 'Migration archive contains too many members');
    }
    const type = line[0];
    if (!SAFE_TYPES.has(type)) {
      throw new LocalMigrationArchiveInspectionError('migration_archive_special_member', 'Migration archive contains an unsupported special filesystem member');
    }
    const literals = extractCStringLiterals(line);
    if ((type === 'l' || type === 'h') ? literals.length !== 2 : literals.length !== 1) {
      throw new LocalMigrationArchiveInspectionError('migration_archive_listing_invalid', 'Migration archive verbose listing has an unexpected shape');
    }
    const name = normalizeMemberName(literals[0]);
    if (seen.has(name)) {
      throw new LocalMigrationArchiveInspectionError('migration_archive_duplicate_member', 'Migration archive contains a duplicate member path');
    }
    seen.add(name);
    const root = rootForMember(name, roots);
    if (!root) {
      throw new LocalMigrationArchiveInspectionError('migration_archive_member_outside_scope', 'Migration archive contains a member outside the verified source roots');
    }
    let linkTarget = null;
    let resolvedLinkTarget = null;
    if (type === 'l' || type === 'h') {
      linkTarget = literals[1];
      resolvedLinkTarget = normalizeLinkTarget(name, linkTarget, { hardlink: type === 'h' });
      if (!insideRoot(resolvedLinkTarget, root)) {
        throw new LocalMigrationArchiveInspectionError('migration_archive_link_escape', 'Migration archive link target escapes its managed root');
      }
    }
    members.push(Object.freeze({
      name,
      type,
      root: root.path,
      linkTarget,
      resolvedLinkTarget,
    }));
  }
  if (members.length === 0) {
    throw new LocalMigrationArchiveInspectionError('migration_archive_listing_invalid', 'Migration archive is empty');
  }

  for (const root of roots) {
    const exact = members.find((member) => member.name === root.archivePath);
    if (!root.present) {
      if (exact || members.some((member) => member.name.startsWith(`${root.archivePath}/`))) {
        throw new LocalMigrationArchiveInspectionError('migration_archive_absent_source_present', 'Migration archive contains data for a source recorded as absent');
      }
      continue;
    }
    const expectedType = root.type === 'directory' ? 'd' : '-';
    if (!exact || exact.type !== expectedType) {
      throw new LocalMigrationArchiveInspectionError('migration_archive_root_type_mismatch', 'Migration archive source root type does not match the verified manifest');
    }
  }

  for (const member of members.filter((entry) => entry.type === 'h')) {
    if (!seen.has(member.resolvedLinkTarget)) {
      throw new LocalMigrationArchiveInspectionError('migration_archive_hardlink_target_missing', 'Migration archive hard link target is not a verified archive member');
    }
  }

  return Object.freeze(members);
}

function defaultRunTar(args) {
  return execFileAsync(localMigrationBackupInternals.tarPath, args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: MAX_LISTING_BYTES,
  });
}

export async function inspectVerifiedLocalMigrationArchive({
  backupDirectory,
  verification,
  runTar = defaultRunTar,
} = {}) {
  if (typeof runTar !== 'function') {
    throw new LocalMigrationArchiveInspectionError('migration_archive_dependencies_invalid', 'Migration archive inspection dependencies are invalid');
  }
  const directory = resolveLocalMigrationBackupDirectory(backupDirectory);
  const roots = manifestRoots(verification, directory);
  let listing;
  try {
    listing = await runTar([
      '--list',
      '--verbose',
      '--numeric-owner',
      '--quoting-style=c',
      '--file',
      verification.archivePath,
    ]);
  } catch {
    throw new LocalMigrationArchiveInspectionError('migration_archive_listing_failed', 'Migration archive verbose listing could not be read');
  }
  const members = parseVerboseListing(listing?.stdout, roots);
  const counts = Object.freeze({
    total: members.length,
    files: members.filter((member) => member.type === '-').length,
    directories: members.filter((member) => member.type === 'd').length,
    symlinks: members.filter((member) => member.type === 'l').length,
    hardlinks: members.filter((member) => member.type === 'h').length,
  });
  const normalizedMembers = Object.freeze(members.map((member) => Object.freeze({
    name: member.name,
    type: member.type,
    root: member.root,
    resolvedLinkTarget: member.resolvedLinkTarget,
  })));
  return Object.freeze({
    backupDirectory: directory,
    sha256: verification.sha256,
    counts,
    members: normalizedMembers,
    linksSafe: true,
    destructive: false,
  });
}

export async function inspectLocalMigrationArchive({
  backupDirectory,
  verifyBackup = verifyLocalMigrationBackup,
  runTar = defaultRunTar,
} = {}) {
  if (typeof verifyBackup !== 'function') {
    throw new LocalMigrationArchiveInspectionError('migration_archive_dependencies_invalid', 'Migration archive inspection dependencies are invalid');
  }
  const directory = resolveLocalMigrationBackupDirectory(backupDirectory);
  let verification;
  try {
    verification = await verifyBackup({ backupDirectory: directory });
  } catch {
    throw new LocalMigrationArchiveInspectionError('migration_archive_backup_invalid', 'Migration archive inspection requires a valid verified backup');
  }
  return inspectVerifiedLocalMigrationArchive({ backupDirectory: directory, verification, runTar });
}

export const localMigrationArchiveInspectionInternals = Object.freeze({
  maxListingBytes: MAX_LISTING_BYTES,
  maxMembers: MAX_MEMBERS,
  decodeCStringAt,
  extractCStringLiterals,
  normalizeMemberName,
  normalizeLinkTarget,
  manifestRoots,
  parseVerboseListing,
});
