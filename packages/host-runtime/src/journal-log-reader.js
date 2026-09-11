import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeLogMessage } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const JOURNALCTL_PATH = '/usr/bin/journalctl';
const NODE_UNIT_PATTERN = /^yunpanel-node-[a-f0-9]{16}\.service$/;
const FIXED_UNITS = new Set([
  'nginx.service', 'mariadb.service', 'mysql.service', 'docker.service', 'cron.service',
  'postfix.service', 'dovecot.service', 'rspamd.service', 'yunpanel-api.service', 'yunpanel-web.service',
]);
const CURSOR_PATTERN = /^[A-Za-z0-9;:_=.-]{1,512}$/;
const PRIORITY_NAMES = Object.freeze(['emerg', 'alert', 'crit', 'error', 'warning', 'notice', 'info', 'debug']);
const MAX_SCAN_ENTRIES = 1_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class JournalLogReaderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'JournalLogReaderError';
    this.code = code;
    this.status = status;
  }
}

function requireUnit(value) {
  if (typeof value !== 'string' || (!FIXED_UNITS.has(value) && !NODE_UNIT_PATTERN.test(value))) {
    throw new JournalLogReaderError('unsupported_log_unit', 'Log unit is not managed by YunPanel');
  }
  return value;
}

function requireTimestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new JournalLogReaderError('invalid_log_query', `${field} must be an ISO timestamp`);
  }
  return value;
}

function requirePriorities(value) {
  if (!Array.isArray(value) || value.length < 1 || value.some((priority) => !Number.isInteger(priority) || priority < 0 || priority > 7)) {
    throw new JournalLogReaderError('invalid_log_query', 'Log priorities are invalid');
  }
  return [...new Set(value)].sort((left, right) => left - right);
}

function journalTimestamp(record) {
  const microseconds = Number(record?.__REALTIME_TIMESTAMP ?? record?._SOURCE_REALTIME_TIMESTAMP);
  if (!Number.isSafeInteger(microseconds) || microseconds < 0) return null;
  const timestamp = new Date(Math.floor(microseconds / 1_000));
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function parseRecord(line, requestedUnit) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  const cursor = typeof record?.__CURSOR === 'string' && CURSOR_PATTERN.test(record.__CURSOR) ? record.__CURSOR : null;
  const timestamp = journalTimestamp(record);
  const priority = Number(record?.PRIORITY);
  if (!cursor || !timestamp || !Number.isInteger(priority) || priority < 0 || priority > 7 || typeof record?.MESSAGE !== 'string') return null;
  const sanitized = sanitizeLogMessage(record.MESSAGE);
  const pid = typeof record._PID === 'string' && /^[1-9][0-9]{0,9}$/.test(record._PID) ? Number(record._PID) : null;
  return {
    cursor,
    timestamp,
    level: PRIORITY_NAMES[priority],
    priority,
    source: 'journal',
    unit: requestedUnit,
    pid,
    message: sanitized.message,
    truncated: sanitized.truncated,
  };
}

export function createJournalLogReader({
  journalctlPath = JOURNALCTL_PATH,
  run = (file, args, options) => execFileAsync(file, args, options),
} = {}) {
  if (journalctlPath !== JOURNALCTL_PATH || typeof run !== 'function') {
    throw new JournalLogReaderError('journal_log_reader_invalid', 'Journal log reader configuration is invalid', 500);
  }

  async function query({ unit, since, until, priorities, search = null, limit = 100, cursor = null } = {}) {
    const normalizedUnit = requireUnit(unit);
    const normalizedSince = requireTimestamp(since, 'since');
    const normalizedUntil = requireTimestamp(until, 'until');
    if (Date.parse(normalizedSince) > Date.parse(normalizedUntil)) {
      throw new JournalLogReaderError('invalid_log_query', 'Log time range is invalid');
    }
    const normalizedPriorities = requirePriorities(priorities);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200
      || (cursor !== null && (typeof cursor !== 'string' || !CURSOR_PATTERN.test(cursor)))
      || (search !== null && (typeof search !== 'string' || search.length < 1 || search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)))) {
      throw new JournalLogReaderError('invalid_log_query', 'Log pagination or search is invalid');
    }

    const args = [
      `--unit=${normalizedUnit}`,
      '--output=json',
      '--no-pager',
      '--utc',
      '--reverse',
      `--lines=${MAX_SCAN_ENTRIES + 1}`,
      `--since=${normalizedSince}`,
      `--until=${normalizedUntil}`,
      `--priority=${normalizedPriorities[0]}..${normalizedPriorities.at(-1)}`,
    ];
    if (cursor) args.push(`--cursor=${cursor}`);

    let stdout;
    try {
      ({ stdout } = await run(journalctlPath, args, {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      }));
    } catch {
      throw new JournalLogReaderError('journal_log_read_failed', 'System journal could not be read', 503);
    }

    const lines = String(stdout ?? '').split('\n').filter(Boolean);
    const entries = [];
    const needle = search?.toLocaleLowerCase('en-US') ?? null;
    let bytes = 0;
    let scanned = 0;
    let nextCursor = null;
    let hasMore = false;
    for (const line of lines) {
      const entry = parseRecord(line, normalizedUnit);
      if (!entry || entry.cursor === cursor) continue;
      scanned += 1;
      const matches = normalizedPriorities.includes(entry.priority)
        && (!needle || `${entry.level} ${entry.message}`.toLocaleLowerCase('en-US').includes(needle));
      if (!matches) {
        nextCursor = entry.cursor;
        continue;
      }
      const entryBytes = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length >= limit || bytes + entryBytes > MAX_RESPONSE_BYTES) {
        hasMore = true;
        break;
      }
      entries.push(entry);
      bytes += entryBytes;
      nextCursor = entry.cursor;
    }
    if (!hasMore && lines.length > MAX_SCAN_ENTRIES) hasMore = true;
    return {
      entries,
      page: { limit, count: entries.length, scanned, hasMore, nextCursor: hasMore ? nextCursor : null },
      range: { since: normalizedSince, until: normalizedUntil },
    };
  }

  return { query };
}

export const journalLogPolicy = Object.freeze({
  journalctlPath: JOURNALCTL_PATH,
  fixedUnits: Object.freeze([...FIXED_UNITS]),
  maxScanEntries: MAX_SCAN_ENTRIES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  priorityNames: PRIORITY_NAMES,
});

export const journalLogInternals = Object.freeze({ requireUnit, parseRecord, journalTimestamp });
