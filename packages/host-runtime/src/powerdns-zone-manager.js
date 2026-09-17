import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COMMENT_PREFIX = 'yunpanel:v1:';
const SUPPORTED_TYPES = new Set(['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV']);
const PRIMARY_KINDS = new Set(['Primary', 'Master']);

export class PowerDnsZoneManagerError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'PowerDnsZoneManagerError';
    this.code = code;
    this.status = status;
  }
}

function zoneName(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) {
      throw new PowerDnsZoneManagerError('powerdns_zone_name_invalid', 'PowerDNS zone name is invalid', 400);
    }
    throw error;
  }
}

function apiKey(value) {
  if (typeof value !== 'string' || !API_KEY_PATTERN.test(value)) {
    throw new PowerDnsZoneManagerError('powerdns_zone_api_key_invalid', 'PowerDNS API key is invalid', 400);
  }
  return value;
}

function fqdn(value) {
  return `${String(value).replace(/\.$/, '')}.`;
}

function escapeQuoted(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function txtChunks(value) {
  const chunks = [];
  let current = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 240 && current) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function powerDnsContent(type, value) {
  if (type === 'NS' || type === 'CNAME') return fqdn(value);
  if (type === 'MX') {
    const [priority, target] = value.split(/\s+/);
    return `${priority} ${fqdn(target)}`;
  }
  if (type === 'SRV') {
    const [priority, weight, port, target] = value.split(/\s+/);
    return `${priority} ${weight} ${port} ${fqdn(target)}`;
  }
  if (type === 'SOA') {
    const [primaryNs, rname, serial, refresh, retry, expire, minimum] = value.split(/\s+/);
    return `${fqdn(primaryNs)} ${fqdn(rname)} ${serial} ${refresh} ${retry} ${expire} ${minimum}`;
  }
  if (type === 'TXT') {
    return txtChunks(value).map((chunk) => `"${escapeQuoted(chunk)}"`).join(' ');
  }
  if (type === 'CAA') {
    const match = value.match(/^(\d+)\s+([a-z0-9-]+)\s+(.+)$/i);
    if (!match) throw new PowerDnsZoneManagerError('powerdns_zone_record_invalid', 'CAA record value is invalid', 400);
    const raw = match[3].replace(/^"|"$/g, '');
    return `${match[1]} ${match[2]} "${escapeQuoted(raw)}"`;
  }
  return value;
}

function recordMetadata(record) {
  return Object.freeze({
    source: record.source,
    key: record.key,
    templateVersion: record.templateVersion ?? null,
  });
}

function commentFor(record) {
  const encoded = Buffer.from(JSON.stringify(recordMetadata(record))).toString('base64url');
  return Object.freeze({ content: `${COMMENT_PREFIX}${encoded}`, account: 'yunpanel' });
}

function parseManagedComment(comments) {
  if (!Array.isArray(comments)) return null;
  for (const comment of comments) {
    if (comment?.account !== 'yunpanel' || typeof comment.content !== 'string' || !comment.content.startsWith(COMMENT_PREFIX)) continue;
    try {
      const decoded = JSON.parse(Buffer.from(comment.content.slice(COMMENT_PREFIX.length), 'base64url').toString('utf8'));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
        || typeof decoded.source !== 'string' || typeof decoded.key !== 'string') continue;
      return Object.freeze({
        source: decoded.source,
        key: decoded.key,
        templateVersion: Number.isSafeInteger(decoded.templateVersion) ? decoded.templateVersion : null,
      });
    } catch {
      // Ignore malformed comments and treat the RRset as manually owned.
    }
  }
  return null;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.owner !== 'string' || !record.owner
    || typeof record.type !== 'string' || !SUPPORTED_TYPES.has(record.type.toUpperCase())
    || !Number.isSafeInteger(record.ttl) || record.ttl < 60 || record.ttl > 86400
    || !Array.isArray(record.values) || record.values.length < 1
    || typeof record.key !== 'string' || !record.key
    || !['template', 'mail', 'runtime'].includes(record.source)) {
    throw new PowerDnsZoneManagerError('powerdns_zone_record_invalid', 'PowerDNS managed record is invalid', 400);
  }
  const type = record.type.toUpperCase();
  return Object.freeze({
    owner: record.owner.replace(/\.$/, '').toLowerCase(),
    type,
    ttl: record.ttl,
    values: Object.freeze(record.values.map((value) => String(value))),
    key: record.key,
    source: record.source,
    templateVersion: Number.isSafeInteger(record.templateVersion) ? record.templateVersion : null,
  });
}

function desiredRrset(record) {
  const normalized = normalizeRecord(record);
  return Object.freeze({
    name: fqdn(normalized.owner),
    type: normalized.type,
    ttl: normalized.ttl,
    changetype: 'REPLACE',
    records: Object.freeze(normalized.values.map((value) => Object.freeze({
      content: powerDnsContent(normalized.type, value),
      disabled: false,
    }))),
    comments: Object.freeze([commentFor(normalized)]),
  });
}

function rrsetKey(rrset) {
  return `${String(rrset?.name ?? '').toLowerCase()}\u0000${String(rrset?.type ?? '').toUpperCase()}`;
}

function normalizedExistingRrset(rrset) {
  if (!rrset || typeof rrset !== 'object' || typeof rrset.name !== 'string' || typeof rrset.type !== 'string') return null;
  return Object.freeze({
    name: rrset.name.toLowerCase(),
    type: rrset.type.toUpperCase(),
    ttl: Number.isSafeInteger(rrset.ttl) ? rrset.ttl : null,
    records: Object.freeze(Array.isArray(rrset.records)
      ? rrset.records.map((entry) => Object.freeze({ content: String(entry?.content ?? ''), disabled: entry?.disabled === true }))
      : []),
    comments: Object.freeze(Array.isArray(rrset.comments) ? rrset.comments.map((entry) => Object.freeze({ ...entry })) : []),
    managed: parseManagedComment(rrset.comments),
  });
}

function sameRecords(left, right) {
  if (left.ttl !== right.ttl) return false;
  const a = left.records.map((entry) => `${entry.disabled ? '1' : '0'}\u0000${entry.content}`).sort();
  const b = right.records.map((entry) => `${entry.disabled ? '1' : '0'}\u0000${entry.content}`).sort();
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameManagedMetadata(current, wanted) {
  if (!current?.managed) return false;
  const desired = parseManagedComment(wanted?.comments);
  return Boolean(desired
    && current.managed.source === desired.source
    && current.managed.key === desired.key
    && current.managed.templateVersion === desired.templateVersion);
}

function rrsetState(rrset) {
  return Object.freeze({
    name: rrset.name,
    type: rrset.type,
    ttl: rrset.ttl,
    records: Object.freeze(rrset.records
      .map((entry) => `${entry.disabled ? '1' : '0'}\u0000${entry.content}`)
      .sort()),
    comments: Object.freeze(rrset.comments
      .map((entry) => `${String(entry.account ?? '')}\u0000${String(entry.content ?? '')}`)
      .sort()),
  });
}

function sameZoneState(left, right) {
  if (!left || !right || left.id !== right.id || left.kind !== right.kind || left.dnssec !== right.dnssec) return false;
  const a = left.rrsets.map(rrsetState).sort((x, y) => rrsetKey(x).localeCompare(rrsetKey(y)));
  const b = right.rrsets.map(rrsetState).sort((x, y) => rrsetKey(x).localeCompare(rrsetKey(y)));
  return JSON.stringify(a) === JSON.stringify(b);
}

function desiredMap(records) {
  const result = new Map();
  for (const record of records) {
    const rrset = desiredRrset(record);
    const key = rrsetKey(rrset);
    if (result.has(key)) throw new PowerDnsZoneManagerError('powerdns_zone_record_conflict', 'Desired PowerDNS RRsets are not unique', 409);
    result.set(key, rrset);
  }
  return result;
}

function serialFromRrsets(rrsets, normalizedZone) {
  const soa = rrsets.find((entry) => entry.name === fqdn(normalizedZone) && entry.type === 'SOA');
  const content = soa?.records?.[0]?.content;
  const parts = typeof content === 'string' ? content.split(/\s+/) : [];
  const serial = Number.parseInt(parts[2] ?? '', 10);
  return Number.isSafeInteger(serial) && serial > 0 ? serial : null;
}

function serialMetadata(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function primaryKind(value) {
  return PRIMARY_KINDS.has(value);
}

export function createPowerDnsZoneManager({
  fetchFn = globalThis.fetch,
  apiAddress = '127.0.0.1',
  apiPort = 8081,
  serverName = 'localhost',
} = {}) {
  if (typeof fetchFn !== 'function' || typeof apiAddress !== 'string' || !apiAddress
    || !Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65535
    || typeof serverName !== 'string' || !serverName) {
    throw new PowerDnsZoneManagerError('powerdns_zone_dependencies_invalid', 'PowerDNS zone manager dependencies are invalid');
  }
  const baseUrl = `http://${apiAddress}:${apiPort}/api/v1/servers/${encodeURIComponent(serverName)}`;

  async function request(path, { method = 'GET', key, body = undefined, allowNotFound = false } = {}) {
    let response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': apiKey(key),
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PowerDnsZoneManagerError('powerdns_zone_api_unavailable', 'PowerDNS zone API is unavailable');
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const status = response.status === 409 || response.status === 422 ? 409 : 503;
      throw new PowerDnsZoneManagerError('powerdns_zone_api_failed', `PowerDNS zone API request failed with status ${response.status}`, status);
    }
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new PowerDnsZoneManagerError('powerdns_zone_api_invalid', 'PowerDNS zone API returned invalid JSON'); }
  }

  async function getZone(rawZoneName, key) {
    const normalizedZone = zoneName(rawZoneName);
    const payload = await request(`/zones/${encodeURIComponent(fqdn(normalizedZone))}`, {
      key,
      allowNotFound: true,
    });
    if (payload === null) return null;
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rrsets)) {
      throw new PowerDnsZoneManagerError('powerdns_zone_state_invalid', 'PowerDNS zone state is invalid');
    }
    const rrsets = payload.rrsets.map(normalizedExistingRrset).filter(Boolean);
    return Object.freeze({
      zoneName: normalizedZone,
      id: typeof payload.id === 'string' ? payload.id : fqdn(normalizedZone),
      kind: payload.kind ?? null,
      dnssec: payload.dnssec === true,
      serial: serialFromRrsets(rrsets, normalizedZone),
      notifiedSerial: serialMetadata(payload.notified_serial),
      rrsets: Object.freeze(rrsets),
    });
  }

  async function ensurePrimaryZone(existing, normalizedZone, rawApiKey) {
    if (!existing) return Object.freeze({ zone: existing, changed: false });
    if (primaryKind(existing.kind)) return Object.freeze({ zone: existing, changed: false });
    if (existing.kind !== 'Native') {
      throw new PowerDnsZoneManagerError(
        'powerdns_zone_kind_conflict',
        `PowerDNS zone is ${existing.kind ?? 'unknown'} and cannot be silently converted to a primary zone`,
        409,
      );
    }
    await request(`/zones/${encodeURIComponent(fqdn(normalizedZone))}`, {
      method: 'PUT',
      key: rawApiKey,
      body: { kind: 'Primary' },
    });
    const after = await getZone(normalizedZone, rawApiKey);
    if (!after || !primaryKind(after.kind)) {
      throw new PowerDnsZoneManagerError('powerdns_zone_primary_kind_unverified', 'PowerDNS primary zone conversion could not be verified');
    }
    return Object.freeze({ zone: after, changed: true });
  }

  async function notifyZone(normalizedZone, rawApiKey) {
    const current = await getZone(normalizedZone, rawApiKey);
    if (!current) throw new PowerDnsZoneManagerError('powerdns_zone_not_found', 'PowerDNS zone was not found', 404);
    if (!primaryKind(current.kind)) {
      throw new PowerDnsZoneManagerError('powerdns_zone_primary_kind_required', 'PowerDNS NOTIFY requires a primary zone', 409);
    }
    await request(`/zones/${encodeURIComponent(fqdn(normalizedZone))}/notify`, {
      method: 'PUT',
      key: rawApiKey,
    });
    const after = await getZone(normalizedZone, rawApiKey);
    if (!after) throw new PowerDnsZoneManagerError('powerdns_zone_notify_unverified', 'PowerDNS zone disappeared after NOTIFY');
    return Object.freeze({
      accepted: true,
      zoneName: normalizedZone,
      serial: after.serial,
      notifiedSerial: after.notifiedSerial,
      currentSerialDispatched: Number.isSafeInteger(after.serial)
        && Number.isSafeInteger(after.notifiedSerial)
        && after.notifiedSerial >= after.serial,
    });
  }

  function desiredNameservers(normalizedZone, desired) {
    const rrset = desired.get(`${fqdn(normalizedZone)}\u0000NS`);
    if (!rrset || rrset.records.length < 1) {
      throw new PowerDnsZoneManagerError('powerdns_zone_nameservers_required', 'Managed zone requires apex NS records', 409);
    }
    return rrset.records.map((entry) => entry.content);
  }

  function changesFor(existing, desired, { allowUnmanagedReplacement = false } = {}) {
    const existingMap = new Map(existing.rrsets.map((rrset) => [rrsetKey(rrset), rrset]));
    const changes = [];
    for (const [key, wanted] of desired.entries()) {
      const current = existingMap.get(key) ?? null;
      if (current && !current.managed && !allowUnmanagedReplacement) {
        throw new PowerDnsZoneManagerError(
          'powerdns_zone_manual_record_conflict',
          `Manual DNS RRset conflicts with managed desired state (${current.name} ${current.type})`,
          409,
        );
      }
      if (!current || !sameRecords(current, wanted) || !sameManagedMetadata(current, wanted)) changes.push(wanted);
      existingMap.delete(key);
    }
    for (const current of existingMap.values()) {
      if (!current.managed) continue;
      changes.push(Object.freeze({
        name: current.name,
        type: current.type,
        changetype: 'DELETE',
        records: Object.freeze([]),
        comments: Object.freeze([]),
      }));
    }
    return Object.freeze(changes);
  }

  function inspectAgainstDesired(existing, desired, { requirePrimary = false } = {}) {
    if (!existing) return Object.freeze({ satisfied: false, reason: 'powerdns_zone_missing' });
    if (requirePrimary && !primaryKind(existing.kind)) {
      return Object.freeze({ satisfied: false, reason: 'powerdns_zone_primary_kind_required', kind: existing.kind });
    }
    const existingMap = new Map(existing.rrsets.map((rrset) => [rrsetKey(rrset), rrset]));
    for (const [key, wanted] of desired.entries()) {
      const current = existingMap.get(key);
      if (!current) return Object.freeze({ satisfied: false, reason: 'powerdns_zone_record_missing', rrset: key });
      if (!current.managed) return Object.freeze({ satisfied: false, reason: 'powerdns_zone_record_not_managed', rrset: key });
      if (!sameRecords(current, wanted)) return Object.freeze({ satisfied: false, reason: 'powerdns_zone_record_drift', rrset: key });
      if (!sameManagedMetadata(current, wanted)) return Object.freeze({ satisfied: false, reason: 'powerdns_zone_record_metadata_drift', rrset: key });
    }
    const obsolete = existing.rrsets.find((rrset) => rrset.managed && !desired.has(rrsetKey(rrset)));
    if (obsolete) return Object.freeze({ satisfied: false, reason: 'powerdns_zone_obsolete_managed_record', rrset: rrsetKey(obsolete) });
    return Object.freeze({
      satisfied: true,
      adapter: 'powerdns-authoritative-api',
      zoneName: existing.zoneName,
      kind: existing.kind,
      serial: existing.serial,
      notifiedSerial: existing.notifiedSerial,
      dnssec: existing.dnssec,
      managedRrsetCount: desired.size,
      manualRrsetCount: existing.rrsets.filter((rrset) => !rrset.managed).length,
    });
  }

  async function inspect({ zoneName: requestedZoneName, apiKey: rawApiKey, records, notifySecondaries = false } = {}) {
    const normalizedZone = zoneName(requestedZoneName);
    const desired = desiredMap(records ?? []);
    desiredNameservers(normalizedZone, desired);
    const existing = await getZone(normalizedZone, rawApiKey);
    return inspectAgainstDesired(existing, desired, { requirePrimary: notifySecondaries === true });
  }

  async function apply({ zoneName: requestedZoneName, apiKey: rawApiKey, records, dnssec = false, notifySecondaries = false } = {}) {
    const normalizedZone = zoneName(requestedZoneName);
    const desired = desiredMap(records ?? []);
    const nameservers = desiredNameservers(normalizedZone, desired);
    let existing = await getZone(normalizedZone, rawApiKey);
    let created = false;
    let createdBaseline = null;
    let primaryKindChanged = false;
    if (!existing) {
      await request('/zones', {
        method: 'POST',
        key: rawApiKey,
        body: {
          name: fqdn(normalizedZone),
          kind: 'Primary',
          masters: [],
          nameservers,
          dnssec: dnssec === true,
        },
      });
      created = true;
      existing = await getZone(normalizedZone, rawApiKey);
      if (!existing) throw new PowerDnsZoneManagerError('powerdns_zone_create_unverified', 'PowerDNS zone creation could not be verified');
      createdBaseline = existing;
    } else if (notifySecondaries === true) {
      const primary = await ensurePrimaryZone(existing, normalizedZone, rawApiKey);
      existing = primary.zone;
      primaryKindChanged = primary.changed;
    }

    let changes;
    try { changes = changesFor(existing, desired, { allowUnmanagedReplacement: created }); }
    catch (error) {
      if (created) await cleanupCreatedZone(normalizedZone, rawApiKey, createdBaseline, desired);
      throw error;
    }
    try {
      if (changes.length > 0) {
        await request(`/zones/${encodeURIComponent(fqdn(normalizedZone))}`, {
          method: 'PATCH',
          key: rawApiKey,
          body: { rrsets: changes },
        });
      }
    } catch (error) {
      if (created) await cleanupCreatedZone(normalizedZone, rawApiKey, createdBaseline, desired);
      throw error;
    }

    let notification = null;
    if (notifySecondaries === true && (created || primaryKindChanged || changes.length > 0)) {
      notification = await notifyZone(normalizedZone, rawApiKey);
    }
    const verifiedZone = await getZone(normalizedZone, rawApiKey);
    const verified = inspectAgainstDesired(verifiedZone, desired, { requirePrimary: notifySecondaries === true });
    if (!verified.satisfied) {
      throw new PowerDnsZoneManagerError('powerdns_zone_apply_unverified', `PowerDNS zone apply could not be verified (${verified.reason})`);
    }
    return Object.freeze({
      ...verified,
      created,
      primaryKindChanged,
      changedRrsetCount: changes.length,
      notification,
    });
  }

  function compensationOwnership(existing, desired) {
    const unmanaged = existing.rrsets.filter((rrset) => !rrset.managed);
    if (unmanaged.length > 0) return Object.freeze({
      satisfied: false,
      reason: 'powerdns_zone_compensation_manual_records',
      manualRrsetCount: unmanaged.length,
    });
    const inspected = inspectAgainstDesired(existing, desired);
    if (!inspected.satisfied) return Object.freeze({
      satisfied: false,
      reason: 'powerdns_zone_compensation_ownership_drift',
      ownershipReason: inspected.reason,
    });
    return Object.freeze({ satisfied: true, managedRrsetCount: inspected.managedRrsetCount });
  }

  async function cleanupCreatedZone(normalizedZone, rawApiKey, createdBaseline, desired) {
    try {
      const current = await getZone(normalizedZone, rawApiKey);
      if (!current) return;
      const ownership = compensationOwnership(current, desired);
      if (!sameZoneState(current, createdBaseline) && !ownership.satisfied) return;
      await request(`/zones/${encodeURIComponent(fqdn(normalizedZone))}`, { method: 'DELETE', key: rawApiKey });
    } catch {
      // The original apply error remains authoritative. Uncertain cleanup is intentionally preserved.
    }
  }

  async function compensate({ zoneName: requestedZoneName, apiKey: rawApiKey, records } = {}) {
    const normalizedZone = zoneName(requestedZoneName);
    const desired = desiredMap(records ?? []);
    desiredNameservers(normalizedZone, desired);
    const existing = await getZone(normalizedZone, rawApiKey);
    if (!existing) return Object.freeze({ satisfied: true, zoneName: normalizedZone, deleted: false });
    const ownership = compensationOwnership(existing, desired);
    if (ownership.reason === 'powerdns_zone_compensation_manual_records') {
      throw new PowerDnsZoneManagerError(
        'powerdns_zone_compensation_manual_records',
        'PowerDNS zone contains manual records and cannot be removed automatically',
        409,
      );
    }
    if (!ownership.satisfied) {
      throw new PowerDnsZoneManagerError(
        'powerdns_zone_compensation_ownership_drift',
        'PowerDNS zone no longer matches the exact operation-owned desired state',
        409,
      );
    }
    await request(`/zones/${encodeURIComponent(fqdn(normalizedZone))}`, { method: 'DELETE', key: rawApiKey });
    const after = await getZone(normalizedZone, rawApiKey);
    if (after) throw new PowerDnsZoneManagerError('powerdns_zone_delete_unverified', 'PowerDNS zone deletion could not be verified');
    return Object.freeze({
      satisfied: true,
      zoneName: normalizedZone,
      deleted: true,
      managedRrsetCount: ownership.managedRrsetCount,
    });
  }

  async function inspectCompensation({ zoneName: requestedZoneName, apiKey: rawApiKey, records } = {}) {
    const normalizedZone = zoneName(requestedZoneName);
    const desired = desiredMap(records ?? []);
    desiredNameservers(normalizedZone, desired);
    const existing = await getZone(normalizedZone, rawApiKey);
    if (!existing) return Object.freeze({ satisfied: true, zoneName: normalizedZone, deleted: true });
    const ownership = compensationOwnership(existing, desired);
    if (!ownership.satisfied) return Object.freeze({
      satisfied: false,
      reason: ownership.reason,
      zoneName: normalizedZone,
      ...(ownership.ownershipReason ? { ownershipReason: ownership.ownershipReason } : {}),
      ...(Number.isSafeInteger(ownership.manualRrsetCount)
        ? { manualRrsetCount: ownership.manualRrsetCount }
        : {}),
    });
    return Object.freeze({
      satisfied: false,
      reason: 'powerdns_zone_still_exists',
      zoneName: normalizedZone,
      operationOwned: true,
      managedRrsetCount: ownership.managedRrsetCount,
    });
  }

  return Object.freeze({ inspect, apply, compensate, inspectCompensation, getZone, notifyZone });
}

export const powerDnsZoneManagerInternals = Object.freeze({
  commentPrefix: COMMENT_PREFIX,
  primaryKinds: Object.freeze([...PRIMARY_KINDS]),
  zoneName,
  fqdn,
  escapeQuoted,
  txtChunks,
  powerDnsContent,
  recordMetadata,
  commentFor,
  parseManagedComment,
  normalizeRecord,
  desiredRrset,
  rrsetKey,
  normalizedExistingRrset,
  sameRecords,
  sameManagedMetadata,
  rrsetState,
  sameZoneState,
  desiredMap,
  serialFromRrsets,
  serialMetadata,
  primaryKind,
});
