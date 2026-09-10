import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  localMigrationBackupInternals,
  resolveLocalMigrationBackupDirectory,
  verifyLocalMigrationBackup,
} from './local-migration-backup.js';

const execFileAsync = promisify(execFile);
const PASSWD_PATH = '/etc/passwd';
const GROUP_PATH = '/etc/group';
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const MAX_IDENTITY_BYTES = 1024 * 1024;
const MAX_MANAGED_USERS = 1024;

export class LocalMigrationUnixIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalMigrationUnixIdentityError';
    this.code = code;
  }
}

function parseNumericId(value, label) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new LocalMigrationUnixIdentityError('migration_identity_record_invalid', `${label} contains an invalid numeric identity`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new LocalMigrationUnixIdentityError('migration_identity_record_invalid', `${label} contains an invalid numeric identity`);
  }
  return parsed;
}

function assertManagedPath(value, label) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\u0000\r\n]/.test(value)) {
    throw new LocalMigrationUnixIdentityError('migration_identity_record_invalid', `${label} contains an invalid managed path`);
  }
  return value;
}

function parseManagedPasswd(text, label) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_IDENTITY_BYTES) {
    throw new LocalMigrationUnixIdentityError('migration_identity_file_invalid', `${label} passwd data is invalid`);
  }
  const users = new Map();
  const uids = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#')) continue;
    const fields = rawLine.split(':');
    const name = fields[0] ?? '';
    if (!APP_USER_PATTERN.test(name)) continue;
    if (fields.length !== 7 || users.has(name)) {
      throw new LocalMigrationUnixIdentityError('migration_identity_record_invalid', `${label} contains an invalid managed passwd record`);
    }
    const uid = parseNumericId(fields[2], `${label} passwd`);
    const gid = parseNumericId(fields[3], `${label} passwd`);
    if (uids.has(uid)) {
      throw new LocalMigrationUnixIdentityError('migration_identity_record_invalid', `${label} contains duplicate managed Unix user IDs`);
    }
    uids.add(uid);
    users.set(name, Object.freeze({
      name,
      uid,
      gid,
      home: assertManagedPath(fields[5], `${label} passwd home`),
      shell: assertManagedPath(fields[6], `${label} passwd shell`),
    }));
    if (users.size > MAX_MANAGED_USERS) {
      throw new LocalMigrationUnixIdentityError('migration_identity_too_many_users', `${label} contains too many managed Unix identities`);
    }
  }
  return users;
}

function parseGroups(text, label) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_IDENTITY_BYTES) {
    throw new LocalMigrationUnixIdentityError('migration_identity_file_invalid', `${label} group data is invalid`);
  }
  const groups = [];
  const managedNames = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#')) continue;
    const fields = rawLine.split(':');
    const mentionsManagedIdentity = rawLine.includes('yunapp-');
    if (fields.length !== 4) {
      if (mentionsManagedIdentity) {
        throw new LocalMigrationUnixIdentityError('migration_identity_record_invalid', `${label} contains an invalid managed group record`);
      }
      continue;
    }
    const [name, , rawGid, rawMembers] = fields;
    if (!/^[0-9]+$/.test(rawGid)) {
      if (APP_USER_PATTERN.test(name) || rawMembers.split(',').some((member) => APP_USER_PATTERN.test(member))) {
        throw new LocalMigrationUnixIdentityError('migration_identity_record_invalid', `${label} contains an invalid managed group identity`);
      }
      continue;
    }
    const gid = parseNumericId(rawGid, `${label} group`);
    const members = Object.freeze([...new Set(rawMembers.split(',').filter(Boolean))].sort());
    if (APP_USER_PATTERN.test(name)) {
      if (managedNames.has(name)) {
        throw new LocalMigrationUnixIdentityError('migration_identity_record_invalid', `${label} contains duplicate managed Unix groups`);
      }
      managedNames.add(name);
    }
    groups.push(Object.freeze({ name, gid, members }));
  }
  return Object.freeze(groups);
}

function buildManagedIdentities(passwdText, groupText, label) {
  const users = parseManagedPasswd(passwdText, label);
  const groups = parseGroups(groupText, label);
  const identities = new Map();
  for (const user of users.values()) {
    const dedicatedGroup = groups.find((group) => group.name === user.name);
    if (!dedicatedGroup || dedicatedGroup.gid !== user.gid) {
      throw new LocalMigrationUnixIdentityError('migration_identity_dedicated_group_invalid', `${label} managed Unix user does not have its dedicated primary group`);
    }
    const primaryGroups = groups.filter((group) => group.gid === user.gid).map((group) => group.name).sort();
    const supplementaryGroups = groups
      .filter((group) => group.members.includes(user.name))
      .map((group) => Object.freeze({ name: group.name, gid: group.gid }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.gid - right.gid);
    identities.set(user.name, Object.freeze({
      name: user.name,
      uid: user.uid,
      gid: user.gid,
      home: user.home,
      shell: user.shell,
      primaryGroups: Object.freeze(primaryGroups),
      supplementaryGroups: Object.freeze(supplementaryGroups),
    }));
  }
  return identities;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareIdentity(snapshot, current) {
  if (!snapshot) return Object.freeze({ name: current.name, status: 'added_current', changedFields: Object.freeze([]), snapshot: null, current });
  if (!current) return Object.freeze({ name: snapshot.name, status: 'missing_current', changedFields: Object.freeze([]), snapshot, current: null });
  const changedFields = ['uid', 'gid', 'home', 'shell', 'primaryGroups', 'supplementaryGroups']
    .filter((field) => !sameValue(snapshot[field], current[field]));
  return Object.freeze({
    name: snapshot.name,
    status: changedFields.length === 0 ? 'match' : 'drift',
    changedFields: Object.freeze(changedFields),
    snapshot,
    current,
  });
}

async function readCurrentIdentityFile(target, { lstatFn, readFileFn }) {
  let metadata;
  try {
    metadata = await lstatFn(target);
  } catch {
    throw new LocalMigrationUnixIdentityError('migration_identity_current_unreadable', `Current Unix identity file could not be inspected: ${target}`);
  }
  if (!metadata || typeof metadata.isSymbolicLink !== 'function' || metadata.isSymbolicLink()
    || typeof metadata.isFile !== 'function' || !metadata.isFile()
    || !Number.isFinite(metadata.size) || metadata.size < 0 || metadata.size > MAX_IDENTITY_BYTES) {
    throw new LocalMigrationUnixIdentityError('migration_identity_current_unsafe', `Current Unix identity file is unsafe or unexpectedly large: ${target}`);
  }
  try {
    const value = await readFileFn(target, 'utf8');
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_IDENTITY_BYTES) throw new Error('invalid');
    return value;
  } catch {
    throw new LocalMigrationUnixIdentityError('migration_identity_current_unreadable', `Current Unix identity file could not be read: ${target}`);
  }
}

async function extractIdentityMember(archivePath, target, runTar) {
  const member = localMigrationBackupInternals.relativeArchivePath(target);
  let result;
  try {
    result = await runTar(['--extract', '--to-stdout', '--file', archivePath, '--', member]);
  } catch {
    throw new LocalMigrationUnixIdentityError('migration_identity_snapshot_unreadable', `Snapshot Unix identity file could not be read: ${target}`);
  }
  if (!result || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout, 'utf8') > MAX_IDENTITY_BYTES) {
    throw new LocalMigrationUnixIdentityError('migration_identity_snapshot_unreadable', `Snapshot Unix identity file is invalid or unexpectedly large: ${target}`);
  }
  return result.stdout;
}

function assertIdentityArchiveMembers(stdout) {
  const expected = ['etc/group', 'etc/passwd'];
  const actual = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean)
    .sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new LocalMigrationUnixIdentityError('migration_identity_snapshot_members_invalid', 'Snapshot Unix identity members are missing or duplicated');
  }
}

export async function compareLocalMigrationUnixIdentities({
  backupDirectory,
  verifyBackup = verifyLocalMigrationBackup,
  lstatFn = lstat,
  readFileFn = readFile,
  runTar = (args) => execFileAsync(localMigrationBackupInternals.tarPath, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_IDENTITY_BYTES + (64 * 1024),
  }),
} = {}) {
  if (typeof verifyBackup !== 'function' || typeof lstatFn !== 'function'
    || typeof readFileFn !== 'function' || typeof runTar !== 'function') {
    throw new LocalMigrationUnixIdentityError('migration_identity_dependencies_invalid', 'Migration Unix identity comparison dependencies are invalid');
  }
  const directory = resolveLocalMigrationBackupDirectory(backupDirectory);
  let verification;
  try {
    verification = await verifyBackup({ backupDirectory: directory });
  } catch {
    throw new LocalMigrationUnixIdentityError('migration_identity_backup_invalid', 'Migration Unix identity comparison requires a valid verified backup');
  }
  if (!verification || verification.verified !== true || verification.backupDirectory !== directory
    || verification.archivePath !== path.join(directory, 'state.tar')
    || verification.manifestPath !== path.join(directory, 'manifest.json')
    || !Array.isArray(verification.entries)) {
    throw new LocalMigrationUnixIdentityError('migration_identity_backup_invalid', 'Migration Unix identity backup acknowledgement is invalid');
  }
  for (const target of [PASSWD_PATH, GROUP_PATH]) {
    const entry = verification.entries.find((candidate) => candidate?.path === target);
    if (!entry || entry.type !== 'file' || entry.present !== true) {
      throw new LocalMigrationUnixIdentityError('migration_identity_backup_invalid', 'Verified migration backup is missing required Unix identity metadata');
    }
  }

  let listing;
  try {
    listing = await runTar(['--list', '--file', verification.archivePath, '--', 'etc/passwd', 'etc/group']);
  } catch {
    throw new LocalMigrationUnixIdentityError('migration_identity_snapshot_unreadable', 'Snapshot Unix identity members could not be inspected');
  }
  assertIdentityArchiveMembers(listing?.stdout);

  const [snapshotPasswd, snapshotGroup, currentPasswd, currentGroup] = await Promise.all([
    extractIdentityMember(verification.archivePath, PASSWD_PATH, runTar),
    extractIdentityMember(verification.archivePath, GROUP_PATH, runTar),
    readCurrentIdentityFile(PASSWD_PATH, { lstatFn, readFileFn }),
    readCurrentIdentityFile(GROUP_PATH, { lstatFn, readFileFn }),
  ]);
  const snapshot = buildManagedIdentities(snapshotPasswd, snapshotGroup, 'Snapshot');
  const current = buildManagedIdentities(currentPasswd, currentGroup, 'Current host');
  const names = [...new Set([...snapshot.keys(), ...current.keys()])].sort();
  const identities = Object.freeze(names.map((name) => compareIdentity(snapshot.get(name), current.get(name))));
  const counts = Object.freeze({
    match: identities.filter((entry) => entry.status === 'match').length,
    drift: identities.filter((entry) => entry.status === 'drift').length,
    missingCurrent: identities.filter((entry) => entry.status === 'missing_current').length,
    addedCurrent: identities.filter((entry) => entry.status === 'added_current').length,
  });

  return Object.freeze({
    backupDirectory: directory,
    sha256: verification.sha256,
    snapshotUsers: snapshot.size,
    currentUsers: current.size,
    counts,
    identities,
    destructive: false,
  });
}

export const localMigrationUnixIdentityInternals = Object.freeze({
  passwdPath: PASSWD_PATH,
  groupPath: GROUP_PATH,
  appUserPattern: APP_USER_PATTERN,
  maxIdentityBytes: MAX_IDENTITY_BYTES,
  maxManagedUsers: MAX_MANAGED_USERS,
  parseManagedPasswd,
  parseGroups,
  buildManagedIdentities,
  compareIdentity,
  assertIdentityArchiveMembers,
});
