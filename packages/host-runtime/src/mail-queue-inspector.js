import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeLogMessage } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const POSTQUEUE = '/usr/sbin/postqueue';
const MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SCAN_ENTRIES = 1_000;
const MAX_RECIPIENTS_PER_MESSAGE = 500;
const QUEUE_ID_PATTERN = /^[A-Za-z0-9]{5,128}$/;
const QUEUE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SEARCH_PATTERN = /^[\p{L}\p{N} ._/@+\-]{1,100}$/u;

export class MailQueueInspectorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailQueueInspectorError';
    this.code = code;
    this.status = status;
  }
}

function boundedAddress(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)
    || (!allowEmpty && value.length < 1)) return null;
  return value;
}

function boundedReason(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return null;
  const sanitized = sanitizeLogMessage(value);
  return sanitized.message.slice(0, 1_000);
}

function parseRecipient(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const address = boundedAddress(value.address);
  if (!address) return null;
  return Object.freeze({
    address,
    delayReason: boundedReason(value.delay_reason),
  });
}

function parseQueueRecord(line) {
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.queue_id !== 'string' || !QUEUE_ID_PATTERN.test(value.queue_id)
    || typeof value.queue_name !== 'string' || !QUEUE_NAME_PATTERN.test(value.queue_name)
    || !Number.isSafeInteger(value.arrival_time) || value.arrival_time < 0
    || !Number.isSafeInteger(value.message_size) || value.message_size < 0
    || !Array.isArray(value.recipients) || value.recipients.length > MAX_RECIPIENTS_PER_MESSAGE) return null;
  const sender = boundedAddress(value.sender, { allowEmpty: true });
  if (sender === null) return null;
  const recipients = value.recipients.map(parseRecipient);
  if (recipients.some((entry) => entry === null)) return null;
  const arrival = new Date(value.arrival_time * 1_000);
  if (!Number.isFinite(arrival.getTime())) return null;
  return Object.freeze({
    queueId: value.queue_id,
    queueName: value.queue_name,
    arrivalTime: arrival.toISOString(),
    messageSize: value.message_size,
    sender,
    recipients: Object.freeze(recipients),
  });
}

function matchesSearch(entry, search) {
  if (!search) return true;
  const needle = search.toLocaleLowerCase('en-US');
  const haystack = [
    entry.queueId,
    entry.queueName,
    entry.sender,
    ...entry.recipients.flatMap((recipient) => [recipient.address, recipient.delayReason ?? '']),
  ].join(' ').toLocaleLowerCase('en-US');
  return haystack.includes(needle);
}

export function createMailQueueInspector({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: MAX_RAW_BYTES,
    windowsHide: true,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    ...options,
  }),
} = {}) {
  if (typeof run !== 'function') {
    throw new MailQueueInspectorError('mail_queue_dependencies_invalid', 'Mail queue inspector dependencies are invalid', 500);
  }

  async function query({ limit = 100, search = null, queueName = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200
      || (search !== null && (typeof search !== 'string' || !SEARCH_PATTERN.test(search)))
      || (queueName !== null && (typeof queueName !== 'string' || !QUEUE_NAME_PATTERN.test(queueName)))) {
      throw new MailQueueInspectorError('invalid_mail_queue_query', 'Mail queue query is invalid');
    }
    let stdout;
    try {
      const result = await run(POSTQUEUE, ['-j'], { timeout: 10_000, maxBuffer: MAX_RAW_BYTES });
      stdout = String(result?.stdout ?? result ?? '');
      if (Buffer.byteLength(stdout) > MAX_RAW_BYTES) throw new Error('bounded output exceeded');
    } catch {
      throw new MailQueueInspectorError('mail_queue_unavailable', 'Postfix mail queue could not be inspected', 503);
    }

    const lines = stdout.split('\n').filter(Boolean);
    const entries = [];
    let scanned = 0;
    let responseBytes = 0;
    let malformed = 0;
    let hasMore = lines.length > MAX_SCAN_ENTRIES;
    for (const line of lines.slice(0, MAX_SCAN_ENTRIES)) {
      scanned += 1;
      const entry = parseQueueRecord(line);
      if (!entry) {
        malformed += 1;
        continue;
      }
      if (queueName !== null && entry.queueName !== queueName) continue;
      if (!matchesSearch(entry, search)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length >= limit || responseBytes + bytes > MAX_RESPONSE_BYTES) {
        hasMore = true;
        break;
      }
      entries.push(entry);
      responseBytes += bytes;
    }
    return Object.freeze({
      entries: Object.freeze(entries),
      page: Object.freeze({
        limit,
        count: entries.length,
        scanned,
        hasMore,
        malformed,
      }),
      sideEffects: false,
    });
  }

  return Object.freeze({ query });
}

export const mailQueueInspectorInternals = Object.freeze({
  postqueuePath: POSTQUEUE,
  maxRawBytes: MAX_RAW_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxScanEntries: MAX_SCAN_ENTRIES,
  maxRecipientsPerMessage: MAX_RECIPIENTS_PER_MESSAGE,
  parseQueueRecord,
  matchesSearch,
});
