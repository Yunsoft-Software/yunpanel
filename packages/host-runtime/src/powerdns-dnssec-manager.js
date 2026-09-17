import { createHash } from 'node:crypto';
import {
  createPowerDnsZoneManager,
  PowerDnsZoneManagerError,
  powerDnsZoneManagerInternals,
} from './powerdns-zone-manager.js';

const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_TYPES = new Set(['ksk', 'zsk', 'csk']);
const ROLLOVER_KEY_TYPES = new Set(['ksk', 'csk']);
const DS_PATTERN = /^(\d{1,5})\s+(\d{1,3})\s+(\d{1,3})\s+([A-Fa-f0-9]+)$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ALGORITHM_PATTERN = /^[A-Z][A-Z0-9_-]{1,63}$/;

export class PowerDnsDnssecManagerError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'PowerDnsDnssecManagerError';
    this.code = code;
    this.status = status;
  }
}

function apiKey(value) {
  if (typeof value !== 'string' || !API_KEY_PATTERN.test(value)) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_api_key_invalid', 'PowerDNS API key is invalid', 400);
  }
  return value;
}

function normalizeDs(value) {
  const match = typeof value === 'string' ? value.trim().match(DS_PATTERN) : null;
  if (!match) throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_state_invalid', 'PowerDNS DS record is invalid', 409);
  const keyTag = Number.parseInt(match[1], 10);
  const algorithm = Number.parseInt(match[2], 10);
  const digestType = Number.parseInt(match[3], 10);
  if (keyTag > 65535 || algorithm > 255 || digestType > 255 || match[4].length < 2 || match[4].length % 2 !== 0) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_state_invalid', 'PowerDNS DS record is invalid', 409);
  }
  return `${keyTag} ${algorithm} ${digestType} ${match[4].toUpperCase()}`;
}

function publicKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.id) || value.id < 0
    || typeof value.keytype !== 'string' || !KEY_TYPES.has(value.keytype.toLowerCase())
    || typeof value.active !== 'boolean' || typeof value.published !== 'boolean'
    || typeof value.dnskey !== 'string' || !value.dnskey.trim()
    || !Array.isArray(value.ds) || !Array.isArray(value.cds)
    || value.ds.some((entry) => typeof entry !== 'string') || value.cds.some((entry) => typeof entry !== 'string')
    || typeof value.algorithm !== 'string' || !ALGORITHM_PATTERN.test(value.algorithm.trim().toUpperCase())
    || !Number.isSafeInteger(value.bits) || value.bits < 0 || value.bits > 65535) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_state_invalid', 'PowerDNS DNSSEC key state is invalid', 409);
  }
  return Object.freeze({
    id: value.id,
    keyType: value.keytype.toLowerCase(),
    active: value.active,
    published: value.published,
    dnskey: value.dnskey.trim(),
    ds: Object.freeze(value.ds.map(normalizeDs)),
    cds: Object.freeze(value.cds.map((entry) => String(entry).trim()).filter(Boolean)),
    algorithm: value.algorithm.trim().toUpperCase(),
    bits: value.bits,
  });
}

function canonicalKeySet(keys) {
  return [...keys]
    .sort((left, right) => left.id - right.id)
    .map((entry) => ({
      id: entry.id,
      keyType: entry.keyType,
      active: entry.active,
      published: entry.published,
      dnskey: entry.dnskey,
      ds: [...entry.ds].sort(),
      cds: [...entry.cds].sort(),
      algorithm: entry.algorithm,
      bits: entry.bits,
    }));
}

function keySetDigest(keys) {
  return createHash('sha256').update(JSON.stringify(canonicalKeySet(keys))).digest('hex');
}

function publicState(zone, keys) {
  const sortedKeys = [...keys].sort((left, right) => left.id - right.id);
  if (new Set(sortedKeys.map((entry) => entry.id)).size !== sortedKeys.length) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_state_invalid', 'PowerDNS DNSSEC key identifiers are not unique', 409);
  }
  const ds = Object.freeze([...new Set(sortedKeys.flatMap((entry) => entry.ds))].sort());
  return Object.freeze({
    adapter: 'powerdns-authoritative-api',
    zoneName: zone.zoneName,
    dnssec: zone.dnssec === true,
    serial: zone.serial,
    keys: Object.freeze(sortedKeys),
    keySetDigest: keySetDigest(sortedKeys),
    ds,
    keyCount: sortedKeys.length,
    activeKeyCount: sortedKeys.filter((entry) => entry.active).length,
    ready: zone.dnssec === true && sortedKeys.some((entry) => entry.active && entry.published) && ds.length > 0,
  });
}

function expectedDigest(value, field = 'expectedKeySetDigest') {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_precondition_invalid', `${field} is invalid`, 400);
  }
  return value;
}

function expectedKeyIds(value) {
  if (!Array.isArray(value) || value.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_precondition_invalid', 'expectedKeyIds is invalid', 400);
  }
  const normalized = [...new Set(value)].sort((left, right) => left - right);
  if (normalized.length !== value.length) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_precondition_invalid', 'expectedKeyIds contains duplicates', 400);
  }
  return Object.freeze(normalized);
}

function keyIdentifier(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_id_invalid', 'DNSSEC key identifier is invalid', 400);
  }
  return value;
}

function keyCreationSpec({ keyType, algorithm, bits, active, published } = {}) {
  const normalizedType = typeof keyType === 'string' ? keyType.trim().toLowerCase() : '';
  const normalizedAlgorithm = typeof algorithm === 'string' ? algorithm.trim().toUpperCase() : '';
  if (!ROLLOVER_KEY_TYPES.has(normalizedType) || !ALGORITHM_PATTERN.test(normalizedAlgorithm)
    || !Number.isSafeInteger(bits) || bits < 1 || bits > 65535
    || typeof active !== 'boolean' || typeof published !== 'boolean') {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_target_invalid', 'DNSSEC rollover key target is invalid', 400);
  }
  return Object.freeze({
    keyType: normalizedType,
    algorithm: normalizedAlgorithm,
    bits,
    active,
    published,
  });
}

function keyMatches(entry, target) {
  return entry.keyType === target.keyType
    && entry.algorithm === target.algorithm
    && entry.bits === target.bits
    && entry.active === target.active
    && entry.published === target.published;
}

function assertRolloverState(state) {
  if (!state.dnssec || !state.ready) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_rollover_not_ready', 'DNSSEC rollover requires an existing active and published key', 409);
  }
}

function classifyCreate(state, { baselineDigest, baselineIds, target }) {
  const baselineIdSet = new Set(baselineIds);
  const baseline = state.keys.filter((entry) => baselineIdSet.has(entry.id));
  if (baseline.length !== baselineIds.length || keySetDigest(baseline) !== baselineDigest) return Object.freeze({ status: 'drift' });
  const additions = state.keys.filter((entry) => !baselineIdSet.has(entry.id));
  if (additions.length === 0 && state.keySetDigest === baselineDigest) return Object.freeze({ status: 'ready' });
  if (additions.length === 1 && keyMatches(additions[0], target)) {
    return Object.freeze({ status: 'complete', key: additions[0] });
  }
  return Object.freeze({ status: 'drift' });
}

function hostFailure(error) {
  if (error instanceof PowerDnsDnssecManagerError) return error;
  if (error instanceof PowerDnsZoneManagerError) {
    return new PowerDnsDnssecManagerError(error.code, error.message, error.status);
  }
  return error;
}

export function createPowerDnsDnssecManager({
  fetchFn = globalThis.fetch,
  apiAddress = '127.0.0.1',
  apiPort = 8081,
  serverName = 'localhost',
  zoneManager = null,
} = {}) {
  if (typeof fetchFn !== 'function' || typeof apiAddress !== 'string' || !apiAddress
    || !Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65535
    || typeof serverName !== 'string' || !serverName) {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_dependencies_invalid', 'PowerDNS DNSSEC dependencies are invalid');
  }
  const zones = zoneManager ?? createPowerDnsZoneManager({ fetchFn, apiAddress, apiPort, serverName });
  if (!zones || typeof zones.getZone !== 'function') {
    throw new PowerDnsDnssecManagerError('powerdns_dnssec_dependencies_invalid', 'PowerDNS zone inspection is unavailable');
  }
  const baseUrl = `http://${apiAddress}:${apiPort}/api/v1/servers/${encodeURIComponent(serverName)}`;

  async function request(path, { method = 'GET', rawApiKey, body = undefined } = {}) {
    let response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': apiKey(rawApiKey),
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_api_unavailable', 'PowerDNS DNSSEC API is unavailable');
    }
    if (!response.ok) {
      const status = response.status === 404 ? 404 : response.status === 409 || response.status === 422 ? 409 : 503;
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_api_failed', `PowerDNS DNSSEC API request failed with status ${response.status}`, status);
    }
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new PowerDnsDnssecManagerError('powerdns_dnssec_api_invalid', 'PowerDNS DNSSEC API returned invalid JSON'); }
  }

  async function inspect({ zoneName, apiKey: rawApiKey } = {}) {
    let zone;
    try { zone = await zones.getZone(zoneName, rawApiKey); }
    catch (error) { throw hostFailure(error); }
    if (!zone) throw new PowerDnsDnssecManagerError('powerdns_dnssec_zone_not_found', 'PowerDNS zone was not found', 404);
    const payload = await request(`/zones/${encodeURIComponent(powerDnsZoneManagerInternals.fqdn(zone.zoneName))}/cryptokeys`, {
      rawApiKey,
    });
    if (!Array.isArray(payload)) {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_state_invalid', 'PowerDNS DNSSEC key list is invalid', 409);
    }
    return publicState(zone, payload.map(publicKey));
  }

  async function rectify(zoneName, rawApiKey) {
    const zonePath = `/zones/${encodeURIComponent(powerDnsZoneManagerInternals.fqdn(zoneName))}`;
    await request(`${zonePath}/rectify`, { method: 'PUT', rawApiKey });
    return inspect({ zoneName, apiKey: rawApiKey });
  }

  function changedKeySet() {
    return new PowerDnsDnssecManagerError('powerdns_dnssec_key_set_changed', 'PowerDNS DNSSEC key set changed after preview', 409);
  }

  async function createRolloverKey({
    zoneName,
    apiKey: rawApiKey,
    expectedKeySetDigest: rawExpectedDigest,
    expectedKeyIds: rawExpectedIds,
    keyType,
    algorithm,
    bits,
    active,
    published,
  } = {}) {
    const normalizedZone = powerDnsZoneManagerInternals.zoneName(zoneName);
    const baselineDigest = expectedDigest(rawExpectedDigest);
    const baselineIds = expectedKeyIds(rawExpectedIds);
    const target = keyCreationSpec({ keyType, algorithm, bits, active, published });
    const before = await inspect({ zoneName: normalizedZone, apiKey: rawApiKey });
    assertRolloverState(before);
    const initial = classifyCreate(before, { baselineDigest, baselineIds, target });
    if (initial.status === 'drift') throw changedKeySet();
    if (initial.status === 'complete') {
      const reconciled = await rectify(normalizedZone, rawApiKey);
      const completed = classifyCreate(reconciled, { baselineDigest, baselineIds, target });
      if (completed.status !== 'complete') throw changedKeySet();
      return Object.freeze({ ...reconciled, changed: false, createdKey: completed.key });
    }

    const zonePath = `/zones/${encodeURIComponent(powerDnsZoneManagerInternals.fqdn(normalizedZone))}`;
    let mutationError = null;
    try {
      await request(`${zonePath}/cryptokeys`, {
        method: 'POST',
        rawApiKey,
        body: {
          keytype: target.keyType.toUpperCase(),
          active: target.active,
          published: target.published,
          algorithm: target.algorithm,
          bits: target.bits,
        },
      });
    } catch (error) {
      mutationError = error;
    }

    if (mutationError) {
      const observed = await inspect({ zoneName: normalizedZone, apiKey: rawApiKey });
      if (classifyCreate(observed, { baselineDigest, baselineIds, target }).status !== 'complete') throw mutationError;
    }
    const after = await rectify(normalizedZone, rawApiKey);
    const completed = classifyCreate(after, { baselineDigest, baselineIds, target });
    if (completed.status !== 'complete') {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_create_unverified', 'DNSSEC rollover key creation could not be verified');
    }
    return Object.freeze({ ...after, changed: true, createdKey: completed.key });
  }

  async function setRolloverKeyState({
    zoneName,
    apiKey: rawApiKey,
    keyId: rawKeyId,
    expectedKeySetDigest: rawExpectedDigest,
    expectedTargetKeySetDigest: rawTargetDigest,
    expectedActive,
    expectedPublished,
    active,
    published,
  } = {}) {
    const normalizedZone = powerDnsZoneManagerInternals.zoneName(zoneName);
    const keyId = keyIdentifier(rawKeyId);
    const baselineDigest = expectedDigest(rawExpectedDigest);
    const targetDigest = expectedDigest(rawTargetDigest, 'expectedTargetKeySetDigest');
    if (typeof expectedActive !== 'boolean' || typeof expectedPublished !== 'boolean'
      || typeof active !== 'boolean' || typeof published !== 'boolean') {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_target_invalid', 'DNSSEC rollover key state target is invalid', 400);
    }
    const before = await inspect({ zoneName: normalizedZone, apiKey: rawApiKey });
    assertRolloverState(before);
    const key = before.keys.find((entry) => entry.id === keyId);
    if (!key) throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_not_found', 'DNSSEC key was not found', 404);
    const atBaseline = before.keySetDigest === baselineDigest
      && key.active === expectedActive && key.published === expectedPublished;
    const atTarget = before.keySetDigest === targetDigest && key.active === active && key.published === published;
    if (!atBaseline && !atTarget) throw changedKeySet();
    if (atTarget) {
      if (active === expectedActive && published === expectedPublished) {
        return Object.freeze({ ...before, changed: false, updatedKey: key });
      }
      const reconciled = await rectify(normalizedZone, rawApiKey);
      const reconciledKey = reconciled.keys.find((entry) => entry.id === keyId);
      if (!reconciledKey || reconciled.keySetDigest !== targetDigest
        || reconciledKey.active !== active || reconciledKey.published !== published) throw changedKeySet();
      return Object.freeze({ ...reconciled, changed: false, updatedKey: reconciledKey });
    }
    const desiredKeys = before.keys.map((entry) => (entry.id === keyId ? { ...entry, active, published } : entry));
    if (keySetDigest(desiredKeys) !== targetDigest) throw changedKeySet();
    if (!desiredKeys.some((entry) => entry.active && entry.published && entry.ds.length > 0)) {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_update_unsafe', 'DNSSEC key update would remove verified signing continuity', 409);
    }

    const zonePath = `/zones/${encodeURIComponent(powerDnsZoneManagerInternals.fqdn(normalizedZone))}`;
    let mutationError = null;
    try {
      await request(`${zonePath}/cryptokeys/${keyId}`, {
        method: 'PUT',
        rawApiKey,
        body: { active, published },
      });
    } catch (error) {
      mutationError = error;
    }
    if (mutationError) {
      const observed = await inspect({ zoneName: normalizedZone, apiKey: rawApiKey });
      const observedKey = observed.keys.find((entry) => entry.id === keyId);
      if (!observedKey || observed.keySetDigest !== targetDigest
        || observedKey.active !== active || observedKey.published !== published) throw mutationError;
    }
    const after = await rectify(normalizedZone, rawApiKey);
    const updatedKey = after.keys.find((entry) => entry.id === keyId);
    if (!updatedKey || after.keySetDigest !== targetDigest
      || updatedKey.active !== active || updatedKey.published !== published) {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_update_unverified', 'DNSSEC rollover key state could not be verified');
    }
    return Object.freeze({ ...after, changed: true, updatedKey });
  }

  async function deleteRolloverKey({
    zoneName,
    apiKey: rawApiKey,
    keyId: rawKeyId,
    expectedKeySetDigest: rawExpectedDigest,
    expectedRemainingKeySetDigest: rawRemainingDigest,
  } = {}) {
    const normalizedZone = powerDnsZoneManagerInternals.zoneName(zoneName);
    const keyId = keyIdentifier(rawKeyId);
    const baselineDigest = expectedDigest(rawExpectedDigest);
    const remainingDigest = expectedDigest(rawRemainingDigest, 'expectedRemainingKeySetDigest');
    const before = await inspect({ zoneName: normalizedZone, apiKey: rawApiKey });
    assertRolloverState(before);
    const key = before.keys.find((entry) => entry.id === keyId);
    if (!key && before.keySetDigest === remainingDigest) {
      const reconciled = await rectify(normalizedZone, rawApiKey);
      if (reconciled.keys.some((entry) => entry.id === keyId) || reconciled.keySetDigest !== remainingDigest) throw changedKeySet();
      return Object.freeze({ ...reconciled, changed: false, deletedKeyId: keyId });
    }
    if (!key || before.keySetDigest !== baselineDigest) throw changedKeySet();
    const remainingKeys = before.keys.filter((entry) => entry.id !== keyId);
    if (keySetDigest(remainingKeys) !== remainingDigest
      || !remainingKeys.some((entry) => entry.active && entry.published && entry.ds.length > 0)) {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_delete_unsafe', 'DNSSEC key deletion would remove verified signing continuity', 409);
    }

    const zonePath = `/zones/${encodeURIComponent(powerDnsZoneManagerInternals.fqdn(normalizedZone))}`;
    let mutationError = null;
    try {
      await request(`${zonePath}/cryptokeys/${keyId}`, { method: 'DELETE', rawApiKey });
    } catch (error) {
      mutationError = error;
    }
    if (mutationError) {
      const observed = await inspect({ zoneName: normalizedZone, apiKey: rawApiKey });
      if (observed.keys.some((entry) => entry.id === keyId) || observed.keySetDigest !== remainingDigest) throw mutationError;
    }
    const after = await rectify(normalizedZone, rawApiKey);
    if (after.keys.some((entry) => entry.id === keyId) || after.keySetDigest !== remainingDigest) {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_key_delete_unverified', 'DNSSEC rollover key deletion could not be verified');
    }
    return Object.freeze({ ...after, changed: true, deletedKeyId: keyId });
  }

  async function mutationSatisfied(zoneName, rawApiKey, enabled) {
    try {
      const state = await inspect({ zoneName, apiKey: rawApiKey });
      return enabled ? state.ready : state.dnssec === false;
    } catch {
      return false;
    }
  }

  async function setEnabled({ zoneName, apiKey: rawApiKey, enabled } = {}) {
    const normalizedZone = powerDnsZoneManagerInternals.zoneName(zoneName);
    if (typeof enabled !== 'boolean') {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_target_invalid', 'DNSSEC target state is invalid', 400);
    }
    const before = await inspect({ zoneName: normalizedZone, apiKey: rawApiKey });
    if ((enabled && before.ready) || (!enabled && before.dnssec === false)) {
      return Object.freeze({ ...before, changed: false });
    }

    const zonePath = `/zones/${encodeURIComponent(powerDnsZoneManagerInternals.fqdn(normalizedZone))}`;
    let mutationError = null;
    try {
      await request(zonePath, {
        method: 'PUT',
        rawApiKey,
        body: { dnssec: enabled, api_rectify: enabled },
      });
      if (enabled) {
        await request(`${zonePath}/rectify`, { method: 'PUT', rawApiKey });
      }
    } catch (error) {
      mutationError = error;
    }

    if (mutationError && !(await mutationSatisfied(normalizedZone, rawApiKey, enabled))) throw mutationError;
    const after = await inspect({ zoneName: normalizedZone, apiKey: rawApiKey });
    if (enabled && !after.ready) {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_enable_unverified', 'DNSSEC enablement could not be verified');
    }
    if (!enabled && after.dnssec !== false) {
      throw new PowerDnsDnssecManagerError('powerdns_dnssec_disable_unverified', 'DNSSEC disablement could not be verified');
    }
    return Object.freeze({ ...after, changed: true });
  }

  return Object.freeze({
    inspect,
    enable: (input) => setEnabled({ ...input, enabled: true }),
    disable: (input) => setEnabled({ ...input, enabled: false }),
    createRolloverKey,
    setRolloverKeyState,
    deleteRolloverKey,
  });
}

export const powerDnsDnssecManagerInternals = Object.freeze({
  normalizeDs,
  publicKey,
  publicState,
  keySetDigest,
  keyCreationSpec,
  classifyCreate,
  hostFailure,
});
