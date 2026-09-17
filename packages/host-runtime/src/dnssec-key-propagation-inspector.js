import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const DNSKEY_PATTERN = /^(\d{1,5}) (\d{1,3}) (\d{1,3}) ([A-Za-z0-9+/]+={0,2})$/;

export class DnssecKeyPropagationInspectorError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'DnssecKeyPropagationInspectorError';
    this.code = code;
    this.status = status;
  }
}

function zoneName(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) {
      throw new DnssecKeyPropagationInspectorError('dnssec_propagation_zone_invalid', 'DNSSEC propagation zone name is invalid', 400);
    }
    throw error;
  }
}

function serial(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4_294_967_295) {
    throw new DnssecKeyPropagationInspectorError('dnssec_propagation_serial_invalid', 'DNSSEC publication SOA serial is invalid', 409);
  }
  return value;
}

function dnskey(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  const match = normalized.match(DNSKEY_PATTERN);
  if (!match || Number.parseInt(match[1], 10) > 65535
    || Number.parseInt(match[2], 10) !== 3 || Number.parseInt(match[3], 10) > 255
    || match[4].length < 8 || match[4].length > 8192) {
    throw new DnssecKeyPropagationInspectorError('dnssec_propagation_key_invalid', 'DNSSEC propagation key is invalid', 400);
  }
  return normalized;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new DnssecKeyPropagationInspectorError('dnssec_propagation_time_invalid', `${field} is invalid`, 400);
  }
  return value;
}

function target(value, field) {
  if (typeof value !== 'string' || !isIP(value)) {
    throw new DnssecKeyPropagationInspectorError('dnssec_propagation_targets_invalid', `${field} must be an IP address`, 400);
  }
  return value;
}

function targets(primary, secondary) {
  const normalizedPrimary = target(primary, 'primaryTarget');
  if (!Array.isArray(secondary) || secondary.length > 8) {
    throw new DnssecKeyPropagationInspectorError('dnssec_propagation_targets_invalid', 'secondaryTargets are invalid', 400);
  }
  const normalizedSecondary = secondary.map((entry, index) => target(entry, `secondaryTargets[${index}]`));
  const all = [normalizedPrimary, ...normalizedSecondary];
  if (new Set(all).size !== all.length) {
    throw new DnssecKeyPropagationInspectorError('dnssec_propagation_targets_invalid', 'DNSSEC propagation targets must be unique', 400);
  }
  return Object.freeze({
    primary: normalizedPrimary,
    secondary: Object.freeze([...normalizedSecondary].sort()),
  });
}

function parseStatus(stdout) {
  const match = String(stdout ?? '').match(/status:\s*([A-Z]+)[,\s]/);
  return match?.[1] ?? null;
}

function authoritative(stdout) {
  const match = String(stdout ?? '').match(/flags:\s*([^;]+);/);
  return Boolean(match?.[1]?.split(/\s+/).includes('aa'));
}

function parseSoaSerial(stdout, domain) {
  const owner = `${domain}.`;
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    const soaIndex = parts.findIndex((entry) => entry.toUpperCase() === 'SOA');
    if (soaIndex < 0 || soaIndex + 3 >= parts.length || parts[0]?.toLowerCase() !== owner.toLowerCase()) continue;
    const observed = Number.parseInt(parts[soaIndex + 3], 10);
    if (Number.isSafeInteger(observed) && observed > 0 && observed <= 4_294_967_295) return observed;
  }
  return null;
}

function parseDnskeys(stdout, domain) {
  const owner = `${domain}.`;
  const records = [];
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    const keyIndex = parts.findIndex((entry) => entry.toUpperCase() === 'DNSKEY');
    if (keyIndex < 0 || keyIndex + 4 >= parts.length || parts[0]?.toLowerCase() !== owner.toLowerCase()) continue;
    const ttl = Number.parseInt(parts[1], 10);
    const record = parts.slice(keyIndex + 1).join(' ');
    if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 2_147_483_647 || !DNSKEY_PATTERN.test(record)) continue;
    records.push(Object.freeze({ record, ttl }));
  }
  return Object.freeze(records);
}

async function defaultRunDig(targetAddress, domain, recordType) {
  return execFileAsync('/usr/bin/dig', [
    `@${targetAddress}`,
    '+tcp',
    '+time=2',
    '+tries=1',
    '+norecurse',
    '+noall',
    '+comments',
    '+answer',
    recordType,
    domain,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
  });
}

function safeErrorCode(error) {
  if (error?.code === 'ENOENT') {
    throw new DnssecKeyPropagationInspectorError(
      'dnssec_propagation_dig_missing',
      'bind9-dnsutils is required for DNSSEC propagation inspection',
    );
  }
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : 'DIG_FAILED';
}

function outputFailure(stdout) {
  const status = parseStatus(stdout);
  if (status !== 'NOERROR') return status ? `DNS_${status}` : 'DIG_OUTPUT_INVALID';
  if (!authoritative(stdout)) return 'DNS_NOT_AUTHORITATIVE';
  return null;
}

export function createDnssecKeyPropagationInspector({
  runDig = defaultRunDig,
  now = () => Date.now(),
} = {}) {
  if (typeof runDig !== 'function' || typeof now !== 'function') {
    throw new DnssecKeyPropagationInspectorError('dnssec_propagation_dependencies_invalid', 'DNSSEC propagation inspector dependencies are invalid');
  }

  async function inspectTarget({ address, role, domain, expectedSerial, expectedDnskey }) {
    let soaStdout;
    let keyStdout;
    try {
      ({ stdout: soaStdout } = await runDig(address, domain, 'SOA'));
      ({ stdout: keyStdout } = await runDig(address, domain, 'DNSKEY'));
    } catch (error) {
      return Object.freeze({
        target: address,
        role,
        status: 'unverifiable',
        ready: false,
        expectedSerial,
        observedSerial: null,
        keyPresent: false,
        dnskeyTtl: null,
        errorCode: safeErrorCode(error),
      });
    }
    const soaFailure = outputFailure(soaStdout);
    const keyFailure = outputFailure(keyStdout);
    const observedSerial = parseSoaSerial(soaStdout, domain);
    const matchingKeys = parseDnskeys(keyStdout, domain).filter((entry) => entry.record === expectedDnskey);
    const dnskeyTtl = matchingKeys.length > 0 ? Math.max(...matchingKeys.map((entry) => entry.ttl)) : null;
    const errorCode = soaFailure ?? keyFailure
      ?? (observedSerial === null ? 'SOA_SERIAL_MISSING' : null);
    if (errorCode) {
      return Object.freeze({
        target: address,
        role,
        status: 'unverifiable',
        ready: false,
        expectedSerial,
        observedSerial,
        keyPresent: matchingKeys.length > 0,
        dnskeyTtl,
        errorCode,
      });
    }
    const serialCurrent = observedSerial === expectedSerial;
    const keyPresent = matchingKeys.length > 0;
    return Object.freeze({
      target: address,
      role,
      status: serialCurrent && keyPresent ? 'synced' : observedSerial !== expectedSerial ? 'serial_drift' : 'key_missing',
      ready: serialCurrent && keyPresent,
      expectedSerial,
      observedSerial,
      keyPresent,
      dnskeyTtl,
      errorCode: null,
    });
  }

  async function inspect({
    zoneName: rawZoneName,
    expectedSerial: rawExpectedSerial,
    expectedDnskey: rawExpectedDnskey,
    publishedAt: rawPublishedAt,
    primaryTarget,
    secondaryTargets,
  } = {}) {
    const domain = zoneName(rawZoneName);
    const expectedSerial = serial(rawExpectedSerial);
    const expectedDnskey = dnskey(rawExpectedDnskey);
    const publishedAt = timestamp(rawPublishedAt, 'publishedAt');
    const configuredTargets = targets(primaryTarget, secondaryTargets);
    const checkedAt = new Date(now()).toISOString();
    const inspected = Object.freeze(await Promise.all([
      inspectTarget({ address: configuredTargets.primary, role: 'primary', domain, expectedSerial, expectedDnskey }),
      ...configuredTargets.secondary.map((address) => inspectTarget({
        address, role: 'secondary', domain, expectedSerial, expectedDnskey,
      })),
    ]));
    const dnskeyTtl = inspected.every((entry) => entry.ready)
      ? Math.max(...inspected.map((entry) => entry.dnskeyTtl))
      : null;
    const eligibleAfter = dnskeyTtl === null
      ? null
      : new Date(Date.parse(publishedAt) + (dnskeyTtl * 1000)).toISOString();
    const ttlElapsed = eligibleAfter !== null && Date.parse(checkedAt) >= Date.parse(eligibleAfter);
    const status = inspected.some((entry) => entry.status === 'unverifiable')
      ? 'unverifiable'
      : inspected.some((entry) => entry.ready === false)
        ? 'drift'
        : !ttlElapsed
          ? 'waiting_ttl'
          : configuredTargets.secondary.length === 0 ? 'disabled' : 'synced';
    return Object.freeze({
      version: 1,
      zoneName: domain,
      status,
      ready: status === 'synced' || status === 'disabled',
      expectedSerial,
      dnskeyTtl,
      publishedAt,
      eligibleAfter,
      checkedAt,
      targets: inspected,
    });
  }

  return Object.freeze({ inspect });
}

export const dnssecKeyPropagationInspectorInternals = Object.freeze({
  zoneName,
  serial,
  dnskey,
  timestamp,
  target,
  targets,
  parseStatus,
  authoritative,
  parseSoaSerial,
  parseDnskeys,
  defaultRunDig,
  safeErrorCode,
  outputFailure,
});
