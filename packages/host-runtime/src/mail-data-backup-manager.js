import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  mailDomainDataPath,
  mailboxDataPath,
} from '@yunpanel/config-templates';
import { createMailDataInspector } from './mail-data-inspector.js';

const DEFAULT_BACKUP_ROOT = '/var/lib/yunpanel/backups/mail-data';
const MANIFEST_FILE = 'manifest.json';
const DATA_DIRECTORY = 'data';
const MANIFEST_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COPY_BUFFER_BYTES = 128 * 1024;

export class MailDataBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDataBackupError';
    this.code = code;
  }
}

function backupId(value) {
  if (typeof value !== 'string' || !BACKUP_ID_PATTERN.test(value)) {
    throw new MailDataBackupError('mail_data_backup_id_invalid', 'Mail data backup id is invalid');
  }
  return value;
}

function snapshotSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new MailDataBackupError('mail_data_backup_snapshot_invalid', 'Expected mail data snapshot digest is invalid');
  }
  return value;
}

function backupIdentity({ scope, identity } = {}) {
  if (scope === 'mailbox') return Object.freeze({ scope, identity, sourcePath: mailboxDataPath(identity) });
  if (scope === 'domain') return Object.freeze({ scope, identity, sourcePath: mailDomainDataPath(identity) });
  throw new MailDataBackupError('mail_data_backup_scope_invalid', 'Mail data backup scope is invalid');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableMetadata(metadata) {
  return Object.freeze({
    size: metadata.size,
    mode: metadata.mode & 0o7777,
    uid: metadata.uid,
    gid: metadata.gid,
    dev: metadata.dev,
    ino: metadata.ino,
    mtimeMs: metadata.mtimeMs,
  });
}

function sameMetadata(left, right) {
  return left.size === right.size && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
    && left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

function updateTreeHash(hash, tuple) {
  hash.update(`${JSON.stringify(tuple)}\n`);
}

function publicManifest(manifest) {
  return Object.freeze({
    version: manifest.version,
    backupId: manifest.backupId,
    scope: manifest.scope,
    identity: manifest.identity,
    sourcePath: manifest.sourcePath,
    sourcePresent: manifest.sourcePresent,
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    sourceFingerprintSha256: manifest.sourceFingerprintSha256,
    contentSha256: manifest.contentSha256,
    bytes: manifest.bytes,
    files: manifest.files,
    directories: manifest.directories,
    createdAt: manifest.createdAt,
    sideEffects: true,
  });
}

function normalizeManifest(value, expectedBackupId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== MANIFEST_VERSION
    || typeof value.backupId !== 'string' || !BACKUP_ID_PATTERN.test(value.backupId)
    || (expectedBackupId !== null && value.backupId !== expectedBackupId)
    || !['mailbox', 'domain'].includes(value.scope) || typeof value.identity !== 'string' || !value.identity
    || typeof value.sourcePath !== 'string' || !path.isAbsolute(value.sourcePath)
    || typeof value.sourcePresent !== 'boolean'
    || typeof value.sourceSnapshotSha256 !== 'string' || !SHA256_PATTERN.test(value.sourceSnapshotSha256)
    || typeof value.sourceFingerprintSha256 !== 'string' || !SHA256_PATTERN.test(value.sourceFingerprintSha256)
    || typeof value.contentSha256 !== 'string' || !SHA256_PATTERN.test(value.contentSha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0
    || !Number.isSafeInteger(value.files) || value.files < 0
    || !Number.isSafeInteger(value.directories) || value.directories < 0
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    throw new MailDataBackupError('mail_data_backup_manifest_invalid', 'Mail data backup manifest is invalid');
  }
  const expected = backupIdentity({ scope: value.scope, identity: value.identity });
  if (expected.sourcePath !== value.sourcePath) {
    throw new MailDataBackupError('mail_data_backup_manifest_invalid', 'Mail data backup source path is inconsistent');
  }
  if (!value.sourcePresent && (value.bytes !== 0 || value.files !== 0 || value.directories !== 0)) {
    throw new MailDataBackupError('mail_data_backup_manifest_invalid', 'Absent mail data backup metadata is inconsistent');
  }
  return Object.freeze({ ...value });
}

export function createMailDataBackupManager({
  backupRoot = DEFAULT_BACKUP_ROOT,
  mailDataInspector = createMailDataInspector(),
  now = () => Date.now(),
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  openFn = open,
  readFileFn = readFile,
  readdirFn = readdir,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (typeof backupRoot !== 'string' || !path.isAbsolute(backupRoot) || path.normalize(backupRoot) !== backupRoot) {
    throw new MailDataBackupError('mail_data_backup_root_invalid', 'Mail data backup root must be an absolute normalized path');
  }
  if (!mailDataInspector || typeof mailDataInspector.inspectMailbox !== 'function'
    || typeof mailDataInspector.inspectDomain !== 'function') {
    throw new MailDataBackupError('mail_data_backup_inspector_invalid', 'Mail data inspector is unavailable');
  }
  let mutation = Promise.resolve();

  function finalDirectory(id) {
    return path.join(backupRoot, backupId(id));
  }

  function pendingDirectory(id) {
    return path.join(backupRoot, `.pending-${backupId(id)}`);
  }

  async function ensurePrivateDirectory(targetPath) {
    await mkdirFn(targetPath, { recursive: true, mode: DIRECTORY_MODE });
    await chmodFn(targetPath, DIRECTORY_MODE);
    const metadata = await lstatFn(targetPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== DIRECTORY_MODE) {
      throw new MailDataBackupError('mail_data_backup_directory_unsafe', 'Mail data backup directory is unsafe');
    }
  }

  async function sourceTreeFingerprint(root) {
    const hash = createHash('sha256');
    let files = 0;
    let directories = 0;
    let bytes = 0;

    async function visit(current, relative) {
      const metadata = await lstatFn(current);
      if (metadata.isSymbolicLink()) {
        throw new MailDataBackupError('mail_data_backup_source_unsafe', 'Mail data source contains a symbolic link');
      }
      if (metadata.isDirectory()) {
        directories += 1;
        updateTreeHash(hash, ['d', relative, stableMetadata(metadata)]);
        const entries = await readdirFn(current, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
          await visit(path.join(current, entry.name), nextRelative);
        }
        return;
      }
      if (!metadata.isFile()) {
        throw new MailDataBackupError('mail_data_backup_source_unsafe', 'Mail data source contains an unsupported file type');
      }
      files += 1;
      bytes += metadata.size;
      if (!Number.isSafeInteger(bytes)) {
        throw new MailDataBackupError('mail_data_backup_too_large', 'Mail data backup size exceeds the supported range');
      }
      updateTreeHash(hash, ['f', relative, stableMetadata(metadata)]);
    }

    await visit(root, '');
    return Object.freeze({ sha256: hash.digest('hex'), files, directories, bytes });
  }

  async function copyRegularFile(sourcePath, destinationPath) {
    let source;
    let destination;
    try {
      source = await openFn(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const beforeStat = await source.stat();
      if (!beforeStat.isFile()) throw new MailDataBackupError('mail_data_backup_source_unsafe', 'Mail data source changed file type during backup');
      const before = stableMetadata(beforeStat);
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
        if (!Number.isSafeInteger(bytes)) throw new MailDataBackupError('mail_data_backup_too_large', 'Mail data backup file exceeds the supported range');
      }
      await destination.sync();
      await destination.chmod(FILE_MODE);
      const after = stableMetadata(await source.stat());
      if (!sameMetadata(before, after) || bytes !== before.size) {
        throw new MailDataBackupError('mail_data_backup_source_changed', 'Mail data changed while the backup was being created');
      }
      return Object.freeze({ bytes, sha256: hash.digest('hex') });
    } catch (error) {
      if (error instanceof MailDataBackupError) throw error;
      throw new MailDataBackupError('mail_data_backup_copy_failed', 'Mail data file could not be copied safely');
    } finally {
      try { await destination?.close(); } catch {}
      try { await source?.close(); } catch {}
    }
  }

  async function copyTree(sourceRoot, destinationRoot) {
    const hash = createHash('sha256');
    let files = 0;
    let directories = 0;
    let bytes = 0;

    async function visit(sourcePath, destinationPath, relative) {
      const metadata = await lstatFn(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw new MailDataBackupError('mail_data_backup_source_unsafe', 'Mail data source contains a symbolic link');
      }
      if (metadata.isDirectory()) {
        directories += 1;
        await mkdirFn(destinationPath, { mode: DIRECTORY_MODE });
        await chmodFn(destinationPath, DIRECTORY_MODE);
        updateTreeHash(hash, ['d', relative]);
        const entries = await readdirFn(sourcePath, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
          await visit(
            path.join(sourcePath, entry.name),
            path.join(destinationPath, entry.name),
            nextRelative,
          );
        }
        return;
      }
      if (!metadata.isFile()) {
        throw new MailDataBackupError('mail_data_backup_source_unsafe', 'Mail data source contains an unsupported file type');
      }
      const copied = await copyRegularFile(sourcePath, destinationPath);
      files += 1;
      bytes += copied.bytes;
      if (!Number.isSafeInteger(bytes)) {
        throw new MailDataBackupError('mail_data_backup_too_large', 'Mail data backup size exceeds the supported range');
      }
      updateTreeHash(hash, ['f', relative, copied.bytes, copied.sha256]);
    }

    await visit(sourceRoot, destinationRoot, '');
    return Object.freeze({ contentSha256: hash.digest('hex'), files, directories, bytes });
  }

  async function verifyBackupTree(root) {
    const hash = createHash('sha256');
    let files = 0;
    let directories = 0;
    let bytes = 0;

    async function visit(current, relative) {
      const metadata = await lstatFn(current);
      if (metadata.isSymbolicLink()) throw new MailDataBackupError('mail_data_backup_corrupt', 'Mail data backup contains a symbolic link');
      if (metadata.isDirectory()) {
        if ((metadata.mode & 0o777) !== DIRECTORY_MODE) throw new MailDataBackupError('mail_data_backup_corrupt', 'Mail data backup directory mode is invalid');
        directories += 1;
        updateTreeHash(hash, ['d', relative]);
        const entries = await readdirFn(current, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
          await visit(path.join(current, entry.name), nextRelative);
        }
        return;
      }
      if (!metadata.isFile() || (metadata.mode & 0o777) !== FILE_MODE) {
        throw new MailDataBackupError('mail_data_backup_corrupt', 'Mail data backup contains an unsafe file');
      }
      const handle = await openFn(current, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
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
        await handle.close();
      }
    }

    await visit(root, '');
    return Object.freeze({ contentSha256: hash.digest('hex'), files, directories, bytes });
  }

  async function loadManifest(id) {
    const normalizedId = backupId(id);
    const directory = finalDirectory(normalizedId);
    try {
      const metadata = await lstatFn(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== DIRECTORY_MODE) {
        throw new MailDataBackupError('mail_data_backup_corrupt', 'Mail data backup directory is unsafe');
      }
      const manifestPath = path.join(directory, MANIFEST_FILE);
      const manifestMetadata = await lstatFn(manifestPath);
      if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || (manifestMetadata.mode & 0o777) !== FILE_MODE) {
        throw new MailDataBackupError('mail_data_backup_corrupt', 'Mail data backup manifest is unsafe');
      }
      const manifest = normalizeManifest(JSON.parse(await readFileFn(manifestPath, 'utf8')), normalizedId);
      const dataPath = path.join(directory, DATA_DIRECTORY);
      const verified = await verifyBackupTree(dataPath);
      if (verified.contentSha256 !== manifest.contentSha256 || verified.files !== manifest.files
        || verified.directories !== manifest.directories || verified.bytes !== manifest.bytes) {
        throw new MailDataBackupError('mail_data_backup_corrupt', 'Mail data backup content does not match its manifest');
      }
      return Object.freeze({ manifest, directory, dataPath });
    } catch (error) {
      if (error instanceof MailDataBackupError) throw error;
      if (error?.code === 'ENOENT') return null;
      throw new MailDataBackupError('mail_data_backup_read_failed', 'Mail data backup could not be read');
    }
  }

  async function backupNow({ backupId: rawBackupId, scope, identity, expectedSnapshotSha256 } = {}) {
    const id = backupId(rawBackupId);
    const expectedSnapshot = snapshotSha256(expectedSnapshotSha256);
    const target = backupIdentity({ scope, identity });
    const existing = await loadManifest(id);
    if (existing) {
      if (existing.manifest.scope !== target.scope || existing.manifest.identity !== target.identity
        || existing.manifest.sourceSnapshotSha256 !== expectedSnapshot) {
        throw new MailDataBackupError('mail_data_backup_id_conflict', 'Mail data backup id belongs to different source state');
      }
      return publicManifest(existing.manifest);
    }

    const inspected = target.scope === 'mailbox'
      ? await mailDataInspector.inspectMailbox(target.identity)
      : await mailDataInspector.inspectDomain(target.identity);
    if (inspected.snapshotSha256 !== expectedSnapshot || inspected.dataPath !== target.sourcePath) {
      throw new MailDataBackupError('mail_data_backup_snapshot_stale', 'Mail data changed after backup preview');
    }

    await ensurePrivateDirectory(backupRoot);
    const pending = pendingDirectory(id);
    await rmFn(pending, { recursive: true, force: true });
    await mkdirFn(pending, { mode: DIRECTORY_MODE });
    await chmodFn(pending, DIRECTORY_MODE);
    const dataPath = path.join(pending, DATA_DIRECTORY);

    try {
      let sourceFingerprint = Object.freeze({ sha256: sha256('absent'), files: 0, directories: 0, bytes: 0 });
      let copied = Object.freeze({ contentSha256: sha256('empty'), files: 0, directories: 0, bytes: 0 });
      if (inspected.present) {
        const before = await sourceTreeFingerprint(target.sourcePath);
        copied = await copyTree(target.sourcePath, dataPath);
        const after = await sourceTreeFingerprint(target.sourcePath);
        if (before.sha256 !== after.sha256 || before.files !== after.files
          || before.directories !== after.directories || before.bytes !== after.bytes) {
          throw new MailDataBackupError('mail_data_backup_source_changed', 'Mail data changed while the backup was being created');
        }
        sourceFingerprint = before;
        const verified = await verifyBackupTree(dataPath);
        if (verified.contentSha256 !== copied.contentSha256 || verified.files !== copied.files
          || verified.directories !== copied.directories || verified.bytes !== copied.bytes) {
          throw new MailDataBackupError('mail_data_backup_verification_failed', 'Mail data backup verification failed');
        }
      } else {
        await mkdirFn(dataPath, { mode: DIRECTORY_MODE });
        await chmodFn(dataPath, DIRECTORY_MODE);
        const verified = await verifyBackupTree(dataPath);
        copied = verified;
      }
      const manifest = Object.freeze({
        version: MANIFEST_VERSION,
        backupId: id,
        scope: target.scope,
        identity: target.identity,
        sourcePath: target.sourcePath,
        sourcePresent: inspected.present,
        sourceSnapshotSha256: expectedSnapshot,
        sourceFingerprintSha256: sourceFingerprint.sha256,
        contentSha256: copied.contentSha256,
        bytes: copied.bytes,
        files: copied.files,
        directories: copied.directories,
        createdAt: new Date(now()).toISOString(),
      });
      await writeFileFn(path.join(pending, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: FILE_MODE });
      await chmodFn(path.join(pending, MANIFEST_FILE), FILE_MODE);
      await renameFn(pending, finalDirectory(id));
      return publicManifest(manifest);
    } catch (error) {
      try { await rmFn(pending, { recursive: true, force: true }); } catch {}
      if (error instanceof MailDataBackupError) throw error;
      throw new MailDataBackupError('mail_data_backup_failed', 'Mail data backup could not be created');
    }
  }

  function backup(input) {
    const run = mutation.catch(() => {}).then(() => backupNow(input));
    mutation = run;
    return run;
  }

  async function inspectBackup(id) {
    const loaded = await loadManifest(id);
    if (!loaded) return null;
    return publicManifest(loaded.manifest);
  }

  return Object.freeze({ backup, inspectBackup, finalDirectory });
}

export const mailDataBackupInternals = Object.freeze({
  defaultBackupRoot: DEFAULT_BACKUP_ROOT,
  manifestFile: MANIFEST_FILE,
  dataDirectory: DATA_DIRECTORY,
  manifestVersion: MANIFEST_VERSION,
  directoryMode: DIRECTORY_MODE,
  fileMode: FILE_MODE,
  copyBufferBytes: COPY_BUFFER_BYTES,
  backupIdentity,
  normalizeManifest,
  stableMetadata,
  sameMetadata,
});
