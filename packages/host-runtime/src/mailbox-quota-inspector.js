import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeMailboxAddress } from '@yunpanel/config-templates';

const execFileAsync = promisify(execFile);
const DOVEADM = '/usr/bin/doveadm';
const MAX_OUTPUT = 64 * 1024;
const KIB = 1024;

export class MailboxQuotaInspectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailboxQuotaInspectorError';
    this.code = code;
  }
}

function bounded(value) {
  const output = String(value ?? '');
  if (Buffer.byteLength(output) > MAX_OUTPUT) {
    throw new MailboxQuotaInspectorError('mailbox_quota_usage_output_too_large', 'Mailbox quota usage output exceeded its bound');
  }
  return output.trim();
}

function integer(value, { nullable = false } = {}) {
  const normalized = String(value ?? '').trim();
  if (nullable && (normalized === '' || normalized === '-')) return null;
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function bytesFromKilobytes(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / KIB)) return undefined;
  return value * KIB;
}

export function parseDoveadmQuotaTab(value, mailboxAddress) {
  const output = bounded(value);
  if (!output) {
    throw new MailboxQuotaInspectorError('mailbox_quota_usage_invalid', 'Dovecot returned no mailbox quota usage');
  }
  const lines = output.split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
  if (lines.length < 2) {
    throw new MailboxQuotaInspectorError('mailbox_quota_usage_invalid', 'Dovecot mailbox quota usage output is incomplete');
  }
  const headers = lines[0].split('\t').map((entry) => entry.trim().toLowerCase());
  const typeIndex = headers.indexOf('type');
  const valueIndex = headers.indexOf('value');
  const limitIndex = headers.indexOf('limit');
  const percentIndex = headers.includes('%') ? headers.indexOf('%') : headers.indexOf('percent');
  if ([typeIndex, valueIndex, limitIndex, percentIndex].some((index) => index < 0)) {
    throw new MailboxQuotaInspectorError('mailbox_quota_usage_invalid', 'Dovecot mailbox quota usage columns are invalid');
  }

  let storage = null;
  for (const line of lines.slice(1)) {
    const columns = line.split('\t');
    if ((columns[typeIndex] ?? '').trim().toUpperCase() !== 'STORAGE') continue;
    if (storage !== null) {
      throw new MailboxQuotaInspectorError('mailbox_quota_usage_invalid', 'Dovecot returned multiple storage quota rows');
    }
    const usedKilobytes = integer(columns[valueIndex]);
    const limitKilobytes = integer(columns[limitIndex], { nullable: true });
    const percent = integer(columns[percentIndex], { nullable: true });
    const storageBytes = bytesFromKilobytes(usedKilobytes);
    const limitBytes = limitKilobytes === null ? null : bytesFromKilobytes(limitKilobytes);
    if (storageBytes === undefined || (limitKilobytes !== null && limitBytes === undefined)
      || percent === undefined || (percent !== null && (percent < 0 || percent > 1_000_000))) {
      throw new MailboxQuotaInspectorError('mailbox_quota_usage_invalid', 'Dovecot mailbox quota usage values are invalid');
    }
    storage = Object.freeze({ storageBytes, limitBytes, usagePercent: percent });
  }
  if (!storage) {
    throw new MailboxQuotaInspectorError('mailbox_quota_usage_unavailable', 'Dovecot did not report a storage quota row');
  }
  return Object.freeze({
    version: 1,
    address: normalizeMailboxAddress(mailboxAddress).address,
    ...storage,
    source: 'doveadm_quota',
    sideEffects: false,
  });
}

export function createMailboxQuotaInspector({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
} = {}) {
  if (typeof run !== 'function') {
    throw new MailboxQuotaInspectorError('mailbox_quota_inspector_dependency_invalid', 'Mailbox quota inspector dependency is invalid');
  }

  async function inspect(mailboxAddress) {
    let address;
    try { address = normalizeMailboxAddress(mailboxAddress).address; }
    catch {
      throw new MailboxQuotaInspectorError('mailbox_quota_address_invalid', 'Mailbox quota usage address is invalid');
    }
    let result;
    try {
      result = await run(DOVEADM, ['-f', 'tab', 'quota', 'get', '-u', address], {
        timeout: 15_000,
        maxBuffer: MAX_OUTPUT,
      });
      bounded(result?.stderr ?? '');
    } catch (error) {
      if (error instanceof MailboxQuotaInspectorError) throw error;
      throw new MailboxQuotaInspectorError('mailbox_quota_usage_failed', 'Dovecot mailbox quota usage could not be inspected');
    }
    return parseDoveadmQuotaTab(result?.stdout ?? result, address);
  }

  return Object.freeze({ inspect });
}

export const mailboxQuotaInspectorInternals = Object.freeze({
  doveadmPath: DOVEADM,
  maxOutput: MAX_OUTPUT,
  parseDoveadmQuotaTab,
});
