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

function parentName(domain) {
  const labels = domainName(domain).split('.');
  if (labels.length < 2) {
    throw new DnsParentDsInspectorError('dns_parent_ds_domain_invalid', 'DNSSEC parent domain is invalid', 400);
  }
  return labels.slice(1).join('.');
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

function authoritativeAnswer(stdout) {
  const match = String(stdout ?? '').match(/;; flags:\s*([^;]+);/);
  return Boolean(match && match[1].trim().split(/\s+/).includes('aa'));
}

function parseNameserverAnswers(stdout, parent) {
  const owner = `${parent}.`;
  const result = [];
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const parts = line.split(/\s+/);
    const nsIndex = parts.findIndex((entry) => entry.toUpperCase() === 'NS');
    if (nsIndex < 0 || nsIndex + 1 >= parts.length) continue;
    if (parts[0].toLowerCase() !== owner.toLowerCase()) continue;
    const target = String(parts[nsIndex + 1]).replace(/\.$/, '').toLowerCase();
    if (target) result.push(target);
  }
  return Object.freeze([...new Set(result)].sort());
}

function parseDsAnswerRows(stdout, domain) {
  const owner = `${domain}.`;
  const result = [];
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const parts = line.split(/\s+/);
    const dsIndex = parts.findIndex((entry) => entry.toUpperCase() === 'DS');
    if (dsIndex < 0 || dsIndex + 4 >= parts.length) continue;
    if (parts[0].toLowerCase() !== owner.toLowerCase()) continue;
    const ttl = Number.parseInt(parts[1], 10);
    const normalized = normalizeDs(parts.slice(dsIndex + 1, dsIndex + 5).join(' '));
    if (normalized && Number.isSafeInteger(ttl) && ttl >= 0 && ttl <= 2_147_483_647) {
      result.push(Object.freeze({ record: normalized, ttl }));
    }
  }
  return Object.freeze(result);
}

function parseDsAnswers(stdout, domain) {
  return Object.freeze([...new Set(parseDsAnswerRows(stdout, domain).map((entry) => entry.record))].sort());
}

async function defaultRunDig(args) {
  return execFileAsync('/usr/bin/dig', args, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
  });
}

function digError(error) {
  if (error?.code === 'ENOENT') {
    throw new DnsParentDsInspectorError(
      'dns_parent_ds_dig_missing',
      'bind9-dnsutils is required for parent DS inspection',
    );
  }
  return typeof error?.code === 'string' && error.code ? error.code : 'DIG_FAILED';
}

function outputFailure(stdout, { requireAuthoritative = false } = {}) {
  const dnsStatus = parseStatus(stdout);
  if (dnsStatus !== 'NOERROR') return dnsStatus ? `DNS_${dnsStatus}` : 'DIG_OUTPUT_INVALID';
  if (requireAuthoritative && !authoritativeAnswer(stdout)) return 'PARENT_NOT_AUTHORITATIVE';
  return null;
}

export function createDnsParentDsInspector({
  runDig = defaultRunDig,
  now = () => Date.now(),
} = {}) {
  if (typeof runDig !== 'function' || typeof now !== 'function') {
    throw new DnsParentDsInspectorError('dns_parent_ds_dependencies_invalid', 'Parent DS inspector dependencies are invalid');
  }

  function result(domain, status, records, ttl, errorCode, nameservers) {
    return Object.freeze({
      version: 3,
      domain,
      status,
      records: Object.freeze([...records]),
      ttl,
      nameservers: Object.freeze([...nameservers]),
      errorCode,
      checkedAt: new Date(now()).toISOString(),
    });
  }

  async function inspect({ domain } = {}) {
    const normalizedDomain = domainName(domain);
    const parent = parentName(normalizedDomain);
    let discoveryStdout;
    try {
      ({ stdout: discoveryStdout } = await runDig([
        '+time=2', '+tries=1', '+noall', '+comments', '+answer', 'NS', parent,
      ]));
    } catch (error) {
      return result(normalizedDomain, 'unverifiable', [], null, digError(error), []);
    }
    const discoveryFailure = outputFailure(discoveryStdout);
    if (discoveryFailure) return result(normalizedDomain, 'unverifiable', [], null, discoveryFailure, []);
    const nameservers = parseNameserverAnswers(discoveryStdout, parent);
    if (nameservers.length < 1) return result(normalizedDomain, 'unverifiable', [], null, 'PARENT_NS_MISSING', []);

    const observations = await Promise.all(nameservers.map(async (nameserver) => {
      try {
        const { stdout } = await runDig([
          `@${nameserver}`,
          '+time=2',
          '+tries=1',
          '+norecurse',
          '+noall',
          '+comments',
          '+answer',
          'DS',
          normalizedDomain,
        ]);
        const failure = outputFailure(stdout, { requireAuthoritative: true });
        if (failure) return Object.freeze({ nameserver, rows: Object.freeze([]), records: Object.freeze([]), errorCode: failure });
        const rows = parseDsAnswerRows(stdout, normalizedDomain);
        return Object.freeze({
          nameserver,
          rows,
          records: Object.freeze([...new Set(rows.map((entry) => entry.record))].sort()),
          errorCode: null,
        });
      } catch (error) {
        return Object.freeze({ nameserver, rows: Object.freeze([]), records: Object.freeze([]), errorCode: digError(error) });
      }
    }));

    const published = Object.freeze([...new Set(observations.flatMap((entry) => entry.records))].sort());
    if (published.length > 0) {
      const ttl = Math.max(...observations.flatMap((entry) => entry.rows).map((entry) => entry.ttl));
      return result(normalizedDomain, 'present', published, ttl, null, nameservers);
    }
    const failed = observations.find((entry) => entry.errorCode !== null);
    if (failed) {
      return result(
        normalizedDomain,
        'unverifiable',
        [],
        null,
        `PARENT_NS_${failed.errorCode}`,
        nameservers,
      );
    }
    return result(normalizedDomain, 'absent', [], null, null, nameservers);
  }

  return Object.freeze({ inspect });
}

export const dnsParentDsInspectorInternals = Object.freeze({
  domainName,
  parentName,
  normalizeDs,
  parseStatus,
  authoritativeAnswer,
  parseNameserverAnswers,
  parseDsAnswerRows,
  parseDsAnswers,
  defaultRunDig,
  digError,
  outputFailure,
});
