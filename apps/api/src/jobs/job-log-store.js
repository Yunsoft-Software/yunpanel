import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeLogMessage } from '@yunpanel/shared';

const STORE_VERSION = 1;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGE_PATTERN = /^[a-z][a-z0-9._-]{0,39}$/;
const LEVELS = new Set(['error', 'warning', 'notice', 'info', 'debug']);
const MAX_ENTRIES = 1_000;
const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_FILES = 500;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FILE_BYTES = 1024 * 1024;

export class JobLogStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'JobLogStoreError';
    this.code = code;
    this.status = status;
  }
}

function requireJobId(value) {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    throw new JobLogStoreError('invalid_job_log_identity', 'Job log identity is invalid');
  }
  return value.toLowerCase();
}

function emptyState(jobId) {
  return { version: STORE_VERSION, jobId, nextSequence: 1, droppedEntries: 0, entries: [] };
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateState(value, jobId) {
  if (!value || value.version !== STORE_VERSION || value.jobId !== jobId
    || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1
    || !Number.isSafeInteger(value.droppedEntries) || value.droppedEntries < 0
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new JobLogStoreError('job_log_state_invalid', 'Stored job log is invalid', 500);
  }
  let previous = 0;
  let bytes = 0;
  for (const entry of value.entries) {
    if (!entry || !Number.isSafeInteger(entry.sequence) || entry.sequence <= previous || entry.sequence >= value.nextSequence
      || !validTimestamp(entry.timestamp) || !LEVELS.has(entry.level) || !STAGE_PATTERN.test(entry.stage)
      || typeof entry.message !== 'string' || entry.message.length < 1 || entry.message.length > 4 * 1024
      || typeof entry.truncated !== 'boolean') {
      throw new JobLogStoreError('job_log_state_invalid', 'Stored job log entry is invalid', 500);
    }
    previous = entry.sequence;
    bytes += Buffer.byteLength(entry.message);
  }
  if (bytes > MAX_MESSAGE_BYTES) throw new JobLogStoreError('job_log_state_invalid', 'Stored job log exceeds its bound', 500);
  return value;
}

function publicEntry(jobId, entry) {
  return {
    cursor: `deploy:${entry.sequence}`,
    timestamp: entry.timestamp,
    level: entry.level,
    source: 'deploy',
    stage: entry.stage,
    message: entry.message,
    truncated: entry.truncated,
    jobId,
  };
}

export function createJobLogStore({ directoryPath, now = () => Date.now() } = {}) {
  if (typeof directoryPath !== 'string' || !path.isAbsolute(directoryPath) || typeof now !== 'function') {
    throw new JobLogStoreError('job_log_store_path_invalid', 'Job log store requires an absolute directory', 500);
  }
  let initialized = false;
  let initializing = null;
  const cache = new Map();
  const writeTails = new Map();

  function filePath(jobId) {
    return path.join(directoryPath, `${requireJobId(jobId)}.json`);
  }

  async function prune() {
    const names = await readdir(directoryPath);
    const candidates = [];
    for (const name of names) {
      if (!JOB_ID_PATTERN.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
      try {
        const details = await lstat(path.join(directoryPath, name));
        if (details.isFile() && !details.isSymbolicLink()) candidates.push({ name, mtimeMs: details.mtimeMs });
      } catch { /* A concurrent cleanup may have removed the file. */ }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const cutoff = now() - RETENTION_MS;
    const expired = candidates.filter((candidate, index) => index >= MAX_FILES || candidate.mtimeMs < cutoff);
    await Promise.all(expired.map(async (candidate) => {
      await rm(path.join(directoryPath, candidate.name), { force: true });
      cache.delete(candidate.name.slice(0, -5));
    }));
  }

  async function init() {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = (async () => {
      await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      const details = await lstat(directoryPath);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new JobLogStoreError('job_log_store_path_invalid', 'Job log store directory is unsafe', 500);
      }
      await chmod(directoryPath, 0o700);
      await prune();
      initialized = true;
    })().finally(() => { initializing = null; });
    return initializing;
  }

  async function load(jobId) {
    const normalizedJobId = requireJobId(jobId);
    if (cache.has(normalizedJobId)) return cache.get(normalizedJobId);
    const target = filePath(normalizedJobId);
    let state;
    try {
      const details = await lstat(target);
      if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_FILE_BYTES) throw new Error('invalid log file');
      state = validateState(JSON.parse(await readFile(target, 'utf8')), normalizedJobId);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof JobLogStoreError) throw error;
        throw new JobLogStoreError('job_log_state_invalid', 'Stored job log could not be read', 500);
      }
      state = emptyState(normalizedJobId);
    }
    cache.set(normalizedJobId, state);
    return state;
  }

  async function persist(state) {
    const target = filePath(state.jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  function serialize(jobId, operation) {
    const normalizedJobId = requireJobId(jobId);
    const previous = writeTails.get(normalizedJobId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    writeTails.set(normalizedJobId, current);
    return current.finally(() => {
      if (writeTails.get(normalizedJobId) === current) writeTails.delete(normalizedJobId);
    });
  }

  async function record({ jobId, stage, level = 'info', message } = {}) {
    await init();
    const normalizedJobId = requireJobId(jobId);
    if (typeof stage !== 'string' || !STAGE_PATTERN.test(stage) || !LEVELS.has(level)) {
      throw new JobLogStoreError('invalid_job_log_entry', 'Job log metadata is invalid');
    }
    const sanitized = sanitizeLogMessage(message);
    const lines = sanitized.message.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) return null;
    return serialize(normalizedJobId, async () => {
      const state = await load(normalizedJobId);
      const newLog = state.nextSequence === 1 && state.entries.length === 0;
      const timestamp = new Date(now()).toISOString();
      for (const line of lines) {
        state.entries.push({
          sequence: state.nextSequence,
          timestamp,
          level,
          stage,
          message: line,
          truncated: sanitized.truncated,
        });
        state.nextSequence += 1;
      }
      let bytes = state.entries.reduce((total, entry) => total + Buffer.byteLength(entry.message), 0);
      while (state.entries.length > MAX_ENTRIES || bytes > MAX_MESSAGE_BYTES) {
        const [removed] = state.entries.splice(0, 1);
        bytes -= Buffer.byteLength(removed.message);
        state.droppedEntries += 1;
      }
      await persist(state);
      if (newLog) await prune();
      return publicEntry(normalizedJobId, state.entries.at(-1));
    });
  }

  async function query(jobId, {
    cursor = null, limit = 100, levels = ['error', 'warning', 'notice', 'info', 'debug'], search = null,
    since = null, until = null,
  } = {}) {
    await init();
    const normalizedJobId = requireJobId(jobId);
    const activeWrite = writeTails.get(normalizedJobId);
    if (activeWrite) await activeWrite;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000 || !Array.isArray(levels) || levels.length < 1
      || levels.some((level) => !LEVELS.has(level))
      || (cursor !== null && (typeof cursor !== 'string' || !/^deploy:[1-9][0-9]{0,14}$/.test(cursor)))
      || (search !== null && (typeof search !== 'string' || search.length < 1 || search.length > 100))
      || (since !== null && !validTimestamp(since)) || (until !== null && !validTimestamp(until))) {
      throw new JobLogStoreError('invalid_job_log_query', 'Job log query is invalid');
    }
    const state = await load(normalizedJobId);
    const beforeSequence = cursor ? Number(cursor.slice('deploy:'.length)) : Number.MAX_SAFE_INTEGER;
    const levelSet = new Set(levels);
    const needle = search?.toLocaleLowerCase('en-US') ?? null;
    const matching = state.entries.filter((entry) => entry.sequence < beforeSequence
      && levelSet.has(entry.level)
      && (since === null || entry.timestamp >= since)
      && (until === null || entry.timestamp <= until)
      && (!needle || `${entry.level} ${entry.stage} ${entry.message}`.toLocaleLowerCase('en-US').includes(needle)))
      .reverse();
    const entries = matching.slice(0, limit).map((entry) => publicEntry(normalizedJobId, entry));
    const hasMore = matching.length > entries.length;
    return {
      entries,
      page: {
        limit,
        count: entries.length,
        hasMore,
        nextCursor: hasMore ? entries.at(-1)?.cursor ?? null : null,
        droppedEntries: state.droppedEntries,
      },
      range: { since, until },
    };
  }

  return { init, record, query };
}

export const jobLogStorePolicy = Object.freeze({
  maxEntries: MAX_ENTRIES,
  maxMessageBytes: MAX_MESSAGE_BYTES,
  maxFiles: MAX_FILES,
  retentionMs: RETENTION_MS,
});
