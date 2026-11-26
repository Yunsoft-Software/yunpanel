import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// Durable JSON state files: temp file in the same directory, fsync, rename, directory fsync.
// The last parseable copy is kept as `<file>.bak` so a damaged main file can be recovered.

export function backupPathFor(filePath) {
  return `${filePath}.bak`;
}

function parseJson(buffer) {
  const text = buffer.toString('utf8');
  if (text.trim() === '') throw new SyntaxError('JSON file is empty');
  return JSON.parse(text);
}

function isParseable(buffer) {
  try {
    parseJson(buffer);
    return true;
  } catch {
    return false;
  }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceDurably(target, data, mode) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(path.dirname(target));
}

async function keepPreviousAsBackup(filePath, mode) {
  let previous;
  try {
    previous = await readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  // A damaged main file never replaces the last good backup.
  if (!isParseable(previous)) return;
  await replaceDurably(backupPathFor(filePath), previous, mode);
}

/**
 * Atomically replace `filePath` with `text` (file `mode`, default 0600).
 * A missing parent is created with `directoryMode`; `enforceDirectoryMode` also chmods an existing parent.
 */
export async function writeTextAtomic(filePath, text, { mode = 0o600, directoryMode, enforceDirectoryMode = false } = {}) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, ...(directoryMode === undefined ? {} : { mode: directoryMode }) });
  if (enforceDirectoryMode) await chmod(directory, directoryMode);
  await keepPreviousAsBackup(filePath, mode);
  await replaceDurably(filePath, Buffer.from(text, 'utf8'), mode);
}

/** Serialize `value` now (JSON.stringify with `space`, optional trailing newline) and write it atomically. */
export function writeJsonAtomic(filePath, value, { space = 2, trailingNewline = false, ...options } = {}) {
  const text = `${JSON.stringify(value, null, space)}${trailingNewline ? '\n' : ''}`;
  return writeTextAtomic(filePath, text, options);
}

function defaultRecoveredReport({ filePath, reason }) {
  console.warn(`[yunpanel] ${path.basename(filePath)} was unreadable (${reason}); loaded the last good backup`);
}

/**
 * Parse `filePath`. A missing file rethrows the readFile ENOENT error so callers keep their
 * existing "missing means empty" branch. An empty or corrupt file falls back to `<file>.bak`
 * and calls `onRecovered({ filePath, backupPath, reason })`. If the backup is missing or also
 * unreadable, the original parse error is thrown (fail closed).
 */
export async function readJsonWithFallback(filePath, { onRecovered = defaultRecoveredReport } = {}) {
  const main = await readFile(filePath);
  try {
    return parseJson(main);
  } catch (mainError) {
    const backupPath = backupPathFor(filePath);
    let recovered;
    try {
      recovered = parseJson(await readFile(backupPath));
    } catch {
      throw mainError;
    }
    const reason = main.toString('utf8').trim() === '' ? 'empty file' : 'invalid JSON';
    onRecovered({ filePath, backupPath, reason });
    return recovered;
  }
}
