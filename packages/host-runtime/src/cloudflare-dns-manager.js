import { createHash } from 'node:crypto';
import { isIP, SocketAddress } from 'node:net';
import { normalizeDomainSet } from '@yunpanel/shared';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const PROVIDER_ID_PATTERN = /^[a-f0-9]{32}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,256}$/;
const RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME']);
const ACTIONS = new Set(['upsert', 'delete']);
const MAX_RESPONSE_CHARACTERS = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export class CloudflareDnsManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CloudflareDnsManagerError';
    this.code = code;
    this.status = code === 'dns_provider_rate_limited' || code === 'dns_provider_unavailable'
      ? 503
      : code === 'dns_provider_request_failed' || code === 'dns_provider_response_invalid'
        || code === 'dns_provider_mutation_unconfirmed'
        ? 502
        : code.startsWith('dns_provider_')
          ? 409
          : 400;
  }
}

function hostname(value, field) {
  try { return normalizeDomainSet(value, []).primary; }
  catch { throw new CloudflareDnsManagerError(`invalid_${field}`, `${field} must be a canonical DNS hostname`); }
}

function address(value, family) {
  if (isIP(value) !== family) {
    throw new CloudflareDnsManagerError('invalid_dns_record_content', `DNS ${family === 4 ? 'A' : 'AAAA'} content is invalid`);
  }
  return new SocketAddress({ address: value, family: family === 4 ? 'ipv4' : 'ipv6', port: 0 }).address;
}

function recordContent(type, value) {
  if (type === 'A') return address(value, 4);
  if (type === 'AAAA') return address(value, 6);
  return hostname(value, 'dns_record_content');
}

function normalizeRecord(value) {
  const fields = new Set(['type', 'name', 'content', 'ttl', 'proxied']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.type !== 'string' || !RECORD_TYPES.has(value.type.toUpperCase())
    || !Number.isInteger(value.ttl) || (value.ttl !== 1 && (value.ttl < 60 || value.ttl > 86_400))
    || typeof value.proxied !== 'boolean' || (value.proxied && value.ttl !== 1)) {
    throw new CloudflareDnsManagerError('invalid_dns_record', 'DNS record fields are invalid');
  }
  const type = value.type.toUpperCase();
  return Object.freeze({
    type,
    name: hostname(value.name, 'dns_record_name'),
    content: recordContent(type, value.content),
    ttl: value.ttl,
    proxied: value.proxied,
  });
}

function zoneContains(zoneName, recordName) {
  return recordName === zoneName || recordName.endsWith(`.${zoneName}`);
}

function normalizeCredential(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !UUID_PATTERN.test(value.id ?? '')
    || (expected.credentialId !== undefined && value.id.toLowerCase() !== expected.credentialId)
    || !UUID_PATTERN.test(value.dnsZoneId ?? '')
    || (expected.dnsZoneId !== undefined && value.dnsZoneId.toLowerCase() !== expected.dnsZoneId)
    || value.provider !== 'cloudflare' || !TOKEN_PATTERN.test(value.token ?? '')) {
    throw new CloudflareDnsManagerError('dns_provider_credential_invalid', 'DNS provider credential does not match the requested zone');
  }
  return Object.freeze({ token: value.token });
}

function normalizeApply(value) {
  const fields = new Set(['provider', 'credentialId', 'dnsZoneId', 'zoneName', 'action', 'record', 'expectedSnapshotDigest']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.provider !== 'cloudflare' || !UUID_PATTERN.test(value.credentialId ?? '')
    || !UUID_PATTERN.test(value.dnsZoneId ?? '') || !ACTIONS.has(value.action)
    || !SHA256_PATTERN.test(value.expectedSnapshotDigest ?? '')) {
    throw new CloudflareDnsManagerError('invalid_dns_record_operation', 'DNS record operation fields are invalid');
  }
  const zoneName = hostname(value.zoneName, 'dns_zone_name');
  const record = normalizeRecord(value.record);
  if (!zoneContains(zoneName, record.name)) {
    throw new CloudflareDnsManagerError('dns_record_outside_zone', 'DNS record name must stay inside the selected zone');
  }
  return Object.freeze({
    provider: 'cloudflare',
    credentialId: value.credentialId.toLowerCase(),
    dnsZoneId: value.dnsZoneId.toLowerCase(),
    zoneName,
    action: value.action,
    record,
    expectedSnapshotDigest: value.expectedSnapshotDigest,
  });
}

function normalizeInspect(value) {
  const fields = new Set(['provider', 'credentialId', 'dnsZoneId', 'zoneName', 'record']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.provider !== 'cloudflare' || !UUID_PATTERN.test(value.credentialId ?? '')
    || !UUID_PATTERN.test(value.dnsZoneId ?? '')) {
    throw new CloudflareDnsManagerError('invalid_dns_record_inspection', 'DNS record inspection fields are invalid');
  }
  const zoneName = hostname(value.zoneName, 'dns_zone_name');
  const record = normalizeRecord(value.record);
  if (!zoneContains(zoneName, record.name)) {
    throw new CloudflareDnsManagerError('dns_record_outside_zone', 'DNS record name must stay inside the selected zone');
  }
  return Object.freeze({
    provider: 'cloudflare',
    credentialId: value.credentialId.toLowerCase(),
    dnsZoneId: value.dnsZoneId.toLowerCase(),
    zoneName,
    record,
  });
}

function recordDigest(records) {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function sameRecord(left, right) {
  return left.type === right.type && left.name === right.name && left.content === right.content
    && left.ttl === right.ttl && left.proxied === right.proxied;
}

function publicSnapshot(zoneName, desired, records) {
  const publicRecords = records.map(({ id, ...record }) => Object.freeze(record));
  return Object.freeze({
    provider: 'cloudflare',
    zoneName,
    desired,
    records: Object.freeze(publicRecords),
    snapshotDigest: recordDigest(publicRecords),
  });
}

function providerError(response) {
  if (response?.status === 401 || response?.status === 403) {
    return new CloudflareDnsManagerError('dns_provider_unauthorized', 'DNS provider rejected the configured credential');
  }
  if (response?.status === 429) {
    return new CloudflareDnsManagerError('dns_provider_rate_limited', 'DNS provider rate limit was reached');
  }
  if (Number.isInteger(response?.status) && response.status >= 500) {
    return new CloudflareDnsManagerError('dns_provider_unavailable', 'DNS provider is temporarily unavailable');
  }
  return new CloudflareDnsManagerError('dns_provider_request_failed', 'DNS provider rejected the request');
}

export function createCloudflareDnsManager({
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchFn !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error('Cloudflare DNS manager dependencies are invalid');
  }

  async function apiRequest(pathname, { token, method = 'GET', body = null } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchFn(`${API_ROOT}${pathname}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === null ? {} : { 'content-type': 'application/json' }),
        },
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)
        || typeof response.text !== 'function') {
        throw new CloudflareDnsManagerError('dns_provider_response_invalid', 'DNS provider returned an invalid response');
      }
      let text;
      try { text = await response.text(); }
      catch { throw new CloudflareDnsManagerError('dns_provider_response_invalid', 'DNS provider response could not be read'); }
      if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARACTERS) {
        throw new CloudflareDnsManagerError('dns_provider_response_invalid', 'DNS provider response exceeded the supported limit');
      }
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new CloudflareDnsManagerError('dns_provider_response_invalid', 'DNS provider returned malformed JSON'); }
      if (!response.ok || payload?.success !== true) throw providerError(response);
      return payload.result;
    } catch (error) {
      if (error instanceof CloudflareDnsManagerError) throw error;
      throw new CloudflareDnsManagerError('dns_provider_unavailable', 'DNS provider could not be reached');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveZone(zoneName, credential) {
    const query = new URLSearchParams({ name: zoneName, status: 'active', match: 'all', per_page: '2' });
    const result = await apiRequest(`/zones?${query}`, credential);
    if (!Array.isArray(result) || result.length > 2) {
      throw new CloudflareDnsManagerError('dns_provider_response_invalid', 'DNS provider returned invalid zone metadata');
    }
    const matches = result.filter((zone) => zone && PROVIDER_ID_PATTERN.test(zone.id ?? '')
      && zone.name === zoneName && zone.status === 'active');
    if (matches.length === 0) throw new CloudflareDnsManagerError('dns_provider_zone_not_found', 'DNS provider zone was not found');
    if (matches.length !== 1 || matches.length !== result.length) {
      throw new CloudflareDnsManagerError('dns_provider_zone_ambiguous', 'DNS provider zone identity is ambiguous');
    }
    return matches[0].id;
  }

  async function recordsFor(zoneId, desired, credential) {
    const query = new URLSearchParams({ type: desired.type, name: desired.name, match: 'all', per_page: '3' });
    const result = await apiRequest(`/zones/${zoneId}/dns_records?${query}`, credential);
    if (!Array.isArray(result) || result.length > 3) {
      throw new CloudflareDnsManagerError('dns_provider_response_invalid', 'DNS provider returned invalid record metadata');
    }
    const records = result.map((record) => {
      if (!record || !PROVIDER_ID_PATTERN.test(record.id ?? '')) {
        throw new CloudflareDnsManagerError('dns_provider_response_invalid', 'DNS provider returned invalid record identity');
      }
      const normalized = normalizeRecord({
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied,
      });
      if (normalized.type !== desired.type || normalized.name !== desired.name) {
        throw new CloudflareDnsManagerError('dns_provider_response_invalid', 'DNS provider returned an unexpected record');
      }
      return Object.freeze({ id: record.id, ...normalized });
    });
    records.sort((left, right) => left.content.localeCompare(right.content)
      || left.ttl - right.ttl || Number(left.proxied) - Number(right.proxied) || left.id.localeCompare(right.id));
    return records;
  }

  async function privateSnapshot(input, credential) {
    const zoneId = await resolveZone(input.zoneName, credential);
    const records = await recordsFor(zoneId, input.record, credential);
    return { zoneId, records, public: publicSnapshot(input.zoneName, input.record, records) };
  }

  async function inspectRecord(value, { dnsCredential } = {}) {
    const input = normalizeInspect(value);
    const credential = normalizeCredential(dnsCredential, input);
    return (await privateSnapshot(input, credential)).public;
  }

  async function applyRecord(value, { dnsCredential } = {}) {
    const input = normalizeApply(value);
    const credential = normalizeCredential(dnsCredential, input);
    const before = await privateSnapshot(input, credential);
    const alreadyApplied = input.action === 'upsert'
      ? before.records.length === 1 && sameRecord(before.records[0], input.record)
      : before.records.length === 0;
    if (alreadyApplied) {
      return Object.freeze({
        provider: 'cloudflare', action: input.action, zoneName: input.zoneName,
        record: input.record, changed: false, state: input.action === 'upsert' ? 'present' : 'absent',
      });
    }
    if (before.public.snapshotDigest !== input.expectedSnapshotDigest) {
      throw new CloudflareDnsManagerError('dns_provider_snapshot_stale', 'DNS provider state changed after preview');
    }
    if (before.records.length > 1) {
      throw new CloudflareDnsManagerError('dns_provider_record_ambiguous', 'DNS provider has multiple matching records');
    }
    if (input.action === 'delete' && (before.records.length !== 1 || !sameRecord(before.records[0], input.record))) {
      throw new CloudflareDnsManagerError('dns_provider_record_mismatch', 'DNS provider record does not match the requested deletion');
    }

    const body = input.record;
    if (input.action === 'upsert') {
      const pathname = before.records.length === 0
        ? `/zones/${before.zoneId}/dns_records`
        : `/zones/${before.zoneId}/dns_records/${before.records[0].id}`;
      await apiRequest(pathname, { ...credential, method: before.records.length === 0 ? 'POST' : 'PUT', body });
    } else {
      await apiRequest(`/zones/${before.zoneId}/dns_records/${before.records[0].id}`, { ...credential, method: 'DELETE' });
    }

    const afterRecords = await recordsFor(before.zoneId, input.record, credential);
    const confirmed = input.action === 'upsert'
      ? afterRecords.length === 1 && sameRecord(afterRecords[0], input.record)
      : afterRecords.length === 0;
    if (!confirmed) {
      throw new CloudflareDnsManagerError('dns_provider_mutation_unconfirmed', 'DNS provider did not confirm the requested record state');
    }
    return Object.freeze({
      provider: 'cloudflare', action: input.action, zoneName: input.zoneName,
      record: input.record, changed: true, state: input.action === 'upsert' ? 'present' : 'absent',
    });
  }

  return Object.freeze({ inspectRecord, applyRecord });
}

export const cloudflareDnsManager = createCloudflareDnsManager();
export const cloudflareDnsManagerInternals = Object.freeze({
  apiRoot: API_ROOT,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxResponseCharacters: MAX_RESPONSE_CHARACTERS,
  normalizeRecord,
  normalizeInspect,
  normalizeApply,
  recordDigest,
  sameRecord,
  zoneContains,
});
