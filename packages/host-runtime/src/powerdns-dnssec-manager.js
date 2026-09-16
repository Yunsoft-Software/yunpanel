import {
  createPowerDnsZoneManager,
  PowerDnsZoneManagerError,
  powerDnsZoneManagerInternals,
} from './powerdns-zone-manager.js';

const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_TYPES = new Set(['ksk', 'zsk', 'csk']);
const DS_PATTERN = /^(\d{1,5})\s+(\d{1,3})\s+(\d{1,3})\s+([A-Fa-f0-9]+)$/;

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
    || typeof value.algorithm !== 'string' || !value.algorithm.trim()
    || !Number.isSafeInteger(value.bits) || value.bits < 0) {
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
    algorithm: value.algorithm.trim(),
    bits: value.bits,
  });
}

function publicState(zone, keys) {
  const ds = Object.freeze([...new Set(keys.flatMap((entry) => entry.ds))].sort());
  return Object.freeze({
    adapter: 'powerdns-authoritative-api',
    zoneName: zone.zoneName,
    dnssec: zone.dnssec === true,
    serial: zone.serial,
    keys: Object.freeze(keys),
    ds,
    keyCount: keys.length,
    activeKeyCount: keys.filter((entry) => entry.active).length,
    ready: zone.dnssec === true && keys.some((entry) => entry.active && entry.published) && ds.length > 0,
  });
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
  });
}

export const powerDnsDnssecManagerInternals = Object.freeze({
  normalizeDs,
  publicKey,
  publicState,
  hostFailure,
});
