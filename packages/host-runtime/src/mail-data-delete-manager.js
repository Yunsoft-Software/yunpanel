import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createMailDataBackupManager } from './mail-data-backup-manager.js';
import { createMailDataInspector } from './mail-data-inspector.js';
import { parseManagedVmailIdentity } from './mail-vmail-identity.js';

const execFileAsync = promisify(execFile);
const GETENT = '/usr/bin/getent';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_OUTPUT = 16 * 1024;
const COPY_BUFFER_BYTES = 128 * 1024;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class MailDataDeleteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDataDeleteError';
    this.code = code;
  }
}

function transactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_ID_PATTERN.test(value)) {
    throw new MailDataDeleteError('mail_data_delete_transaction_invalid', 'Mail data delete transaction id is invalid');
  }
  return value;
}

function snapshotSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new MailDataDeleteError('mail_data_delete_snapshot_invalid', 'Mail data delete target snapshot is invalid');
  }
  return value;
}

function compareEntryNames(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function updateTreeHash(hash, tuple) {
  hash.update(`${JSON.stringify(tuple)}\n`);
}

function missing(error) {
  return error?.code === 'ENOENT';
}

export function createMailDataDeleteManager({
  backupManager = createMailDataBackupManager(),
  mailDataInspector = createMailDataInspector(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
  lstatFn = lstat,
  openFn = open,
  readdirFn = readdir,
  renameFn = rename,
  rmFn = rm,
} = {}) {
  if (!backupManager || typeof backupManager.materializeBackup !== 'function') {
    throw new MailDataDeleteError('mail_data_delete_backup_manager_invalid', 'Mail data backup manager is unavailable');
  }
  if (!mailDataInspector || typeof mailDataInspector.inspectMailbox !== 'function'
    || typeof mailDataInspector.inspectDomain !== 'function') {
    throw new MailDataDeleteError('mail_data_delete_inspector_invalid', 'Mail data inspector is unavailable');
  }
  if (typeof run !== 'function') {
    throw new MailDataDeleteError('mail_data_delete_runtime_invalid', 'Mail data delete runtime is unavailable');
  }
  let mutation = Promise.resolve();

  async function resolveVmailIdentity() {
    try {
      const result = await run(GETENT, ['passwd', 'vmail'], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      const output = String(result?.stdout ?? result ?? '').trim();
      if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error('output too large');
      const identity = parseManagedVmailIdentity(output);
      if (!identity) throw new Error('invalid vmail identity');
      return identity;
    } catch {
      throw new MailDataDeleteError('mail_data_delete_vmail_unavailable', 'Managed vmail identity could not be resolved safely');
    }
  }

  async function inspectTarget(scope, identity) {
    return scope === 'mailbox'
      ? mailDataInspector.inspectMailbox(identity)
      : mailDataInspector.inspectDomain(identity);
  }

  async function pathState(targetPath) {
    try {
      const metadata = await lstatFn(targetPath);
      return { present: true, metadata };
    } catch (error) {
      if (missing(error)) return { present: false, metadata: null };
      throw error;
    }
  }

  async function verifyLiveTree(root, vmail) {
    const hash = createHash('sha256');
    let files = 0;
    let directories = 0;
    let bytes = 0;

    async function visit(current, relative) {
      const metadata = await lstatFn(current);
      if (metadata.isSymbolicLink()) throw new Error('symlink');
      if (metadata.isDirectory()) {
        if ((metadata.mode & 0o7777) !== DIRECTORY_MODE || metadata.uid !== vmail.uid || metadata.gid !== vmail.gid) {
          throw new Error('directory metadata');
        }
        if (relative) directories += 1;
        updateTreeHash(hash, ['d', relative]);
        const entries = await readdirFn(current, { withFileTypes: true });
        entries.sort(compareEntryNames);
        for (const entry of entries) {
          const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
          await visit(path.join(current, entry.name), nextRelative);
        }
        return;
      }
      if (!metadata.isFile() || (metadata.mode & 0o7777) !== FILE_MODE
        || metadata.uid !== vmail.uid || metadata.gid !== vmail.gid) throw new Error('file metadata');
      let handle;
      try {
        handle = await openFn(current, constants.O_RDONLY | constants.O_NOFOLLOW);
        const fileHash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
        let fileBytes = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          fileHash.update(buffer.subarray(0, bytesRead));
          fileBytes += bytesRead;
        }
        files += 1;
        bytes += fileBytes;
        if (!Number.isSafeInteger(bytes)) throw new Error('too large');
        updateTreeHash(hash, ['f', relative, fileBytes, fileHash.digest('hex')]);
      } finally {
        try { await handle?.close(); } catch {}
      }
    }

    try {
      await visit(root, '');
      return Object.freeze({ ok: true, contentSha256: hash.digest('hex'), files, directories, bytes });
    } catch {
      return Object.freeze({ ok: false, contentSha256: null, files: 0, directories: 0, bytes: 0 });
    }
  }

  function matchesBackup(verified, manifest) {
    return verified.ok === true
      && verified.contentSha256 === manifest.contentSha256
      && verified.files === manifest.files
      && verified.directories === manifest.directories
      && verified.bytes === manifest.bytes;
  }

  async function deleteNow({
    transactionId: rawTransactionId,
    backupId,
    scope,
    identity,
    expectedTargetSnapshotSha256,
  } = {}) {
    const tx = transactionId(rawTransactionId);
    const expectedSnapshot = snapshotSha256(expectedTargetSnapshotSha256);
    const selected = await backupManager.materializeBackup(backupId);
    if (selected.manifest.scope !== scope || selected.manifest.identity !== identity) {
      throw new MailDataDeleteError('mail_data_delete_backup_mismatch', 'Mail data backup does not match the delete target');
    }

    const target = await inspectTarget(scope, identity);
    if (target.snapshotSha256 !== expectedSnapshot || target.dataPath !== selected.manifest.sourcePath) {
      throw new MailDataDeleteError('mail_data_delete_target_stale', 'Mail data target changed after delete preview');
    }
    if (target.present !== selected.manifest.sourcePresent) {
      throw new MailDataDeleteError('mail_data_delete_backup_stale', 'Mail data presence no longer matches the selected backup');
    }

    const targetPath = selected.manifest.sourcePath;
    const parent = path.dirname(targetPath);
    const tombstone = path.join(parent, `.${path.basename(targetPath)}.delete-${tx}`);
    const existingTombstone = await pathState(tombstone);
    if (existingTombstone.present) {
      throw new MailDataDeleteError('mail_data_delete_recovery_required', 'An interrupted mail data delete requires explicit recovery');
    }

    if (!target.present) {
      return Object.freeze({
        version: 1,
        transactionId: tx,
        backupId: selected.manifest.backupId,
        scope,
        identity,
        sourcePresent: false,
        contentSha256: selected.manifest.contentSha256,
        bytes: selected.manifest.bytes,
        files: selected.manifest.files,
        directories: selected.manifest.directories,
        deleted: true,
        sideEffects: true,
      });
    }

    const vmail = await resolveVmailIdentity();
    const before = await verifyLiveTree(targetPath, vmail);
    if (!matchesBackup(before, selected.manifest)) {
      throw new MailDataDeleteError('mail_data_delete_backup_stale', 'Live mail data does not match the selected verified backup');
    }

    let renamed = false;
    try {
      await renameFn(targetPath, tombstone);
      renamed = true;
      const targetAfterRename = await pathState(targetPath);
      if (targetAfterRename.present) {
        throw new MailDataDeleteError('mail_data_delete_activation_failed', 'Mail data target remained visible after delete activation');
      }
      const quarantined = await verifyLiveTree(tombstone, vmail);
      if (!matchesBackup(quarantined, selected.manifest)) {
        throw new MailDataDeleteError('mail_data_delete_activation_drift', 'Mail data changed during delete activation');
      }
      await rmFn(tombstone, { recursive: true, force: false });
      renamed = false;
      const [finalTarget, finalTombstone] = await Promise.all([
        pathState(targetPath),
        pathState(tombstone),
      ]);
      if (finalTarget.present || finalTombstone.present) {
        throw new MailDataDeleteError('mail_data_delete_incomplete', 'Mail data delete did not reach a clean final state');
      }
      return Object.freeze({
        version: 1,
        transactionId: tx,
        backupId: selected.manifest.backupId,
        scope,
        identity,
        sourcePresent: true,
        contentSha256: selected.manifest.contentSha256,
        bytes: selected.manifest.bytes,
        files: selected.manifest.files,
        directories: selected.manifest.directories,
        deleted: true,
        sideEffects: true,
      });
    } catch (error) {
      if (renamed) {
        const [targetState, tombstoneState] = await Promise.all([
          pathState(targetPath),
          pathState(tombstone),
        ]);
        if (!targetState.present && tombstoneState.present) {
          const rollbackEvidence = await verifyLiveTree(tombstone, vmail);
          if (matchesBackup(rollbackEvidence, selected.manifest)) {
            try {
              await renameFn(tombstone, targetPath);
              renamed = false;
            } catch {
              throw new MailDataDeleteError('mail_data_delete_rollback_failed', 'Mail data delete failed and rollback could not restore the live path');
            }
          }
        }
      }
      if (error instanceof MailDataDeleteError) throw error;
      throw new MailDataDeleteError('mail_data_delete_failed', 'Mail data delete failed; restore from the verified backup if recovery is required');
    }
  }

  function deleteData(input) {
    const runDelete = mutation.catch(() => {}).then(() => deleteNow(input));
    mutation = runDelete;
    return runDelete;
  }

  async function inspectDeleted({ transactionId: rawTransactionId, backupId, scope, identity } = {}) {
    const tx = transactionId(rawTransactionId);
    const selected = await backupManager.materializeBackup(backupId);
    if (selected.manifest.scope !== scope || selected.manifest.identity !== identity) {
      return Object.freeze({ satisfied: false, result: null });
    }
    const targetPath = selected.manifest.sourcePath;
    const tombstone = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.delete-${tx}`);
    let target;
    let pending;
    try {
      [target, pending] = await Promise.all([pathState(targetPath), pathState(tombstone)]);
    } catch {
      return Object.freeze({ satisfied: false, result: null });
    }
    if (target.present || pending.present) return Object.freeze({ satisfied: false, result: null });
    return Object.freeze({
      satisfied: true,
      result: Object.freeze({
        version: 1,
        transactionId: tx,
        backupId: selected.manifest.backupId,
        scope,
        identity,
        sourcePresent: selected.manifest.sourcePresent,
        contentSha256: selected.manifest.contentSha256,
        bytes: selected.manifest.bytes,
        files: selected.manifest.files,
        directories: selected.manifest.directories,
        deleted: true,
        sideEffects: true,
      }),
    });
  }

  return Object.freeze({ deleteData, inspectDeleted });
}

export const mailDataDeleteInternals = Object.freeze({
  getentPath: GETENT,
  directoryMode: DIRECTORY_MODE,
  fileMode: FILE_MODE,
  maxOutput: MAX_OUTPUT,
  copyBufferBytes: COPY_BUFFER_BYTES,
  transactionId,
  snapshotSha256,
  compareEntryNames,
});