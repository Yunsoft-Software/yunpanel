import { execFile } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { isIP, SocketAddress } from 'node:net';
import { promisify } from 'node:util';
import { normalizeDomainSet } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const POSTCONF = '/usr/sbin/postconf';
const MAX_OUTPUT = 128 * 1024;
const MAX_RECORDS = 16;
const MAX_TXT_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 10_000;
const ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND', 'ENODOMAIN']);

export class MailDiagnosticsInspectorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDiagnosticsInspectorError';
    this.code = code;
    this.status = status;
  }
}

function canonicalHostname(value, code = 'mail_diagnostics_hostname_invalid') {
  try { return normalizeDomainSet(String(value ?? '').trim(), []).primary; }
  catch { throw new MailDiagnosticsInspectorError(code, 'Mail diagnostics hostname is invalid', 503); }
}

function canonicalAddress(value, family) {
  if (isIP(value) !== family) return null;
  return new SocketAddress({ address: value, family: family === 4 ? 'ipv4' : 'ipv6', port: 0 }).address;
}

function boundedText(value) {
  const text = String(value ?? '').trim();
  if (Buffer.byteLength(text) > MAX_OUTPUT) {
    throw new MailDiagnosticsInspectorError(
      'mail_diagnostics_output_too_large',
      'Mail diagnostics command output exceeded its bound',
      503,
    );
  }
  return text;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function normalizeMx(values) {
  if (!Array.isArray(values) || values.length > MAX_RECORDS) {
    throw new MailDiagnosticsInspectorError('mail_diagnostics_dns_invalid', 'DNS resolver returned an invalid MX set', 503);
  }
  const result = values.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !Number.isInteger(entry.priority) || entry.priority < 0 || entry.priority > 65_535) {
      throw new MailDiagnosticsInspectorError('mail_diagnostics_dns_invalid', 'DNS resolver returned invalid MX data', 503);
    }
    return Object.freeze({ priority: entry.priority, exchange: canonicalHostname(entry.exchange, 'mail_diagnostics_dns_invalid') });
  });
  result.sort((left, right) => left.priority - right.priority || left.exchange.localeCompare(right.exchange));
  return Object.freeze(result);
}

function normalizeTxt(values) {
  if (!Array.isArray(values) || values.length > MAX_RECORDS) {
    throw new MailDiagnosticsInspectorError('mail_diagnostics_dns_invalid', 'DNS resolver returned an invalid TXT set', 503);
  }
  const records = values.map((chunks) => {
    if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > 32
      || chunks.some((chunk) => typeof chunk !== 'string')) {
      throw new MailDiagnosticsInspectorError('mail_diagnostics_dns_invalid', 'DNS resolver returned invalid TXT data', 503);
    }
    const record = chunks.join('');
    if (Buffer.byteLength(record) > MAX_TXT_BYTES || /[\0\r\n]/.test(record)) {
      throw new MailDiagnosticsInspectorError('mail_diagnostics_dns_invalid', 'DNS resolver returned invalid TXT data', 503);
    }
    return record;
  });
  return Object.freeze(uniqueSorted(records));
}

function normalizeAddresses(values, family) {
  if (!Array.isArray(values) || values.length > MAX_RECORDS) {
    throw new MailDiagnosticsInspectorError('mail_diagnostics_dns_invalid', 'DNS resolver returned an invalid address set', 503);
  }
  const result = values.map((value) => canonicalAddress(value, family));
  if (result.some((value) => value === null)) {
    throw new MailDiagnosticsInspectorError('mail_diagnostics_dns_invalid', 'DNS resolver returned invalid address data', 503);
  }
  return Object.freeze(uniqueSorted(result));
}

function normalizeReverse(values) {
  if (!Array.isArray(values) || values.length > MAX_RECORDS) {
    throw new MailDiagnosticsInspectorError('mail_diagnostics_dns_invalid', 'DNS resolver returned an invalid PTR set', 503);
  }
  return Object.freeze(uniqueSorted(values.map((value) => canonicalHostname(value, 'mail_diagnostics_dns_invalid'))));
}

async function resolveOptional(resolve, normalize, timeoutMs) {
  let timeout;
  try {
    const value = await Promise.race([
      Promise.resolve().then(resolve),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error('mail diagnostics resolver timeout'), { code: 'ETIMEOUT' })), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    return Object.freeze({ state: 'resolved', records: normalize(value) });
  } catch (error) {
    let code = null;
    try { code = error?.code ?? null; } catch {}
    if (typeof code === 'string' && ABSENT_CODES.has(code)) {
      return Object.freeze({ state: 'absent', records: Object.freeze([]) });
    }
    return Object.freeze({ state: 'resolver_error', records: Object.freeze([]) });
  } finally {
    clearTimeout(timeout);
  }
}

function recordDiagnostic({ expected, current, state, reasonCode = null, action = null }) {
  return Object.freeze({
    expected,
    current,
    state,
    reasonCode,
    action,
  });
}

function inspectMx(mailHostname, resolution) {
  if (resolution.state === 'resolver_error') {
    return recordDiagnostic({
      expected: Object.freeze({ exchange: mailHostname, priority: null }),
      current: resolution.records,
      state: 'resolver_error',
      reasonCode: 'mail_mx_resolver_unavailable',
      action: 'retry_mail_dns_diagnostics',
    });
  }
  if (resolution.records.length === 0) {
    return recordDiagnostic({
      expected: Object.freeze({ exchange: mailHostname, priority: null }),
      current: resolution.records,
      state: 'missing',
      reasonCode: 'mail_mx_missing',
      action: 'publish_mail_mx_record',
    });
  }
  const matched = resolution.records.some((entry) => entry.exchange === mailHostname);
  return recordDiagnostic({
    expected: Object.freeze({ exchange: mailHostname, priority: null }),
    current: resolution.records,
    state: matched ? 'ready' : 'target_mismatch',
    reasonCode: matched ? null : 'mail_mx_target_mismatch',
    action: matched ? null : 'point_mail_mx_to_managed_hostname',
  });
}

function inspectVersionedTxt(resolution, { prefix, missingReason, multipleReason, missingAction, multipleAction }) {
  if (resolution.state === 'resolver_error') {
    return recordDiagnostic({
      expected: Object.freeze({ singleRecord: true }),
      current: Object.freeze([]),
      state: 'resolver_error',
      reasonCode: 'mail_txt_resolver_unavailable',
      action: 'retry_mail_dns_diagnostics',
    });
  }
  const records = Object.freeze(resolution.records.filter((record) => record.toLowerCase().startsWith(prefix)));
  if (records.length === 0) {
    return recordDiagnostic({
      expected: Object.freeze({ singleRecord: true }),
      current: records,
      state: 'missing',
      reasonCode: missingReason,
      action: missingAction,
    });
  }
  if (records.length > 1) {
    return recordDiagnostic({
      expected: Object.freeze({ singleRecord: true }),
      current: records,
      state: 'multiple',
      reasonCode: multipleReason,
      action: multipleAction,
    });
  }
  return recordDiagnostic({
    expected: Object.freeze({ singleRecord: true }),
    current: records,
    state: 'present',
  });
}

async function inspectPtr(mailHostname, addressResolutions, reverse, timeoutMs) {
  if (addressResolutions.some((entry) => entry.state === 'resolver_error')) {
    return recordDiagnostic({
      expected: Object.freeze({ hostname: mailHostname }),
      current: Object.freeze([]),
      state: 'resolver_error',
      reasonCode: 'mail_ptr_address_resolver_unavailable',
      action: 'retry_mail_dns_diagnostics',
    });
  }
  const addresses = uniqueSorted(addressResolutions.flatMap((entry) => entry.records));
  if (addresses.length === 0) {
    return recordDiagnostic({
      expected: Object.freeze({ hostname: mailHostname }),
      current: Object.freeze([]),
      state: 'mail_hostname_address_missing',
      reasonCode: 'mail_hostname_address_missing',
      action: 'publish_mail_hostname_address',
    });
  }
  const observations = Object.freeze(await Promise.all(addresses.map(async (address) => {
    const resolved = await resolveOptional(() => reverse(address), normalizeReverse, timeoutMs);
    const matched = resolved.records.includes(mailHostname);
    return Object.freeze({
      address,
      names: resolved.records,
      state: resolved.state === 'resolver_error'
        ? 'resolver_error'
        : resolved.records.length === 0
          ? 'missing'
          : matched ? 'ready' : 'target_mismatch',
    });
  })));
  const resolverError = observations.some((entry) => entry.state === 'resolver_error');
  const missing = observations.some((entry) => entry.state === 'missing');
  const mismatch = observations.some((entry) => entry.state === 'target_mismatch');
  return recordDiagnostic({
    expected: Object.freeze({ hostname: mailHostname }),
    current: observations,
    state: resolverError ? 'resolver_error' : missing ? 'missing' : mismatch ? 'target_mismatch' : 'ready',
    reasonCode: resolverError
      ? 'mail_ptr_resolver_unavailable'
      : missing ? 'mail_ptr_missing' : mismatch ? 'mail_ptr_target_mismatch' : null,
    action: resolverError
      ? 'retry_mail_dns_diagnostics'
      : missing || mismatch ? 'configure_ptr_with_server_provider' : null,
  });
}

function issueSummary(diagnostics) {
  return Object.freeze(Object.entries(diagnostics)
    .filter(([, diagnostic]) => diagnostic.reasonCode !== null)
    .map(([kind, diagnostic]) => Object.freeze({
      kind,
      reasonCode: diagnostic.reasonCode,
      action: diagnostic.action,
    })));
}

export function createMailDiagnosticsInspector({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
  resolveMx = dns.resolveMx,
  resolveTxt = dns.resolveTxt,
  resolve4 = dns.resolve4,
  resolve6 = dns.resolve6,
  reverse = dns.reverse,
  resolutionTimeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof run !== 'function' || typeof resolveMx !== 'function' || typeof resolveTxt !== 'function'
    || typeof resolve4 !== 'function' || typeof resolve6 !== 'function' || typeof reverse !== 'function'
    || !Number.isInteger(resolutionTimeoutMs) || resolutionTimeoutMs < 100 || resolutionTimeoutMs > 30_000
    || typeof now !== 'function') {
    throw new MailDiagnosticsInspectorError('mail_diagnostics_dependencies_invalid', 'Mail diagnostics dependencies are invalid', 503);
  }

  async function managedMailHostname() {
    try {
      const result = await run(POSTCONF, ['-h', 'myhostname'], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      boundedText(result?.stderr ?? '');
      return canonicalHostname(boundedText(result?.stdout ?? result));
    } catch (error) {
      if (error instanceof MailDiagnosticsInspectorError) throw error;
      throw new MailDiagnosticsInspectorError(
        'mail_diagnostics_hostname_unavailable',
        'Managed Postfix hostname could not be inspected',
        503,
      );
    }
  }

  async function inspect(domainName) {
    const domain = canonicalHostname(domainName, 'mail_diagnostics_domain_invalid');
    const mailHostname = await managedMailHostname();
    const [mx, txt, dmarc, ipv4, ipv6] = await Promise.all([
      resolveOptional(() => resolveMx(domain), normalizeMx, resolutionTimeoutMs),
      resolveOptional(() => resolveTxt(domain), normalizeTxt, resolutionTimeoutMs),
      resolveOptional(() => resolveTxt(`_dmarc.${domain}`), normalizeTxt, resolutionTimeoutMs),
      resolveOptional(() => resolve4(mailHostname), (values) => normalizeAddresses(values, 4), resolutionTimeoutMs),
      resolveOptional(() => resolve6(mailHostname), (values) => normalizeAddresses(values, 6), resolutionTimeoutMs),
    ]);
    const diagnostics = Object.freeze({
      mx: inspectMx(mailHostname, mx),
      spf: inspectVersionedTxt(txt, {
        prefix: 'v=spf1',
        missingReason: 'mail_spf_missing',
        multipleReason: 'mail_spf_multiple',
        missingAction: 'publish_spf_policy',
        multipleAction: 'consolidate_spf_records',
      }),
      dkim: recordDiagnostic({
        expected: null,
        current: Object.freeze({ selector: null, records: Object.freeze([]) }),
        state: 'not_configured',
        reasonCode: 'mail_dkim_not_configured',
        action: 'configure_dkim_signing',
      }),
      dmarc: inspectVersionedTxt(dmarc, {
        prefix: 'v=dmarc1;',
        missingReason: 'mail_dmarc_missing',
        multipleReason: 'mail_dmarc_multiple',
        missingAction: 'publish_dmarc_policy',
        multipleAction: 'consolidate_dmarc_records',
      }),
      ptr: await inspectPtr(mailHostname, [ipv4, ipv6], reverse, resolutionTimeoutMs),
    });
    const issues = issueSummary(diagnostics);
    return Object.freeze({
      version: 1,
      domainName: domain,
      mailHostname,
      observedAt: new Date(now()).toISOString(),
      diagnostics,
      attentionRequired: issues.length > 0,
      issues,
      sideEffects: false,
    });
  }

  return Object.freeze({ inspect });
}

export const mailDiagnosticsInspectorInternals = Object.freeze({
  maxOutput: MAX_OUTPUT,
  maxRecords: MAX_RECORDS,
  maxTxtBytes: MAX_TXT_BYTES,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  normalizeMx,
  normalizeTxt,
  normalizeAddresses,
  normalizeReverse,
  resolveOptional,
  inspectMx,
  inspectVersionedTxt,
  inspectPtr,
});
