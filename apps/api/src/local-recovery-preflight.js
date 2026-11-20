import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { assertUuid } from '@yunpanel/shared';
import { localMigrationBackupInternals, verifyLocalMigrationBackup } from './local-migration-backup.js';

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const BINDING_MEMBER = 'etc/yunpanel/control-plane/api.env';
const BINDING_LINE = /^\s*YUNPANEL_LOCAL_SERVER_ID\s*=/;
const SNAPSHOT_ENTRIES = ['', 'state.tar', 'manifest.json'];

class LocalRecoveryPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalRecoveryPreflightError';
    this.code = code;
  }
}

function runTar(args, maxBuffer = 8 * 1024 * 1024) {
  return execFileAsync(localMigrationBackupInternals.tarPath, args, {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer,
  });
}

async function readSnapshotMetadata(directory) {
  let metadata;
  try {
    metadata = await Promise.all(SNAPSHOT_ENTRIES.map((entry) => lstat(path.join(directory, entry), { bigint: true })));
  } catch {
    throw new LocalRecoveryPreflightError('recovery_snapshot_missing', 'The local snapshot is incomplete or unavailable');
  }
  if (!metadata[0].isDirectory() || metadata.slice(1).some((entry) => !entry.isFile())
    || metadata.some((entry) => entry.uid !== BigInt(process.getuid()) || (entry.mode & 0o077n) !== 0n)) {
    throw new LocalRecoveryPreflightError('recovery_snapshot_not_private', 'The snapshot must be private and owned by the operator');
  }
  return metadata;
}

function compareSnapshotMetadata(before, after) {
  const fields = ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs'];
  return before.every((entry, index) => fields.every((field) => entry[field] === after[index][field]));
}

async function readArchivedServerId(archivePath) {
  try {
    const listing = await runTar(['--list', '--verbose', '--file', archivePath, '--', BINDING_MEMBER], 128 * 1024);
    const members = listing.stdout.trim().split('\n');
    if (members.length !== 1 || !members[0].startsWith('-')) throw new Error('Invalid binding member');
    const extracted = await runTar(['--extract', '--to-stdout', '--file', archivePath, '--', BINDING_MEMBER], 128 * 1024);
    const assignments = extracted.stdout.split(/\r?\n/).filter((line) => BINDING_LINE.test(line));
    if (assignments.length !== 1) throw new Error('Invalid binding assignment');
    const value = assignments[0].replace(BINDING_LINE, '').trim().replace(/^(["'])(.*)\1$/, '$2');
    if (parseEnv(extracted.stdout).YUNPANEL_LOCAL_SERVER_ID !== value) throw new Error('Invalid binding value');
    return assertUuid(value, 'serverId');
  } catch {
    throw new LocalRecoveryPreflightError('recovery_snapshot_binding_invalid', 'The archive lacks a unique, valid local server binding');
  }
}

export async function preflightLocalRecoveryBackup({ backupDirectory, expectedSha256, expectedServerId } = {}) {
  if (typeof backupDirectory !== 'string' || !path.isAbsolute(backupDirectory) || /[\u0000\r\n]/.test(backupDirectory)) {
    throw new LocalRecoveryPreflightError('recovery_snapshot_path_invalid', 'An absolute local snapshot directory is required');
  }
  if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) {
    throw new LocalRecoveryPreflightError('recovery_expected_hash_invalid', 'The recorded archive SHA-256 is required');
  }
  let expectedBinding;
  try {
    expectedBinding = assertUuid(expectedServerId, 'serverId');
  } catch {
    throw new LocalRecoveryPreflightError('recovery_expected_binding_invalid', 'The recorded source server identifier is required');
  }

  const directory = path.resolve(backupDirectory);
  const before = await readSnapshotMetadata(directory);
  let verification;
  try {
    verification = await verifyLocalMigrationBackup({ backupDirectory: directory, runTar });
  } catch (error) {
    throw new LocalRecoveryPreflightError(error.code ?? 'recovery_snapshot_verification_failed', 'The local snapshot failed manifest or archive verification');
  }
  if (verification.sha256 !== expectedSha256) {
    throw new LocalRecoveryPreflightError('recovery_snapshot_hash_mismatch', 'The snapshot differs from the recorded archive SHA-256');
  }
  if (await readArchivedServerId(verification.archivePath) !== expectedBinding) {
    throw new LocalRecoveryPreflightError('recovery_snapshot_binding_mismatch', 'The snapshot belongs to a different server');
  }
  const after = await readSnapshotMetadata(directory);
  if (!compareSnapshotMetadata(before, after)) {
    throw new LocalRecoveryPreflightError('recovery_snapshot_changed', 'The snapshot changed during verification');
  }
  return Object.freeze({
    verified: true,
    manifestVersion: localMigrationBackupInternals.storeVersion,
    serverBindingMatches: true,
    presentSources: verification.entries.filter((entry) => entry.present).length,
    liveMutation: false,
  });
}
