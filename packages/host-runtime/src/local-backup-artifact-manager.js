import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/backups/resources';
const TAR_PATHS = Object.freeze(['/usr/bin/tar', '/bin/tar']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INLINE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_INLINE_FILES = 16;
const MAX_INLINE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 32;
const RECEIPT_KEYS = new Set(['version', 'artifactId', 'sourceDigest', 'contentSha256', 'bytes', 'createdAt']);

export class LocalBackupArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalBackupArtifactError';
    this.code = code;
  }
}

function digestId(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new LocalBackupArtifactError('backup_artifact_identity_invalid', `${field} is invalid`);
  }
  return value;
}

function safeRelativeName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
    || path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value === '.') return true;
  const segments = value.split(/[\\/]/);
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function normalizeEntries(value) {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw new LocalBackupArtifactError('backup_artifact_entries_invalid', 'Backup artifact entries are invalid');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || typeof entry.directory !== 'string' || !path.isAbsolute(entry.directory)
      || !safeRelativeName(entry.name)) {
      throw new LocalBackupArtifactError('backup_artifact_entries_invalid', 'Backup artifact entry is invalid');
    }
    return Object.freeze({ directory: path.resolve(entry.directory), name: entry.name });
  });
}

function normalizeInlineFiles(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_INLINE_FILES) {
    throw new LocalBackupArtifactError('backup_artifact_inline_invalid', 'Backup artifact inline files are invalid');
  }
  let total = 0;
  const seen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || typeof entry.name !== 'string' || !INLINE_NAME_PATTERN.test(entry.name) || seen.has(entry.name)
      || typeof entry.content !== 'string' || entry.content.includes('\u0000')) {
      throw new LocalBackupArtifactError('backup_artifact_inline_invalid', 'Backup artifact inline file is invalid');
    }
    const bytes = Buffer.byteLength(entry.content);
    total += bytes;
    if (total > MAX_INLINE_BYTES) {
      throw new LocalBackupArtifactError('backup_artifact_inline_invalid', 'Backup artifact inline files are too large');
    }
    seen.add(entry.name);
    return Object.freeze({ name: entry.name, content: entry.content });
  });
}

function normalizeReceipt(value, artifactId, sourceDigest) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== RECEIPT_KEYS.size
    || Object.keys(value).some((key) => !RECEIPT_KEYS.has(key))
    || value.version !== STORE_VERSION
    || value.artifactId !== artifactId || value.sourceDigest !== sourceDigest
    || typeof value.contentSha256 !== 'string' || !SHA256_PATTERN.test(value.contentSha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new LocalBackupArtifactError('backup_artifact_receipt_invalid', 'Backup artifact receipt is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    artifactId,
    sourceDigest,
    contentSha256: value.contentSha256,
    bytes: value.bytes,
    createdAt: new Date(value.createdAt).toISOString(),
  });
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.once('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function findTar(accessFn) {
  for (const candidate of TAR_PATHS) {
    try { await accessFn(candidate); return candidate; }
    catch { /* Continue fixed allowlist. */ }
  }
  return null;
}

function defaultRunTar(file, args) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 60 * 60 * 1000,
    maxBuffer: 64 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    windowsHide: true,
  });
}

export function createLocalBackupArtifactManager({
  root = DEFAULT_ROOT,
  accessFn = access,
  runTar = defaultRunTar,
  lstatFn = lstat,
  now = () => Date.now(),
  randomSuffix = () => randomBytes(8).toString('hex'),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)
    || typeof accessFn !== 'function' || typeof runTar !== 'function'
    || typeof lstatFn !== 'function' || typeof now !== 'function' || typeof randomSuffix !== 'function') {
    throw new LocalBackupArtifactError('backup_artifact_dependencies_invalid', 'Local backup artifact dependencies are invalid');
  }

  function artifactPaths(artifactId) {
    const id = digestId(artifactId, 'artifactId');
    return Object.freeze({
      archive: path.join(root, `${id}.tar`),
      receipt: path.join(root, `${id}.json`),
    });
  }

  async function inspectExisting(artifactId, sourceDigest) {
    const paths = artifactPaths(artifactId);
    let receiptRaw;
    try { receiptRaw = await readFile(paths.receipt, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new LocalBackupArtifactError('backup_artifact_read_failed', 'Backup artifact receipt could not be read');
    }
    let receipt;
    try { receipt = normalizeReceipt(JSON.parse(receiptRaw), artifactId, sourceDigest); }
    catch (error) {
      if (error instanceof LocalBackupArtifactError) throw error;
      throw new LocalBackupArtifactError('backup_artifact_receipt_invalid', 'Backup artifact receipt is invalid');
    }
    let info;
    try { info = await stat(paths.archive); }
    catch {
      throw new LocalBackupArtifactError('backup_artifact_incomplete', 'Backup artifact archive is missing');
    }
    if (!info.isFile() || info.size !== receipt.bytes) {
      throw new LocalBackupArtifactError('backup_artifact_incomplete', 'Backup artifact archive metadata is inconsistent');
    }
    const sha = await sha256File(paths.archive).catch(() => null);
    if (sha !== receipt.contentSha256) {
      throw new LocalBackupArtifactError('backup_artifact_checksum_mismatch', 'Backup artifact checksum verification failed');
    }
    return Object.freeze({
      artifactId,
      contentSha256: receipt.contentSha256,
      bytes: receipt.bytes,
      createdAt: receipt.createdAt,
    });
  }

  async function archive({ artifactId, sourceDigest, entries = [], inlineFiles = [] } = {}) {
    const id = digestId(artifactId, 'artifactId');
    const source = digestId(sourceDigest, 'sourceDigest');
    const normalizedEntries = normalizeEntries(entries);
    const normalizedInline = normalizeInlineFiles(inlineFiles);
    if (normalizedEntries.length === 0 && normalizedInline.length === 0) {
      throw new LocalBackupArtifactError('backup_artifact_empty', 'Backup artifact does not contain any source');
    }
    const existing = await inspectExisting(id, source);
    if (existing) return existing;

    const tarPath = await findTar(accessFn);
    if (!tarPath) throw new LocalBackupArtifactError('backup_tar_unavailable', 'tar is not installed on this host');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const paths = artifactPaths(id);
    await rm(paths.archive, { force: true });
    await rm(paths.receipt, { force: true });

    const stage = await mkdtemp(path.join(root, `.stage-${id.slice(0, 12)}-${randomSuffix()}-`));
    await chmod(stage, 0o700);
    const temporaryArchive = path.join(stage, 'artifact.tar');
    const temporaryReceipt = path.join(stage, 'receipt.json');
    try {
      for (const entry of normalizedEntries) {
        let info;
        try { info = await lstatFn(path.join(entry.directory, entry.name)); }
        catch { throw new LocalBackupArtifactError('backup_artifact_source_missing', 'Backup artifact source is unavailable'); }
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
          throw new LocalBackupArtifactError('backup_artifact_source_invalid', 'Backup artifact source type is invalid');
        }
      }
      for (const file of normalizedInline) {
        await writeFile(path.join(stage, file.name), file.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }

      const handle = await open(temporaryArchive, 'wx', 0o600);
      await handle.close();
      let first = true;
      const sources = [
        ...(normalizedInline.length > 0 ? [{ directory: stage, names: normalizedInline.map((file) => file.name) }] : []),
        ...normalizedEntries.map((entry) => ({ directory: entry.directory, names: [entry.name] })),
      ];
      for (const sourceEntry of sources) {
        const mode = first ? '--create' : '--append';
        await runTar(tarPath, [
          mode,
          '--file', temporaryArchive,
          '--numeric-owner',
          '--format=gnu',
          '--directory', sourceEntry.directory,
          '--',
          ...sourceEntry.names,
        ]).catch(() => {
          throw new LocalBackupArtifactError('backup_artifact_archive_failed', 'Backup artifact archive could not be created');
        });
        first = false;
      }
      await chmod(temporaryArchive, 0o600);
      const info = await stat(temporaryArchive);
      if (!info.isFile() || info.size < 1) {
        throw new LocalBackupArtifactError('backup_artifact_archive_failed', 'Backup artifact archive is empty');
      }
      const contentSha256 = await sha256File(temporaryArchive);
      const receipt = normalizeReceipt({
        version: STORE_VERSION,
        artifactId: id,
        sourceDigest: source,
        contentSha256,
        bytes: info.size,
        createdAt: new Date(now()).toISOString(),
      }, id, source);
      await writeFile(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporaryArchive, paths.archive);
      await rename(temporaryReceipt, paths.receipt);
      return Object.freeze({
        artifactId: id,
        contentSha256: receipt.contentSha256,
        bytes: receipt.bytes,
        createdAt: receipt.createdAt,
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  return Object.freeze({ archive, inspectExisting, artifactPaths });
}

export const localBackupArtifactInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  tarPaths: TAR_PATHS,
  safeRelativeName,
  normalizeEntries,
  normalizeInlineFiles,
  normalizeReceipt,
  sha256File,
  findTar,
});
