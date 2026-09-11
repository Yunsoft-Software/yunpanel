import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { sanitizeLogMessage } from '@yunpanel/shared';

const LOG_FILES = Object.freeze({
  access: '/var/log/nginx/access.log',
  error: '/var/log/nginx/error.log',
});
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MONTHS = Object.freeze({ Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 });
const LEVELS = new Set(['emerg', 'alert', 'crit', 'error', 'warning', 'notice', 'info', 'debug']);

export class NginxLogReaderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'NginxLogReaderError';
    this.code = code;
    this.status = status;
  }
}

function isoFromAccess(line) {
  const match = line.match(/\[(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\]/);
  if (!match || MONTHS[match[2]] === undefined) return null;
  const utc = Date.UTC(Number(match[3]), MONTHS[match[2]], Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]));
  const offsetMinutes = (Number(match[8]) * 60) + Number(match[9]);
  const timestamp = new Date(utc + (match[7] === '+' ? -1 : 1) * offsetMinutes * 60_000);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function parseNginxLine(kind, line, cursor) {
  let timestamp;
  let level;
  let pid = null;
  if (kind === 'access') {
    timestamp = isoFromAccess(line);
    level = 'info';
  } else {
    const match = line.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \[(emerg|alert|crit|error|warn|notice|info|debug)\] (\d+)#/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
    timestamp = Number.isFinite(date.getTime()) ? date.toISOString() : null;
    level = match[7] === 'warn' ? 'warning' : match[7];
    pid = Number(match[8]);
  }
  if (!timestamp) return null;
  const sanitized = sanitizeLogMessage(line);
  return {
    cursor,
    timestamp,
    level,
    source: 'nginx',
    file: kind,
    pid,
    message: sanitized.message,
    truncated: sanitized.truncated,
  };
}

function splitLines(buffer, absoluteStart, dropPartialFirst) {
  const output = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index !== buffer.length && buffer[index] !== 0x0a) continue;
    if (!(dropPartialFirst && start === 0) && index > start) {
      const withoutCr = buffer[index - 1] === 0x0d ? index - 1 : index;
      output.push({ offset: absoluteStart + start, line: buffer.subarray(start, withoutCr).toString('utf8') });
    }
    start = index + 1;
  }
  return output;
}

export function createNginxLogReader({ openFn = open, lstatFn = lstat } = {}) {
  if (typeof openFn !== 'function' || typeof lstatFn !== 'function') {
    throw new NginxLogReaderError('nginx_log_reader_invalid', 'Nginx log reader configuration is invalid', 500);
  }

  async function query({ kind, since, until, levels, search = null, limit = 100, cursor = null } = {}) {
    const logPath = LOG_FILES[kind];
    if (!logPath || typeof since !== 'string' || typeof until !== 'string' || !Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until))
      || !Array.isArray(levels) || levels.length < 1 || levels.some((level) => !LEVELS.has(level))
      || !Number.isInteger(limit) || limit < 1 || limit > 200
      || (search !== null && (typeof search !== 'string' || search.length < 1 || search.length > 100))
      || (cursor !== null && (typeof cursor !== 'string' || !/^file:(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,15})$/.test(cursor)))) {
      throw new NginxLogReaderError('invalid_log_query', 'Nginx log query is invalid');
    }

    let handle;
    try {
      const linkInfo = await lstatFn(logPath);
      if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error('unsafe log file');
      handle = await openFn(logPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const details = await handle.stat();
      if (!details.isFile() || details.dev !== linkInfo.dev || details.ino !== linkInfo.ino) throw new Error('log file changed');
      if (!Number.isSafeInteger(details.dev) || details.dev < 0 || !Number.isSafeInteger(details.ino) || details.ino < 0
        || !Number.isSafeInteger(details.size) || details.size < 0) throw new Error('invalid log identity');
      const cursorParts = cursor?.split(':') ?? null;
      const requestedEnd = cursorParts ? Number(cursorParts[3]) : details.size;
      if ((cursorParts && (Number(cursorParts[1]) !== details.dev || Number(cursorParts[2]) !== details.ino))
        || !Number.isSafeInteger(requestedEnd) || requestedEnd < 0 || requestedEnd > details.size) {
        throw new NginxLogReaderError('nginx_log_cursor_stale', 'Nginx log file changed after the previous page', 409);
      }
      const cursorPrefix = `file:${details.dev}:${details.ino}:`;
      const start = Math.max(0, requestedEnd - MAX_READ_BYTES);
      const buffer = Buffer.alloc(requestedEnd - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const rows = splitLines(buffer.subarray(0, bytesRead), start, start > 0).reverse();
      const levelSet = new Set(levels);
      const needle = search?.toLocaleLowerCase('en-US') ?? null;
      const entries = [];
      let responseBytes = 0;
      let nextCursor = null;
      let hasMore = false;
      for (const row of rows) {
        const rowCursor = `${cursorPrefix}${row.offset}`;
        const entry = parseNginxLine(kind, row.line, rowCursor);
        if (!entry || entry.timestamp < since || entry.timestamp > until || !levelSet.has(entry.level)
          || (needle && !`${entry.level} ${entry.message}`.toLocaleLowerCase('en-US').includes(needle))) {
          nextCursor = rowCursor;
          continue;
        }
        const entryBytes = Buffer.byteLength(JSON.stringify(entry));
        if (entries.length >= limit || responseBytes + entryBytes > MAX_RESPONSE_BYTES) {
          hasMore = true;
          break;
        }
        entries.push(entry);
        responseBytes += entryBytes;
        nextCursor = entry.cursor;
      }
      if (!hasMore && start > 0) hasMore = true;
      return {
        entries,
        page: { limit, count: entries.length, hasMore, nextCursor: hasMore ? nextCursor : null },
        range: { since, until },
      };
    } catch (error) {
      if (error instanceof NginxLogReaderError) throw error;
      throw new NginxLogReaderError('nginx_log_read_failed', 'Nginx log file could not be read', 503);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return { query };
}

export const nginxLogPolicy = Object.freeze({ files: LOG_FILES, maxReadBytes: MAX_READ_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES });
export const nginxLogInternals = Object.freeze({ isoFromAccess, parseNginxLine, splitLines });
