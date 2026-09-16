import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const DS_PATTERN = /^(\d{1,5})\s+(\d{1,3})\s+(\d{1,3})\s+([A-Fa-f0-9]+)$/;

export class DnsParentDsInspectorError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'DnsParentDsInspectorError';
    this.code = code;
    this.status = status;
  }
}

function domainName(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) {
      throw new DnsParentDsInspectorError('dns_parent_ds_domain_invalid', 'DNSSEC parent domain is invalid', 400);
    }
    throw error;
  }
}

function normalizeDs(value) {
  const match = typeof value === 'string' ? value.trim().match(DS_PATTERN) : null;
  if (!match) return null;
  const keyTag = Number.parseInt(match[1], 10);
  const algorithm = Number.parseInt(match[2], 10);
  const digestType = Number.parseInt(match[3], 10);
  const digest = match[4].toUpperCase();
  if (keyTag > 65535 || algorithm > 255 || digestType > 255 || digest.length < 2 || digest.length % 2 !== 0) return null;
  return `${keyTag} ${algorithm} ${digestType} ${digest}`;
}

function parseStatus(stdout) {
  const match = String(stdout ?? '').match(/status:\s*([A-Z]+)[,\s]/);
  return match?.[1] ?? null;
}

function parseDsAnswers(stdout, domain) {
  const owner = `${domain}.`;
  const result = [];
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const parts = line.split(/\s+/);
    const dsIndex = parts.findIndex((entry) => entry.toUpperCase() === 'DS');
    if (dsIndex < 0 || dsIndex + 4 >= parts.length) continue;
    if (parts[0].toLowerCase() !== owner.toLowerCase()) continue;
    const normalized = normalizeDs(parts.slice(dsIndex + 1, dsIndex + 5).join(' '));
    if (normalized) result.push(normalized);
  }
  return Object.freeze([...new Set(result)].sort());
}

async function defaultRunDig(domain) {
  return execFileAsync('/usr/bin/dig', [
    '+time=2',
    '+tries=1',
    '+noall',
    '+comments',
    '+answer',
    'DS',
    domain,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
  });
}

export function createDnsParentDsInspector({
  runDig = defaultRunDig,
  now = () => Date.now(),
} = {}) {
  if (typeof runDig !== 'function' || typeof now !== 'function') {
    throw new DnsParentDsInspectorError('dns_parent_ds_dependencies_invalid', 'Parent DS inspector dependencies are invalid');
  }

  async function inspect({ domain } = {}) {
    const normalizedDomain = domainName(domain);
    let stdout;
    try {
      ({ stdout } = await runDig(normalizedDomain));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new DnsParentDsInspectorError(
          'dns_parent_ds_dig_missing',
          'bind9-dnsutils is required for parent DS inspection',
        );
      }
      return Object.freeze({
        version: 1,
        domain: normalizedDomain,
        status: 'unverifiable',
        records: Object.freeze([]),
        errorCode: typeof error?.code === 'string' && error.code ? error.code : 'DIG_FAILED',
        checkedAt: new Date(now()).toISOString(),
      });
    }

    const dnsStatus = parseStatus(stdout);
    if (dnsStatus !== 'NOERROR') {
      return Object.freeze({
        version: 1,
        domain: normalizedDomain,
        status: 'unverifiable',
        records: Object.freeze([]),
        errorCode: dnsStatus ? `DNS_${dnsStatus}` : 'DIG_OUTPUT_INVALID',
        checkedAt: new Date(now()).toISOString(),
      });
    }
    const records = parseDsAnswers(stdout, normalizedDomain);
    return Object.freeze({
      version: 1,
      domain: normalizedDomain,
      status: records.length > 0 ? 'present' : 'absent',
      records,
      errorCode: null,
      checkedAt: new Date(now()).toISOString(),
    });
  }

  return Object.freeze({ inspect });
}

export const dnsParentDsInspectorInternals = Object.freeze({
  domainName,
  normalizeDs,
  parseStatus,
  parseDsAnswers,
  defaultRunDig,
});
