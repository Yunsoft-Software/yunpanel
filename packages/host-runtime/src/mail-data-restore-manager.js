import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { mailDataTemplatePolicy } from '@yunpanel/config-templates';
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

export class MailDataRestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDataRestoreError';
    this.code = code;
  }
}

function transactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_ID_PATTERN.test(value)) {
    throw new MailDataRestoreError('mail_data_restore_transaction_invalid', 'Mail data restore transaction id is invalid');
  }
  return value;
}

function snapshotSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new MailDataRestoreError('mail_data_restore_snapshot_invalid', 'Mail data restore target snapshot is invalid');
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

export function createMailDataRestoreManager({
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
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  mkdirFn = mkdir,
  openFn = open,
  readdirFn = readdir,
  renameFn = rename,
  rmFn = rm,
  rmdirFn = rmdir,
} = {}) {
  if (!backupManager || typeof backupManager.backup !== 'function'
    || typeof backupManager.materializeBackup !== 'function') {
    throw new MailDataRestoreError('mail_data_restore_backup_manager_invalid', 'Mail data backup manager is unavailable');
  }
  if (!mailDataInspector || typeof mailDataInspector.inspectMailbox !== 'function'
    || typeof mailDataInspector.inspectDomain !== 'function') {
    throw new MailDataRestoreError('mail_data_restore_inspector_invalid', 'Mail data inspector is unavailable');
  }
  if (typeof run !== 'function') {
    throw new MailDataRestoreError('mail_data_restore_runtime_invalid', 'Mail data restore runtime is unavailable');
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
      throw new MailDataRestoreError('mail_data_restore_vmail_unavailable', 'Managed vmail identity could not be resolved safely');
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

  async function assertDirectory(targetPath) {
    const state = await pathState(targetPath);
    if (!state.present || !state.metadata.isDirectory() || state.metadata.isSymbolicLink()) {
      throw new MailDataRestoreError('mail_data_restore_parent_unsafe', 'Mail data restore parent is unavailable or unsafe');
    }
    return state.metadata;
  }

  async function ensureManagedParent(targetPath, vmail, created) {
    const root = mailDataTemplatePolicy.root;
    const rootParent = path.dirname(root);
    await assertDirectory(rootParent);

    const required = [root];
    const targetParent = path.dirname(targetPath);
    if (targetParent !== root) required.push(targetParent);
    for (const directoryPath of required) {
      const state = await pathState(directoryPath);
      if (!state.present) {
        await mkdirFn(directoryPath, { mode: DIRECTORY_MODE });
        created.push(directoryPath);
        await chownFn(directoryPath, vmail.uid, vmail.gid);
        await chmodFn(directoryPath, DIRECTORY_MODE);
      }
      const metadata = await assertDirectory(directoryPath);
      if ((metadata.mode & 0o7777) !== DIRECTORY_MODE || metadata.uid !== vmail.uid || metadata.gid !== vmail.gid) {
        throw new MailDataRestoreError('mail_data_restore_parent_unsafe', 'Mail data restore parent ownership or mode is unsafe');
      }
    }
  }

  async function copyBackupFile(sourcePath, destinationPath, vmail) {
    let source;
    let destination;
    try {
      source = await openFn(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const sourceMetadata = await source.stat();
      if (!sourceMetadata.isFile()) throw new Error('backup source is not a file');
      destination = await openFn(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let bytes = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(chunk, written, bytesRead - written, null);
          if (result.bytesWritten < 1) throw new Error('short write');
          written += result.bytesWritten;
        }
        bytes += bytesRead;
        if (!Number.isSafeInteger(bytes)) throw new Error('file too large');
      }
      await destination.sync();
      await destination.chown(vmail.uid, vmail.gid);
      await destination.chmod(FILE_MODE);
      if (bytes !== sourceMetadata.size) throw new Error('backup source changed');
      return Object.freeze({ bytes, sha256: hash.digest('hex') });
    } catch {
      throw new MailDataRestoreError('mail_data_restore_copy_failed', 'Mail data backup could not be materialized safely');
    } finally {
      try { await destination?.close(); } catch {}
      try { await source?.close(); } catch {}
    }
  }

  async function materializeTree(sourceRoot, destinationRoot, vmail) {
    const hash = createHash('sha256');
    let files = 0;
    let directories = 0;
    let bytes = 0;

    async function visit(sourcePath, destinationPath, relative) {
      const metadata = await lstatFn(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw new MailDataRestoreError('mail_data_restore_backup_unsafe', 'Mail data backup contains a symbolic link');
      }
      if (metadata.isDirectory()) {
        if (relative) directories += 1;
        await mkdirFn(destinationPath, { mode: DIRECTORY_MODE });
        await chownFn(destinationPath, vmail.uid, vmail.gid);
        await chmodFn(destinationPath, DIRECTORY_MODE);
        updateTreeHash(hash, ['d', relative]);
        const entries = await readdirFn(sourcePath, { withFileTypes: true });
        entries.sort(compareEntryNames);
        for (const entry of entries) {
          const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
          await visit(path.join(sourcePath, entry.name), path.join(destinationPath, entry.name), nextRelative);
        }
        return;
      }
      if (!metadata.isFile()) {
        throw new MailDataRestoreError('mail_data_restore_backup_unsafe', 'Mail data backup contains an unsupported file type');
      }
      const copied = await copyBackupFile(sourcePath, destinationPath, vmail);
      files += 1;
      bytes += copied.bytes;
      if (!Number.isSafeInteger(bytes)) {
        throw new MailDataRestoreError('mail_data_restore_too_large', 'Mail data restore exceeds the supported size');
      }
      updateTreeHash(hash, ['f', relative, copied.bytes, copied.sha256]);
    }

    await visit(sourceRoot, destinationRoot, '');
    return Object.freeze({ contentSha256: hash.digest('hex'), files, directories, bytes });
  }

  async function verifyLiveTree(targetPath, vmail) {
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
        updateTreeHash(hash, ['f', relative, fileBytes, fileHash.digest('hex')]);
      } finally {
        try { await handle?.close(); } catch {}
      }
    }

    try {
      await visit(targetPath, '');
      return Object.freeze({ ok: true, contentSha256: hash.digest('hex'), files, directories, bytes });
    } catch {
      return Object.freeze({ ok: false, contentSha256: null, files: 0, directories: 0, bytes: 0 });
    }
  }

  async function rollbackSwap(targetPath, previousPath, targetPreviouslyPresent) {
    try { await rmFn(targetPath, { recursive: true, force: true }); }
    catch { throw new MailDataRestoreError('mail_data_restore_rollback_failed', 'Restored mail data could not be removed during rollback'); }
    if (targetPreviouslyPresent) {
      try { await renameFn(previousPath, targetPath); }
      catch { throw new MailDataRestoreError('mail_data_restore_rollback_failed', 'Previous mail data could not be restored after failure'); }
    }
  }

  async function cleanupCreatedParents(created) {
    for (const directoryPath of [...created].reverse()) {
      try { await rmdirFn(directoryPath); }
      catch (error) {
        if (!missing(error) && error?.code !== 'ENOTEMPTY') {
          throw new MailDataRestoreError('mail_data_restore_cleanup_failed', 'Empty restore parent could not be cleaned up');
        }
      }
    }
  }

  async function restoreNow({
    transactionId: rawTransactionId,
    backupId,
    scope,
    identity,
    expectedTargetSnapshotSha256,
  } = {}) {
    const tx = transactionId(rawTransactionId);
    const expectedTargetSnapshot = snapshotSha256(expectedTargetSnapshotSha256);
    const selected = await backupManager.materializeBackup(backupId);
    if (selected.manifest.scope !== scope || selected.manifest.identity !== identity) {
      throw new MailDataRestoreError('mail_data_restore_backup_mismatch', 'Mail data backup does not match the requested restore target');
    }
    if (!selected.manifest.sourcePresent) {
      throw new MailDataRestoreError('mail_data_restore_backup_empty', 'Mail data backup does not contain restorable data');
    }

    const target = await inspectTarget(scope, identity);
    if (target.snapshotSha256 !== expectedTargetSnapshot || target.dataPath !== selected.manifest.sourcePath) {
      throw new MailDataRestoreError('mail_data_restore_target_stale', 'Mail data target changed after restore preview');
    }

    const vmail = await resolveVmailIdentity();
    const preRestoreBackupId = `pre-restore:${tx}`;
    const preRestore = await backupManager.backup({
      backupId: preRestoreBackupId,
      scope,
      identity,
      expectedSnapshotSha256: expectedTargetSnapshot,
    });

    const targetPath = selected.manifest.sourcePath;
    const parentPath = path.dirname(targetPath);
    const baseName = path.basename(targetPath);
    const stagePath = path.join(parentPath, `.${baseName}.restore-${tx}`);
    const previousPath = path.join(parentPath, `.${baseName}.previous-${tx}`);
    const previousState = await pathState(previousPath);
    if (previousState.present) {
      throw new MailDataRestoreError('mail_data_restore_recovery_required', 'An interrupted mail data restore requires explicit recovery');
    }

    const createdParents = [];
    await ensureManagedParent(targetPath, vmail, createdParents);
    const stageState = await pathState(stagePath);
    if (stageState.present) await rmFn(stagePath, { recursive: true, force: true });

    let mutationStarted = false;
    const targetPreviouslyPresent = target.present;
    try {
      const staged = await materializeTree(selected.dataPath, stagePath, vmail);
      if (staged.contentSha256 !== selected.manifest.contentSha256
        || staged.files !== selected.manifest.files || staged.directories !== selected.manifest.directories
        || staged.bytes !== selected.manifest.bytes) {
        throw new MailDataRestoreError('mail_data_restore_stage_mismatch', 'Staged mail data does not match the selected backup');
      }
      const liveBeforeMutation = await inspectTarget(scope, identity);
      if (liveBeforeMutation.snapshotSha256 !== expectedTargetSnapshot || liveBeforeMutation.present !== targetPreviouslyPresent) {
        throw new MailDataRestoreError('mail_data_restore_target_stale', 'Mail data target changed before restore activation');
      }

      if (targetPreviouslyPresent) {
        await renameFn(targetPath, previousPath);
        mutationStarted = true;
      }
      await renameFn(stagePath, targetPath);
      mutationStarted = true;

      const verified = await verifyLiveTree(targetPath, vmail);
      if (!verified.ok || verified.contentSha256 !== selected.manifest.contentSha256
        || verified.files !== selected.manifest.files || verified.directories !== selected.manifest.directories
        || verified.bytes !== selected.manifest.bytes) {
        throw new MailDataRestoreError('mail_data_restore_verification_failed', 'Restored mail data did not pass verification');
      }
      if (targetPreviouslyPresent) await rmFn(previousPath, { recursive: true, force: true });
      return Object.freeze({
        version: 1,
        transactionId: tx,
        backupId: selected.manifest.backupId,
        preRestoreBackupId,
        scope,
        identity,
        contentSha256: selected.manifest.contentSha256,
        bytes: selected.manifest.bytes,
        files: selected.manifest.files,
        directories: selected.manifest.directories,
        restoredPresent: true,
        applied: true,
        sideEffects: true,
      });
    } catch (error) {
      try { await rmFn(stagePath, { recursive: true, force: true }); } catch {}
      if (mutationStarted) {
        try { await rollbackSwap(targetPath, previousPath, targetPreviouslyPresent); }
        catch (rollbackError) { throw rollbackError; }
      }
      try { await cleanupCreatedParents(createdParents); } catch (cleanupError) {
        if (error instanceof MailDataRestoreError) throw cleanupError;
      }
      if (error instanceof MailDataRestoreError) throw error;
      throw new MailDataRestoreError('mail_data_restore_failed', 'Mail data restore failed and the previous state was restored');
    }
  }

  function restore(input) {
    const runRestore = mutation.catch(() => {}).then(() => restoreNow(input));
    mutation = runRestore;
    return runRestore;
  }

  async function inspectRestored({ backupId, scope, identity } = {}) {
    const selected = await backupManager.materializeBackup(backupId);
    if (selected.manifest.scope !== scope || selected.manifest.identity !== identity || !selected.manifest.sourcePresent) {
      return Object.freeze({ satisfied: false, result: null });
    }
    const vmail = await resolveVmailIdentity();
    const verified = await verifyLiveTree(selected.manifest.sourcePath, vmail);
    if (!verified.ok || verified.contentSha256 !== selected.manifest.contentSha256
      || verified.files !== selected.manifest.files || verified.directories !== selected.manifest.directories
      || verified.bytes !== selected.manifest.bytes) {
      return Object.freeze({ satisfied: false, result: null });
    }
    return Object.freeze({
      satisfied: true,
      result: Object.freeze({
        version: 1,
        backupId: selected.manifest.backupId,
        scope,
        identity,
        contentSha256: selected.manifest.contentSha256,
        bytes: selected.manifest.bytes,
        files: selected.manifest.files,
        directories: selected.manifest.directories,
        restoredPresent: true,
        applied: true,
        sideEffects: true,
      }),
    });
  }

  return Object.freeze({ restore, inspectRestored });
}

export const mailDataRestoreInternals = Object.freeze({
  getentPath: GETENT,
  directoryMode: DIRECTORY_MODE,
  fileMode: FILE_MODE,
  maxOutput: MAX_OUTPUT,
  copyBufferBytes: COPY_BUFFER_BYTES,
  transactionId,
  snapshotSha256,
  compareEntryNames,
});
