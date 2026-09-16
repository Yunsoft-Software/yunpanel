import {
  createPowerDnsZoneManager,
  PowerDnsZoneManagerError,
  powerDnsZoneManagerInternals,
} from './powerdns-zone-manager.js';

const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SUPPORTED_TYPES = new Set(['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV']);
const MAX_SERIAL = 4_294_967_295;

export class PowerDnsManualRrsetManagerError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'PowerDnsManualRrsetManagerError';
    this.code = code;
    this.status = status;
  }
}

function apiKey(value) {
  if (typeof value !== 'string' || !API_KEY_PATTERN.test(value)) {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_api_key_invalid', 'PowerDNS API key is invalid', 400);
  }
  return value;
}

function ownerWithinZone(owner, zoneName) {
  const normalizedOwner = String(owner ?? '').replace(/\.$/, '').toLowerCase();
  const normalizedZone = powerDnsZoneManagerInternals.zoneName(zoneName);
  if (!normalizedOwner || (normalizedOwner !== normalizedZone && !normalizedOwner.endsWith(`.${normalizedZone}`))) {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_owner_outside_zone', 'DNS record owner is outside the authoritative zone', 400);
  }
  return normalizedOwner;
}

function normalizeManualRecord(record, zoneName) {
  const fields = new Set(['owner', 'type', 'ttl', 'values']);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || typeof record.type !== 'string' || !SUPPORTED_TYPES.has(record.type.toUpperCase())
    || !Number.isSafeInteger(record.ttl) || record.ttl < 60 || record.ttl > 86400
    || !Array.isArray(record.values) || record.values.length < 1 || record.values.length > 16
    || record.values.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\r\n\u0000]/.test(value))) {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_record_invalid', 'Manual DNS RRset is invalid', 400);
  }
  return Object.freeze({
    owner: ownerWithinZone(record.owner, zoneName),
    type: record.type.toUpperCase(),
    ttl: record.ttl,
    values: Object.freeze(record.values.map((value) => value.trim())),
  });
}

function expectedSerial(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SERIAL) {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_expected_serial_invalid', 'Expected SOA serial is invalid', 400);
  }
  return value;
}

function assertExpectedSerial(zone, value) {
  const expected = expectedSerial(value);
  if (expected !== null && zone.serial !== expected) {
    throw new PowerDnsManualRrsetManagerError(
      'powerdns_manual_serial_conflict',
      'Authoritative zone changed; refresh DNS records before applying this mutation',
      409,
    );
  }
  return expected;
}

function desiredRrset(record) {
  return Object.freeze({
    name: powerDnsZoneManagerInternals.fqdn(record.owner),
    type: record.type,
    ttl: record.ttl,
    changetype: 'REPLACE',
    records: Object.freeze(record.values.map((value) => Object.freeze({
      content: powerDnsZoneManagerInternals.powerDnsContent(record.type, value),
      disabled: false,
    }))),
    comments: Object.freeze([]),
  });
}

function deleteRrset(current) {
  return Object.freeze({
    name: current.name,
    type: current.type,
    changetype: 'DELETE',
    records: Object.freeze([]),
    comments: Object.freeze([]),
  });
}

function nextSerial(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= MAX_SERIAL) {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_serial_exhausted', 'Authoritative SOA serial cannot be advanced safely', 409);
  }
  return value + 1;
}

function bumpSoaRrset(zone) {
  const zoneOwner = powerDnsZoneManagerInternals.fqdn(zone.zoneName).toLowerCase();
  const current = zone.rrsets.find((entry) => entry.name === zoneOwner && entry.type === 'SOA') ?? null;
  if (!current || current.records.length !== 1 || current.records[0].disabled === true) {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_soa_unavailable', 'Authoritative SOA record is unavailable for serial advancement', 409);
  }
  const parts = String(current.records[0].content).trim().split(/\s+/);
  if (parts.length !== 7) {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_soa_invalid', 'Authoritative SOA record is invalid', 409);
  }
  const observed = Number.parseInt(parts[2], 10);
  if (observed !== zone.serial) {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_soa_serial_invalid', 'Authoritative SOA serial evidence is inconsistent', 409);
  }
  const serial = nextSerial(observed);
  parts[2] = String(serial);
  return Object.freeze({
    serial,
    rrset: Object.freeze({
      name: current.name,
      type: 'SOA',
      ttl: current.ttl,
      changetype: 'REPLACE',
      records: Object.freeze([Object.freeze({ content: parts.join(' '), disabled: false })]),
      comments: current.comments,
    }),
  });
}

function unquoteSequence(value) {
  const input = String(value ?? '').trim();
  if (!input.startsWith('"')) return input;
  let result = '';
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) index += 1;
    if (index >= input.length) break;
    if (input[index] !== '"') return input;
    index += 1;
    let closed = false;
    while (index < input.length) {
      const character = input[index];
      if (character === '\\') {
        index += 1;
        if (index >= input.length) return input;
        result += input[index];
        index += 1;
        continue;
      }
      if (character === '"') {
        index += 1;
        closed = true;
        break;
      }
      result += character;
      index += 1;
    }
    if (!closed) return input;
    while (index < input.length && /\s/.test(input[index])) index += 1;
    if (index < input.length && input[index] !== '"') return input;
  }
  return result;
}

function stripDot(value) {
  return String(value ?? '').replace(/\.$/, '');
}

function canonicalContent(type, content) {
  const value = String(content ?? '').trim();
  if (type === 'NS' || type === 'CNAME') return stripDot(value);
  if (type === 'MX') {
    const [priority, target, ...rest] = value.split(/\s+/);
    return rest.length === 0 && priority && target ? `${priority} ${stripDot(target)}` : value;
  }
  if (type === 'SRV') {
    const [priority, weight, port, target, ...rest] = value.split(/\s+/);
    return rest.length === 0 && priority && weight && port && target
      ? `${priority} ${weight} ${port} ${stripDot(target)}`
      : value;
  }
  if (type === 'SOA') {
    const [primaryNs, rname, serial, refresh, retry, expire, minimum, ...rest] = value.split(/\s+/);
    return rest.length === 0 && primaryNs && rname && serial && refresh && retry && expire && minimum
      ? `${stripDot(primaryNs)} ${stripDot(rname)} ${serial} ${refresh} ${retry} ${expire} ${minimum}`
      : value;
  }
  if (type === 'TXT') return unquoteSequence(value);
  if (type === 'CAA') {
    const match = value.match(/^(\d+)\s+([a-z0-9-]+)\s+(.+)$/i);
    return match ? `${match[1]} ${match[2].toLowerCase()} ${unquoteSequence(match[3])}` : value;
  }
  return value;
}

function publicRrset(rrset) {
  return Object.freeze({
    owner: stripDot(rrset.name),
    type: rrset.type,
    ttl: rrset.ttl,
    source: rrset.managed?.source ?? 'manual',
    key: rrset.managed?.key ?? null,
    templateVersion: rrset.managed?.templateVersion ?? null,
    records: Object.freeze(rrset.records.map((entry) => Object.freeze({
      value: canonicalContent(rrset.type, entry.content),
      disabled: entry.disabled === true,
    }))),
  });
}

function publicZone(zone) {
  if (!zone) return null;
  return Object.freeze({
    zoneName: zone.zoneName,
    kind: zone.kind,
    dnssec: zone.dnssec,
    serial: zone.serial,
    notifiedSerial: zone.notifiedSerial ?? null,
    rrsets: Object.freeze(zone.rrsets.map(publicRrset)),
  });
}

function findRrset(zone, owner, type) {
  const key = `${powerDnsZoneManagerInternals.fqdn(owner).toLowerCase()}\u0000${type}`;
  return zone.rrsets.find((entry) => powerDnsZoneManagerInternals.rrsetKey(entry) === key) ?? null;
}

function assertManual(current) {
  if (current?.managed) {
    throw new PowerDnsManualRrsetManagerError(
      'powerdns_manual_managed_record_conflict',
      `DNS RRset is managed by YunPanel (${current.managed.source}/${current.managed.key})`,
      409,
    );
  }
}

function assertCnameCoexistence(zone, owner, type, current) {
  const siblings = zone.rrsets.filter((entry) => stripDot(entry.name) === owner && entry !== current);
  if ((type === 'CNAME' && siblings.length > 0)
    || (type !== 'CNAME' && siblings.some((entry) => entry.type === 'CNAME'))) {
    throw new PowerDnsManualRrsetManagerError(
      'powerdns_manual_cname_conflict',
      'CNAME owner cannot coexist with another DNS record type',
      409,
    );
  }
}

export function createPowerDnsManualRrsetManager({
  fetchFn = globalThis.fetch,
  apiAddress = '127.0.0.1',
  apiPort = 8081,
  serverName = 'localhost',
  zoneManager = null,
} = {}) {
  if (typeof fetchFn !== 'function' || typeof apiAddress !== 'string' || !apiAddress
    || !Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65535
    || typeof serverName !== 'string' || !serverName) {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_dependencies_invalid', 'PowerDNS manual RRset dependencies are invalid');
  }
  const zones = zoneManager ?? createPowerDnsZoneManager({ fetchFn, apiAddress, apiPort, serverName });
  if (!zones || typeof zones.getZone !== 'function') {
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_dependencies_invalid', 'PowerDNS zone inspection is unavailable');
  }
  const baseUrl = `http://${apiAddress}:${apiPort}/api/v1/servers/${encodeURIComponent(serverName)}`;

  async function patch(zoneName, rawApiKey, rrsets) {
    let response;
    try {
      response = await fetchFn(`${baseUrl}/zones/${encodeURIComponent(powerDnsZoneManagerInternals.fqdn(zoneName))}`, {
        method: 'PATCH',
        headers: {
          'X-API-Key': apiKey(rawApiKey),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rrsets }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PowerDnsManualRrsetManagerError('powerdns_manual_api_unavailable', 'PowerDNS zone API is unavailable');
    }
    if (!response.ok) {
      const status = response.status === 409 || response.status === 422 ? 409 : 503;
      throw new PowerDnsManualRrsetManagerError('powerdns_manual_api_failed', `PowerDNS zone API request failed with status ${response.status}`, status);
    }
  }

  async function inspectZone(zoneName, rawApiKey) {
    try { return await zones.getZone(zoneName, rawApiKey); }
    catch (error) {
      if (error instanceof PowerDnsZoneManagerError) {
        throw new PowerDnsManualRrsetManagerError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  async function inspectPostcondition(zoneName, rawApiKey) {
    try { return await inspectZone(zoneName, rawApiKey); }
    catch {
      throw new PowerDnsManualRrsetManagerError(
        'powerdns_manual_postcondition_unavailable',
        'DNS mutation result is uncertain because the authoritative zone cannot be re-inspected; refresh before retrying',
        503,
      );
    }
  }

  async function notify(zoneName, rawApiKey, enabled) {
    if (!enabled) return null;
    if (typeof zones.notifyZone !== 'function') {
      throw new PowerDnsManualRrsetManagerError(
        'powerdns_manual_notify_unavailable',
        'Secondary DNS is configured but PowerDNS NOTIFY support is unavailable',
        503,
      );
    }
    try { return await zones.notifyZone(zoneName, rawApiKey); }
    catch (error) {
      if (error instanceof PowerDnsZoneManagerError) {
        throw new PowerDnsManualRrsetManagerError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  async function getZone({ zoneName, apiKey: rawApiKey } = {}) {
    return publicZone(await inspectZone(zoneName, rawApiKey));
  }

  async function apply({
    zoneName,
    apiKey: rawApiKey,
    record,
    expectedSerial: rawExpectedSerial = null,
    notifySecondaries = false,
  } = {}) {
    const normalizedZone = powerDnsZoneManagerInternals.zoneName(zoneName);
    const normalized = normalizeManualRecord(record, normalizedZone);
    const zone = await inspectZone(normalizedZone, rawApiKey);
    if (!zone) throw new PowerDnsManualRrsetManagerError('powerdns_manual_zone_not_found', 'PowerDNS zone was not found', 404);
    assertExpectedSerial(zone, rawExpectedSerial);
    const current = findRrset(zone, normalized.owner, normalized.type);
    assertManual(current);
    assertCnameCoexistence(zone, normalized.owner, normalized.type, current);
    const wanted = desiredRrset(normalized);
    if (current && powerDnsZoneManagerInternals.sameRecords(current, wanted)) {
      return Object.freeze({ satisfied: true, changed: false, record: publicRrset(current), serial: zone.serial, notification: null });
    }
    const soa = bumpSoaRrset(zone);
    // Fail before the record mutation if this is an old Native zone that cannot safely notify configured secondaries.
    if (notifySecondaries) await notify(normalizedZone, rawApiKey, true);

    let mutationError = null;
    try { await patch(normalizedZone, rawApiKey, [wanted, soa.rrset]); }
    catch (error) { mutationError = error; }
    const after = await inspectPostcondition(normalizedZone, rawApiKey);
    const verified = after ? findRrset(after, normalized.owner, normalized.type) : null;
    if (verified && !verified.managed && powerDnsZoneManagerInternals.sameRecords(verified, wanted)
      && after.serial === soa.serial) {
      const notification = await notify(normalizedZone, rawApiKey, notifySecondaries);
      return Object.freeze({
        satisfied: true,
        changed: true,
        record: publicRrset(verified),
        serial: after.serial,
        notifiedSerial: notification?.notifiedSerial ?? after.notifiedSerial ?? null,
        notification,
      });
    }
    if (mutationError) throw mutationError;
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_apply_unverified', 'Manual DNS RRset apply could not be verified');
  }

  async function remove({
    zoneName,
    apiKey: rawApiKey,
    owner,
    type,
    expectedSerial: rawExpectedSerial = null,
    notifySecondaries = false,
  } = {}) {
    const normalizedZone = powerDnsZoneManagerInternals.zoneName(zoneName);
    const normalizedOwner = ownerWithinZone(owner, normalizedZone);
    const normalizedType = String(type ?? '').toUpperCase();
    if (!SUPPORTED_TYPES.has(normalizedType)) {
      throw new PowerDnsManualRrsetManagerError('powerdns_manual_record_type_invalid', 'DNS record type is invalid', 400);
    }
    const zone = await inspectZone(normalizedZone, rawApiKey);
    if (!zone) throw new PowerDnsManualRrsetManagerError('powerdns_manual_zone_not_found', 'PowerDNS zone was not found', 404);
    assertExpectedSerial(zone, rawExpectedSerial);
    const current = findRrset(zone, normalizedOwner, normalizedType);
    if (!current) return Object.freeze({ satisfied: true, changed: false, owner: normalizedOwner, type: normalizedType, serial: zone.serial, notification: null });
    assertManual(current);
    const soa = bumpSoaRrset(zone);
    if (notifySecondaries) await notify(normalizedZone, rawApiKey, true);

    let mutationError = null;
    try { await patch(normalizedZone, rawApiKey, [deleteRrset(current), soa.rrset]); }
    catch (error) { mutationError = error; }
    const after = await inspectPostcondition(normalizedZone, rawApiKey);
    if (after && !findRrset(after, normalizedOwner, normalizedType) && after.serial === soa.serial) {
      const notification = await notify(normalizedZone, rawApiKey, notifySecondaries);
      return Object.freeze({
        satisfied: true,
        changed: true,
        owner: normalizedOwner,
        type: normalizedType,
        serial: after.serial,
        notifiedSerial: notification?.notifiedSerial ?? after.notifiedSerial ?? null,
        notification,
      });
    }
    if (mutationError) throw mutationError;
    throw new PowerDnsManualRrsetManagerError('powerdns_manual_delete_unverified', 'Manual DNS RRset deletion could not be verified');
  }

  return Object.freeze({ getZone, apply, remove });
}

export const powerDnsManualRrsetManagerInternals = Object.freeze({
  ownerWithinZone,
  normalizeManualRecord,
  expectedSerial,
  assertExpectedSerial,
  desiredRrset,
  deleteRrset,
  nextSerial,
  bumpSoaRrset,
  unquoteSequence,
  canonicalContent,
  publicRrset,
  publicZone,
  findRrset,
  assertManual,
  assertCnameCoexistence,
});
