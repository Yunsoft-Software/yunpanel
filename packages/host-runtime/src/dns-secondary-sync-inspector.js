import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);

export class DnsSecondarySyncInspectorError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'DnsSecondarySyncInspectorError';
    this.code = code;
    this.status = status;
  }
}

function zoneName(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) {
      throw new DnsSecondarySyncInspectorError('dns_secondary_zone_invalid', 'Secondary DNS zone name is invalid', 400);
    }
    throw error;
  }
}

function serial(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4_294_967_295) {
    throw new DnsSecondarySyncInspectorError('dns_secondary_serial_invalid', 'Primary SOA serial is invalid', 409);
  }
  return value;
}

function targets(value) {
  if (!Array.isArray(value) || value.length > 8 || value.some((entry) => typeof entry !== 'string' || !isIP(entry))) {
    throw new DnsSecondarySyncInspectorError('dns_secondary_targets_invalid', 'Secondary DNS targets are invalid', 400);
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) {
    throw new DnsSecondarySyncInspectorError('dns_secondary_targets_invalid', 'Secondary DNS targets must be unique', 400);
  }
  return Object.freeze(unique.sort());
}

function parseStatus(stdout) {
  const match = String(stdout ?? '').match(/status:\s*([A-Z]+)[,\s]/);
  return match?.[1] ?? null;
}

function authoritative(stdout) {
  const match = String(stdout ?? '').match(/flags:\s*([^;]+);/);
  return Boolean(match?.[1]?.split(/\s+/).includes('aa'));
}

function parseSoaSerial(stdout, normalizedZone) {
  const owner = `${normalizedZone}.`;
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const parts = line.split(/\s+/);
    const soaIndex = parts.findIndex((entry) => entry.toUpperCase() === 'SOA');
    if (soaIndex < 0 || soaIndex + 3 >= parts.length) continue;
    if (parts[0].toLowerCase() !== owner.toLowerCase()) continue;
    const observed = Number.parseInt(parts[soaIndex + 3], 10);
    if (Number.isSafeInteger(observed) && observed > 0 && observed <= 4_294_967_295) return observed;
  }
  return null;
}

async function defaultRunDig(target, domain) {
  return execFileAsync('/usr/bin/dig', [
    `@${target}`,
    '+tcp',
    '+time=2',
    '+tries=1',
    '+norecurse',
    '+noall',
    '+comments',
    '+answer',
    'SOA',
    domain,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
  });
}

function stateForSerial(observedSerial, expectedSerial) {
  if (observedSerial === expectedSerial) return 'synced';
  if (observedSerial < expectedSerial) return 'stale';
  return 'ahead';
}

export function createDnsSecondarySyncInspector({
  runDig = defaultRunDig,
  now = () => Date.now(),
} = {}) {
  if (typeof runDig !== 'function' || typeof now !== 'function') {
    throw new DnsSecondarySyncInspectorError('dns_secondary_dependencies_invalid', 'Secondary DNS inspector dependencies are invalid');
  }

  async function inspectOne(target, domain, expectedSerial) {
    let stdout;
    try { ({ stdout } = await runDig(target, domain)); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        throw new DnsSecondarySyncInspectorError('dns_secondary_dig_missing', 'bind9-dnsutils is required for secondary DNS inspection');
      }
      return Object.freeze({
        target,
        status: 'unverifiable',
        ready: false,
        expectedSerial,
        observedSerial: null,
        errorCode: typeof error?.code === 'string' && error.code ? error.code : 'DIG_FAILED',
      });
    }
    const dnsStatus = parseStatus(stdout);
    const aa = authoritative(stdout);
    const observedSerial = parseSoaSerial(stdout, domain);
    if (dnsStatus !== 'NOERROR' || !aa || observedSerial === null) {
      return Object.freeze({
        target,
        status: 'unverifiable',
        ready: false,
        expectedSerial,
        observedSerial,
        errorCode: dnsStatus !== 'NOERROR'
          ? (dnsStatus ? `DNS_${dnsStatus}` : 'DIG_OUTPUT_INVALID')
          : !aa ? 'DNS_NOT_AUTHORITATIVE' : 'SOA_SERIAL_MISSING',
      });
    }
    const status = stateForSerial(observedSerial, expectedSerial);
    return Object.freeze({
      target,
      status,
      ready: status === 'synced',
      expectedSerial,
      observedSerial,
      errorCode: null,
    });
  }

  async function inspect({ zoneName: rawZoneName, expectedSerial: rawExpectedSerial, targets: rawTargets } = {}) {
    const domain = zoneName(rawZoneName);
    const expectedSerial = serial(rawExpectedSerial);
    const configuredTargets = targets(rawTargets);
    const checkedAt = new Date(now()).toISOString();
    if (configuredTargets.length === 0) {
      return Object.freeze({
        version: 1,
        zoneName: domain,
        status: 'disabled',
        ready: true,
        expectedSerial,
        targets: Object.freeze([]),
        checkedAt,
      });
    }
    const inspected = Object.freeze(await Promise.all(
      configuredTargets.map((target) => inspectOne(target, domain, expectedSerial)),
    ));
    const status = inspected.every((entry) => entry.status === 'synced')
      ? 'synced'
      : inspected.some((entry) => entry.status === 'unverifiable')
        ? 'unverifiable'
        : 'drift';
    return Object.freeze({
      version: 1,
      zoneName: domain,
      status,
      ready: status === 'synced',
      expectedSerial,
      targets: inspected,
      checkedAt,
    });
  }

  return Object.freeze({ inspect });
}

export const dnsSecondarySyncInspectorInternals = Object.freeze({
  zoneName,
  serial,
  targets,
  parseStatus,
  authoritative,
  parseSoaSerial,
  stateForSerial,
  defaultRunDig,
});
