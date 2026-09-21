import { createHash, randomBytes } from 'node:crypto';
import {
  chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLICATION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RELEASE_ID = APPLICATION_ID;
const ROOT_PATTERN = new RegExp(
  `^/(?:var/www|var/lib)/yunpanel/apps/${APPLICATION_ID}(?:/(?:releases/${RELEASE_ID}|current)(?:/[A-Za-z0-9._-]+)*|/(?:public_html|public)(?:/[A-Za-z0-9._-]+)*)?$`,
  'i',
);
const MAX_PATH_BYTES = 1_024;
const MAX_SEGMENT_BYTES = 255;
const MAX_LIST_ENTRIES = 1_000;
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPERATIONS = new Set([
  'list', 'download', 'read_text', 'upload', 'write_text',
  'create_file', 'mkdir', 'rename', 'delete', 'batch_delete',
]);

export class SiteFileWorkerError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SiteFileWorkerError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 400) {
  throw new SiteFileWorkerError(code, message, status);
}

function relativePath(value, { allowRoot = false, field = 'path' } = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
    || /[\\\u0000-\u001f\u007f]/.test(value)) {
    fail('site_file_path_invalid', `${field} is invalid`);
  }
  let normalized = value;
  if (normalized.startsWith('/')) {
    normalized = normalized.replace(/^\/+/, '');
  }
  if (normalized === '') {
    if (!allowRoot) fail('site_file_path_invalid', `${field} is invalid`);
    return '';
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..'
      || Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES
      || segment.includes('\u0000')) {
      fail('site_file_path_invalid', `${field} is invalid`);
    }
  }
  return segments.join('/');
}

function exactRequest(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && Object.keys(value).every((key) => fields.includes(key));
}

function metadata(info, entryPath, type = null) {
  const resolvedType = type ?? (info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other');
  return Object.freeze({
    path: entryPath,
    name: entryPath ? path.posix.basename(entryPath) : '',
    type: resolvedType,
    size: info.isFile() ? info.size : null,
    mode: (info.mode & 0o7777).toString(8).padStart(4, '0'),
    uid: info.uid,
    gid: info.gid,
    modifiedAt: info.mtime.toISOString(),
  });
}

async function managedRoot(value, dependencies) {
  if (typeof value !== 'string' || !ROOT_PATTERN.test(value)) {
    fail('site_file_root_invalid', 'Managed root is invalid', 409);
  }
  let info;
  let resolved;
  try {
    [info, resolved] = await Promise.all([dependencies.stat(value), dependencies.realpath(value)]);
  } catch {
    fail('site_file_root_unavailable', 'Managed root is unavailable', 409);
  }
  if (!info.isDirectory() || !ROOT_PATTERN.test(resolved)) {
    fail('site_file_root_invalid', 'Managed root is invalid', 409);
  }
  return resolved;
}

async function walk(root, relative, dependencies, { allowFinalSymlink = false } = {}) {
  if (relative === '') return { absolute: root, info: await dependencies.lstat(root) };
  const segments = relative.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let info;
    try { info = await dependencies.lstat(current); }
    catch (error) {
      if (error?.code === 'ENOENT') fail('site_file_not_found', 'File or directory not found', 404);
      throw error;
    }
    const final = index === segments.length - 1;
    if (info.isSymbolicLink() && !(allowFinalSymlink && final)) {
      fail('site_file_symlink_rejected', 'Symbolic links cannot be followed', 409);
    }
    if (!final && !info.isDirectory()) fail('site_file_not_directory', 'A parent path is not a directory', 409);
    if (final) return { absolute: current, info };
  }
  fail('site_file_path_invalid', 'File path is invalid');
}

async function destination(root, relative, dependencies) {
  const parentRelative = path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative);
  const parent = await walk(root, parentRelative, dependencies);
  if (!parent.info.isDirectory()) fail('site_file_not_directory', 'Destination parent is not a directory', 409);
  return { absolute: path.join(parent.absolute, path.posix.basename(relative)), parent };
}

async function ensureAbsent(absolute, dependencies) {
  try {
    await dependencies.lstat(absolute);
    fail('site_file_exists', 'Destination already exists', 409);
  } catch (error) {
    if (error instanceof SiteFileWorkerError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
}

function regularFile(entry, { maxBytes = MAX_TRANSFER_BYTES } = {}) {
  if (entry.info.isSymbolicLink()) fail('site_file_symlink_rejected', 'Symbolic links cannot be followed', 409);
  if (!entry.info.isFile()) fail('site_file_not_regular', 'Path must identify a regular file', 409);
  if (!Number.isSafeInteger(entry.info.size) || entry.info.size < 0 || entry.info.size > maxBytes) {
    fail('site_file_too_large', `File exceeds the ${maxBytes} byte limit`, 413);
  }
}

function decodedContent(value, maxBytes = MAX_TRANSFER_BYTES) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail('site_file_content_invalid', 'File content encoding is invalid');
  }
  const content = Buffer.from(value, 'base64');
  if (content.length > maxBytes) fail('site_file_too_large', `File exceeds the ${maxBytes} byte limit`, 413);
  if (content.toString('base64') !== value) fail('site_file_content_invalid', 'File content encoding is invalid');
  return content;
}

async function atomicWrite(absolute, content, mode, dependencies) {
  const temporary = `${absolute}.yunpanel-${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await dependencies.open(temporary, 'wx', mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await dependencies.rename(temporary, absolute);
  } catch (error) {
    try { await dependencies.rm(temporary, { force: true }); } catch {}
    throw error;
  }
}

function safeMode(info) {
  if (!info) return null;
  return (info.mode & 0o777) | 0o640;
}

function creationModes() {
  return {
    file: 0o640,
    directory: 0o750,
  };
}

function mapSystemError(error) {
  if (error instanceof SiteFileWorkerError) return error;
  if (error?.code === 'ENOENT') return new SiteFileWorkerError('site_file_not_found', 'File or directory not found', 404);
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return new SiteFileWorkerError('site_file_permission_denied', 'Permission denied', 403);
  if (error?.code === 'EEXIST') return new SiteFileWorkerError('site_file_exists', 'Destination already exists', 409);
  if (error?.code === 'ENOTEMPTY') return new SiteFileWorkerError('site_file_directory_not_empty', 'Directory is not empty', 409);
  if (error?.code === 'ENOTDIR') return new SiteFileWorkerError('site_file_not_directory', 'Path must identify a directory', 409);
  if (error?.code === 'EISDIR') return new SiteFileWorkerError('site_file_is_directory', 'Target is a directory', 409);
  return new SiteFileWorkerError('site_file_worker_failed', 'Filesystem operation failed', 503);
}

export async function executeSiteFileOperation(request, dependencies = {
  chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat,
}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || typeof request.operation !== 'string' || !OPERATIONS.has(request.operation)) {
    fail('site_file_request_invalid', 'Site file worker request is invalid');
  }

  const modes = creationModes();
  try {
    const root = await managedRoot(request.root, dependencies);

    if (request.operation === 'list') {
      if (!exactRequest(request, ['operation', 'root', 'path'])) fail('site_file_request_invalid', 'List request fields are invalid');
      const itemPath = relativePath(request.path, { allowRoot: true });
      const directory = await walk(root, itemPath, dependencies);
      if (!directory.info.isDirectory()) fail('site_file_not_directory', 'Path must identify a directory', 409);
      const names = await dependencies.readdir(directory.absolute);
      if (names.length > MAX_LIST_ENTRIES) fail('site_file_list_too_large', `Directory exceeds the ${MAX_LIST_ENTRIES} entry limit`, 413);
      const entries = await Promise.all(names.map(async (name) => {
        const childPath = itemPath ? `${itemPath}/${name}` : name;
        const info = await dependencies.lstat(path.join(directory.absolute, name));
        return metadata(info, childPath);
      }));
      entries.sort((left, right) => (left.type === right.type
        ? left.name.localeCompare(right.name, 'en')
        : left.type === 'directory' ? -1 : right.type === 'directory' ? 1 : left.name.localeCompare(right.name, 'en')));
      return Object.freeze({ directory: metadata(directory.info, itemPath, 'directory'), entries });
    }

    if (request.operation === 'create_file') {
      if (!exactRequest(request, ['operation', 'root', 'path'])) fail('site_file_request_invalid', 'File creation request fields are invalid');
      const itemPath = relativePath(request.path);
      const target = await destination(root, itemPath, dependencies);
      await ensureAbsent(target.absolute, dependencies);
      await atomicWrite(target.absolute, Buffer.alloc(0), modes.file, dependencies);
      return Object.freeze({ file: metadata(await dependencies.stat(target.absolute), itemPath), created: true });
    }

    if (request.operation === 'download' || request.operation === 'read_text') {
      if (!exactRequest(request, ['operation', 'root', 'path'])) fail('site_file_request_invalid', 'Read request fields are invalid');
      const itemPath = relativePath(request.path);
      const entry = await walk(root, itemPath, dependencies);
      const maxBytes = request.operation === 'read_text' ? MAX_TEXT_BYTES : MAX_TRANSFER_BYTES;
      regularFile(entry, { maxBytes });
      const content = await dependencies.readFile(entry.absolute);
      if (content.length > maxBytes) fail('site_file_too_large', `File exceeds the ${maxBytes} byte limit`, 413);
      if (request.operation === 'download') return Object.freeze({ file: metadata(entry.info, itemPath), content: content.toString('base64') });
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
      catch { fail('site_file_not_text', 'File is not valid UTF-8 text', 409); }
      return Object.freeze({ file: metadata(entry.info, itemPath), content: text, sha256: createHash('sha256').update(content).digest('hex') });
    }

    if (request.operation === 'upload') {
      if (!exactRequest(request, ['operation', 'root', 'path', 'content'])) fail('site_file_request_invalid', 'Upload request fields are invalid');
      const itemPath = relativePath(request.path);
      const target = await destination(root, itemPath, dependencies);
      let existing = null;
      try { existing = await walk(root, itemPath, dependencies); }
      catch (error) { if (error.code !== 'site_file_not_found') throw error; }
      if (existing) regularFile(existing);
      const content = decodedContent(request.content);
      await atomicWrite(target.absolute, content, safeMode(existing?.info) ?? modes.file, dependencies);
      return Object.freeze({ file: metadata(await dependencies.stat(target.absolute), itemPath), created: !existing });
    }

    if (request.operation === 'write_text') {
      if (!exactRequest(request, ['operation', 'root', 'path', 'content', 'expectedSha256'])
        || typeof request.content !== 'string' || !SHA256_PATTERN.test(request.expectedSha256 ?? '')) {
        fail('site_file_request_invalid', 'Text edit request fields are invalid');
      }
      const itemPath = relativePath(request.path);
      const entry = await walk(root, itemPath, dependencies);
      regularFile(entry, { maxBytes: MAX_TEXT_BYTES });
      const previous = await dependencies.readFile(entry.absolute);
      if (previous.length > MAX_TEXT_BYTES) fail('site_file_too_large', `File exceeds the ${MAX_TEXT_BYTES} byte limit`, 413);
      const actualSha256 = createHash('sha256').update(previous).digest('hex');
      if (actualSha256 !== request.expectedSha256) fail('site_file_changed', 'File changed since it was opened', 409);
      const content = Buffer.from(request.content, 'utf8');
      if (content.toString('utf8') !== request.content) fail('site_file_content_invalid', 'Text content is not valid Unicode');
      if (content.length > MAX_TEXT_BYTES) fail('site_file_too_large', `File exceeds the ${MAX_TEXT_BYTES} byte limit`, 413);
      await atomicWrite(entry.absolute, content, safeMode(entry.info), dependencies);
      return Object.freeze({
        file: metadata(await dependencies.stat(entry.absolute), itemPath),
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }

    if (request.operation === 'mkdir') {
      if (!exactRequest(request, ['operation', 'root', 'path'])) fail('site_file_request_invalid', 'Directory request fields are invalid');
      const itemPath = relativePath(request.path);
      const target = await destination(root, itemPath, dependencies);
      await ensureAbsent(target.absolute, dependencies);
      await dependencies.mkdir(target.absolute, { recursive: false, mode: modes.directory });
      await dependencies.chmod(target.absolute, modes.directory);
      return Object.freeze({ directory: metadata(await dependencies.stat(target.absolute), itemPath, 'directory') });
    }

    if (request.operation === 'rename') {
      if (!exactRequest(request, ['operation', 'root', 'path', 'destination'])) fail('site_file_request_invalid', 'Rename request fields are invalid');
      const itemPath = relativePath(request.path);
      const destinationPath = relativePath(request.destination, { field: 'destination' });
      if (destinationPath === itemPath || destinationPath.startsWith(`${itemPath}/`)) fail('site_file_destination_invalid', 'Rename destination is invalid', 409);
      const source = await walk(root, itemPath, dependencies);
      if (source.info.isSymbolicLink()) fail('site_file_symlink_rejected', 'Symbolic links cannot be renamed', 409);
      const target = await destination(root, destinationPath, dependencies);
      await ensureAbsent(target.absolute, dependencies);
      await dependencies.rename(source.absolute, target.absolute);
      return Object.freeze({ entry: metadata(await dependencies.lstat(target.absolute), destinationPath), previousPath: itemPath });
    }

    if (request.operation === 'delete') {
      if (!exactRequest(request, ['operation', 'root', 'path'])) fail('site_file_request_invalid', 'Delete request fields are invalid');
      const itemPath = relativePath(request.path);
      const entry = await walk(root, itemPath, dependencies, { allowFinalSymlink: true });
      await dependencies.rm(entry.absolute, { recursive: entry.info.isDirectory(), force: false });
      return Object.freeze({ deleted: true, path: itemPath, type: entry.info.isSymbolicLink() ? 'symlink' : entry.info.isDirectory() ? 'directory' : 'file' });
    }

    if (request.operation === 'batch_delete') {
      if (!exactRequest(request, ['operation', 'root', 'paths']) || !Array.isArray(request.paths) || request.paths.length === 0) {
        fail('site_file_request_invalid', 'Batch delete requires a non-empty paths array');
      }
      if (request.paths.length > 200) {
        fail('site_file_request_too_large', 'Batch delete cannot exceed 200 items at once', 413);
      }
      const results = [];
      for (const p of request.paths) {
        const itemPath = relativePath(p);
        try {
          const entry = await walk(root, itemPath, dependencies, { allowFinalSymlink: true });
          await dependencies.rm(entry.absolute, { recursive: entry.info.isDirectory(), force: false });
          results.push({ path: itemPath, deleted: true });
        } catch (err) {
          results.push({ path: itemPath, deleted: false, error: err.message });
        }
      }
      return Object.freeze({ deleted: results });
    }

    fail('site_file_request_invalid', 'Site file worker request is invalid');
  } catch (error) {
    throw mapSystemError(error);
  }
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) fail('site_file_request_too_large', 'Site file worker request is too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('site_file_request_invalid', 'Site file worker request is invalid'); }
}

async function main() {
  try {
    const data = await executeSiteFileOperation(await readStdin());
    process.stdout.write(JSON.stringify({ ok: true, data }));
  } catch (error) {
    const safe = mapSystemError(error);
    process.stdout.write(JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message, status: safe.status } }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

export const siteFileWorkerInternals = Object.freeze({
  maxListEntries: MAX_LIST_ENTRIES,
  maxTextBytes: MAX_TEXT_BYTES,
  maxTransferBytes: MAX_TRANSFER_BYTES,
  creationModes,
  relativePath,
  releaseRootPattern: ROOT_PATTERN,
});
