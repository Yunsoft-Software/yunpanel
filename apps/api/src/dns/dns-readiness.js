import { promises as dns } from 'node:dns';
import { isIP, SocketAddress } from 'node:net';
import { normalizeDomainSet } from '@yunpanel/shared';

const ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND']);
const MAX_RECORDS_PER_TYPE = 16;
const DEFAULT_RESOLUTION_TIMEOUT_MS = 10_000;

export class DnsReadinessError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsReadinessError';
    this.code = code;
    this.status = status;
  }
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function unique(values) {
  return [...new Set(values)];
}

function canonicalAddress(value, family) {
  if (isIP(value) !== family) return null;
  return new SocketAddress({ address: value, family: family === 4 ? 'ipv4' : 'ipv6', port: 0 }).address;
}

function expectedAddresses(server) {
  const network = Array.isArray(server?.inventory?.network) ? server.inventory.network : [];
  return Object.freeze({
    ipv4: Object.freeze(uniqueSorted(network
      .filter((entry) => entry?.family === 'IPv4' && isIP(entry.address) === 4)
      .map((entry) => canonicalAddress(entry.address, 4)))),
    ipv6: Object.freeze(uniqueSorted(network
      .filter((entry) => entry?.family === 'IPv6' && isIP(entry.address) === 6)
      .map((entry) => canonicalAddress(entry.address, 6)))),
  });
}

function canonicalCname(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch { throw new DnsReadinessError('dns_resolution_invalid', 'DNS resolver returned invalid CNAME data', 503); }
}

function addressRecords(values, family) {
  if (!Array.isArray(values) || values.length > MAX_RECORDS_PER_TYPE) {
    throw new DnsReadinessError('dns_resolution_invalid', 'DNS resolver returned an invalid address set', 503);
  }
  const records = values.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || isIP(entry.address) !== family || !Number.isInteger(entry.ttl) || entry.ttl < 0 || entry.ttl > 2_147_483_647) {
      throw new DnsReadinessError('dns_resolution_invalid', 'DNS resolver returned invalid address data', 503);
    }
    return Object.freeze({ address: canonicalAddress(entry.address, family), ttl: entry.ttl });
  });
  records.sort((left, right) => left.address.localeCompare(right.address) || left.ttl - right.ttl);
  return Object.freeze(records);
}

function cnameRecords(values) {
  if (!Array.isArray(values) || values.length > MAX_RECORDS_PER_TYPE) {
    throw new DnsReadinessError('dns_resolution_invalid', 'DNS resolver returned an invalid CNAME set', 503);
  }
  return Object.freeze(uniqueSorted(values.map(canonicalCname)));
}

async function resolveOptional(resolve, hostname, normalize, timeoutMs) {
  let timeout;
  try {
    const records = await Promise.race([
      resolve(hostname),
      new Promise((resolvePromise, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error('DNS readiness resolution timed out'), { code: 'ETIMEOUT' })), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    return { records: normalize(records), error: false };
  } catch (error) {
    let code;
    try { code = error?.code; } catch { /* Resolver exceptions are never serialized. */ }
    if (typeof code === 'string' && ABSENT_CODES.has(code)) return { records: Object.freeze([]), error: false };
    if (error instanceof DnsReadinessError) return { records: Object.freeze([]), error: true };
    return { records: Object.freeze([]), error: true };
  } finally {
    clearTimeout(timeout);
  }
}

function actionForState(state) {
  if (state === 'missing') return 'publish_address_record';
  if (state === 'expected_unavailable') return 'inspect_managed_server_addresses';
  if (state === 'target_mismatch') return 'point_hostname_to_managed_server';
  if (state === 'resolver_error') return 'retry_dns_resolution';
  return null;
}

async function inspectHostname(hostname, expected, resolvers, timeoutMs) {
  const [a, aaaa, cname] = await Promise.all([
    resolveOptional((name) => resolvers.resolve4(name, { ttl: true }), hostname, (values) => addressRecords(values, 4), timeoutMs),
    resolveOptional((name) => resolvers.resolve6(name, { ttl: true }), hostname, (values) => addressRecords(values, 6), timeoutMs),
    resolveOptional(resolvers.resolveCname, hostname, cnameRecords, timeoutMs),
  ]);
  const resolverError = a.error || aaaa.error || cname.error;
  const addresses = [...a.records.map((entry) => entry.address), ...aaaa.records.map((entry) => entry.address)];
  const expectedSet = new Set([...expected.ipv4, ...expected.ipv6]);
  const matchedAddresses = uniqueSorted(addresses.filter((address) => expectedSet.has(address)));
  const expectedUnavailable = expectedSet.size === 0;
  const state = resolverError
    ? 'resolver_error'
    : addresses.length === 0
      ? 'missing'
      : expectedUnavailable
        ? 'expected_unavailable'
        : matchedAddresses.length !== addresses.length
          ? 'target_mismatch'
          : 'ready';
  return Object.freeze({
    hostname,
    records: Object.freeze({ a: a.records, aaaa: aaaa.records, cname: cname.records }),
    state,
    matchedAddresses: Object.freeze(matchedAddresses),
    action: actionForState(state),
  });
}

function reasonsForHostnames(hostnames, expected) {
  const reasons = [];
  if (expected.ipv4.length === 0 && expected.ipv6.length === 0) reasons.push('dns_expected_address_unavailable');
  if (hostnames.some((entry) => entry.state === 'resolver_error')) reasons.push('dns_resolver_unavailable');
  if (hostnames.some((entry) => entry.state === 'missing')) reasons.push('dns_address_missing');
  if (hostnames.some((entry) => entry.state === 'target_mismatch')) reasons.push('dns_target_mismatch');
  return unique(reasons);
}

function acmeReadiness({ domain, routingReasons, credential, credentialUnavailable }) {
  const httpReasons = [...routingReasons];
  if (domain.state !== 'active' || domain.appliedRevision !== domain.desiredRevision) {
    httpReasons.push('dns_http_domain_not_active');
  }
  const dnsReasons = credentialUnavailable
    ? ['dns_provider_credential_unavailable']
    : credential?.configured && credential.provider === 'cloudflare'
      ? []
      : ['dns_provider_credential_required'];
  return Object.freeze({
    http01: Object.freeze({
      ready: httpReasons.length === 0,
      reasonCodes: Object.freeze(unique(httpReasons)),
      action: httpReasons.includes('dns_http_domain_not_active')
        ? 'activate_domain_for_http01'
        : httpReasons.length > 0 ? 'correct_public_dns_records' : null,
    }),
    dns01: Object.freeze({
      ready: dnsReasons.length === 0,
      provider: credential?.configured ? credential.provider : null,
      reasonCodes: Object.freeze(dnsReasons),
      action: credentialUnavailable
        ? 'inspect_dns_provider_credential_store'
        : dnsReasons.length > 0 ? 'configure_dns_provider_credential' : null,
    }),
  });
}

export function createDnsReadinessService({
  dnsHostingRegistry,
  domainRegistry,
  serverRegistry,
  dnsProviderCredentialRegistry,
  resolve4 = dns.resolve4,
  resolve6 = dns.resolve6,
  resolveCname = dns.resolveCname,
  resolutionTimeoutMs = DEFAULT_RESOLUTION_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (!dnsHostingRegistry || typeof dnsHostingRegistry.getZone !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !serverRegistry || typeof serverRegistry.getServer !== 'function'
    || !dnsProviderCredentialRegistry || typeof dnsProviderCredentialRegistry.getForZone !== 'function'
    || typeof resolve4 !== 'function' || typeof resolve6 !== 'function' || typeof resolveCname !== 'function'
    || !Number.isInteger(resolutionTimeoutMs) || resolutionTimeoutMs < 100 || resolutionTimeoutMs > 30_000
    || typeof now !== 'function') {
    throw new DnsReadinessError('dns_readiness_dependencies_invalid', 'DNS readiness dependencies are invalid', 503);
  }
  const resolvers = Object.freeze({ resolve4, resolve6, resolveCname });

  async function inspectZone(dnsZoneId) {
    const zone = await dnsHostingRegistry.getZone(dnsZoneId);
    if (!zone) throw new DnsReadinessError('dns_zone_not_found', 'DNS zone was not found', 404);
    if (!zone.webDomainId) {
      throw new DnsReadinessError('dns_zone_web_domain_required', 'DNS readiness requires an explicit web Domain relationship', 409);
    }
    const domain = await domainRegistry.getDomain(zone.webDomainId);
    if (!domain || domain.primaryDomain !== zone.zoneName) {
      throw new DnsReadinessError('dns_zone_web_domain_mismatch', 'DNS zone web Domain relationship is unavailable', 409);
    }
    const server = await serverRegistry.getServer(domain.serverId);
    if (!server) throw new DnsReadinessError('dns_server_not_found', 'DNS readiness Server was not found', 409);
    const expected = expectedAddresses(server);
    const names = [domain.primaryDomain, ...domain.aliases];
    const hostnames = Object.freeze(await Promise.all(names.map((hostname) => inspectHostname(hostname, expected, resolvers, resolutionTimeoutMs))));
    const routingReasons = reasonsForHostnames(hostnames, expected);
    let credential;
    let credentialUnavailable = false;
    try { credential = await dnsProviderCredentialRegistry.getForZone(zone.id); }
    catch { credentialUnavailable = true; }
    return Object.freeze({
      dnsZoneId: zone.id,
      zoneName: zone.zoneName,
      domainId: domain.id,
      serverId: server.id,
      observedAt: new Date(now()).toISOString(),
      expected: Object.freeze({ ipv4: expected.ipv4, ipv6: expected.ipv6 }),
      hostnames,
      routing: Object.freeze({
        ready: routingReasons.length === 0,
        reasonCodes: Object.freeze(routingReasons),
        action: routingReasons.length > 0 ? 'correct_public_dns_records' : null,
      }),
      acme: acmeReadiness({ domain, routingReasons, credential, credentialUnavailable }),
    });
  }

  return Object.freeze({ inspectZone });
}

export const dnsReadinessInternals = Object.freeze({
  maxRecordsPerType: MAX_RECORDS_PER_TYPE,
  defaultResolutionTimeoutMs: DEFAULT_RESOLUTION_TIMEOUT_MS,
  expectedAddresses,
  addressRecords,
  cnameRecords,
  inspectHostname,
});
