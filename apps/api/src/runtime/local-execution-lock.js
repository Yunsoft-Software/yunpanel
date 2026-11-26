import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class LocalExecutionLockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalExecutionLockError';
    this.code = code;
  }
}

function normalizeServerId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new LocalExecutionLockError('invalid_local_server_id', 'Local executor server id is invalid');
  }
  return value;
}

function normalizeLockPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 500 || value.includes('\0')) {
    throw new LocalExecutionLockError('invalid_local_lock_path', 'Local executor lock path is invalid');
  }
  return path.normalize(value);
}

function parseLockRecord(value) {
  try {
    const record = JSON.parse(value);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (!Number.isSafeInteger(record.pid) || record.pid < 1) return null;
    if (typeof record.serverId !== 'string' || record.serverId.length < 1 || record.serverId.length > 128) return null;
    if (typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.token)) return null;
    if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return null;
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

async function readExisting(filePath) {
  try {
    return parseLockRecord(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new LocalExecutionLockError('local_executor_lock_read_failed', 'Unable to inspect the local executor lock');
  }
}

export async function acquireLocalExecutionLock({
  filePath,
  serverId,
  pid = process.pid,
  now = Date.now,
  signalProcess = process.kill.bind(process),
} = {}) {
  const normalizedPath = normalizeLockPath(filePath);
  const normalizedServerId = normalizeServerId(serverId);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new LocalExecutionLockError('invalid_local_executor_pid', 'Local executor pid is invalid');
  if (typeof now !== 'function' || typeof signalProcess !== 'function') throw new LocalExecutionLockError('invalid_local_lock_adapter', 'Local executor lock adapter is invalid');

  await mkdir(path.dirname(normalizedPath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const record = {
    version: 1,
    serverId: normalizedServerId,
    pid,
    token,
    createdAt: new Date(now()).toISOString(),
  };
  const serialized = `${JSON.stringify(record)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(normalizedPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const metadata = await stat(normalizedPath);
      if ((metadata.mode & 0o077) !== 0) {
        await unlink(normalizedPath).catch(() => {});
        throw new LocalExecutionLockError('local_executor_lock_permissions', 'Local executor lock permissions are unsafe');
      }

      let released = false;
      return {
        filePath: normalizedPath,
        serverId: normalizedServerId,
        pid,
        async release() {
          if (released) return false;
          released = true;
          let current;
          try {
            current = parseLockRecord(await readFile(normalizedPath, 'utf8'));
          } catch (error) {
            if (error?.code === 'ENOENT') return false;
            return false;
          }
          if (!current || current.token !== token || current.pid !== pid || current.serverId !== normalizedServerId) return false;
          try {
            await unlink(normalizedPath);
            return true;
          } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw new LocalExecutionLockError('local_executor_lock_release_failed', 'Unable to release the local executor lock');
          }
        },
      };
    } catch (error) {
      if (error instanceof LocalExecutionLockError) throw error;
      if (error?.code !== 'EEXIST') {
        throw new LocalExecutionLockError('local_executor_lock_create_failed', 'Unable to acquire the local executor lock');
      }

      const existing = await readExisting(normalizedPath);
      if (!existing) {
        throw new LocalExecutionLockError('local_executor_lock_invalid', 'Existing local executor lock is invalid and requires inspection');
      }
      if (processAlive(existing.pid, signalProcess)) {
        throw new LocalExecutionLockError('local_executor_locked', 'Another local executor process already owns this server');
      }
      try {
        await unlink(normalizedPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') {
          throw new LocalExecutionLockError('local_executor_stale_lock_failed', 'Stale local executor lock could not be removed');
        }
      }
    }
  }

  throw new LocalExecutionLockError('local_executor_lock_race', 'Local executor lock changed while it was being acquired');
}

export const localExecutionLockInternals = Object.freeze({
  normalizeServerId,
  normalizeLockPath,
  parseLockRecord,
  processAlive,
});
