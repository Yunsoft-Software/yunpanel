import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProcessStoreLockError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'ProcessStoreLockError';
    this.code = code;
    this.status = status;
  }
}

function parseRecord(value) {
  try {
    const record = JSON.parse(value);
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.version !== 1
      || !Number.isSafeInteger(record.pid) || record.pid < 1
      || typeof record.token !== 'string' || !TOKEN.test(record.token)
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return null;
    return record;
  } catch {
    return null;
  }
}

function processAlive(pid, signalProcess) {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

export function createProcessStoreLock({
  filePath,
  pid = process.pid,
  now = Date.now,
  signalProcess = process.kill.bind(process),
} = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.length > 500 || filePath.includes('\0')
    || !Number.isSafeInteger(pid) || pid < 1 || typeof now !== 'function' || typeof signalProcess !== 'function') {
    throw new ProcessStoreLockError('process_store_lock_invalid', 'Process store lock configuration is invalid');
  }
  const lockPath = `${filePath}.lock`;

  async function withLock(action) {
    if (typeof action !== 'function') {
      throw new ProcessStoreLockError('process_store_lock_action_invalid', 'Process store lock action is invalid', 400);
    }
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const record = Object.freeze({
      version: 1,
      pid,
      token,
      createdAt: new Date(now()).toISOString(),
    });
    const serialized = `${JSON.stringify(record)}\n`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle = null;
      let acquired = false;
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await writeFile(handle, serialized, { encoding: 'utf8' });
        await handle.close();
        handle = null;
        acquired = true;
        try {
          return await action();
        } finally {
          let current = null;
          try { current = parseRecord(await readFile(lockPath, 'utf8')); } catch {}
          if (current?.token === token && current.pid === pid) {
            await rm(lockPath, { force: true }).catch(() => {});
          }
        }
      } catch (error) {
        await handle?.close().catch(() => {});
        if (acquired) throw error;
        if (error instanceof ProcessStoreLockError) throw error;
        if (error?.code !== 'EEXIST') {
          throw new ProcessStoreLockError('process_store_lock_failed', 'Process store lock could not be acquired');
        }
        let existing;
        try { existing = parseRecord(await readFile(lockPath, 'utf8')); }
        catch {
          throw new ProcessStoreLockError('process_store_lock_unreadable', 'Existing process store lock requires inspection');
        }
        if (!existing) {
          throw new ProcessStoreLockError('process_store_lock_unreadable', 'Existing process store lock is invalid');
        }
        if (processAlive(existing.pid, signalProcess)) {
          throw new ProcessStoreLockError('process_store_locked', 'Another process is mutating this durable store', 409);
        }
        await rm(lockPath, { force: true });
      }
    }
    throw new ProcessStoreLockError('process_store_lock_race', 'Process store lock changed while it was being acquired', 409);
  }

  return Object.freeze({ filePath, lockPath, withLock });
}

export const processStoreLockInternals = Object.freeze({ parseRecord, processAlive });
