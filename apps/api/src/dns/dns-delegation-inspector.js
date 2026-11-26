import { resolve4, resolve6, resolveNs } from 'node:dns/promises';
import { isIP, SocketAddress } from 'node:net';
import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const TRANSIENT_DNS_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EREFUSED',
  'ESERVFAIL',
  'ETIMEOUT',
]);

export class DnsDelegationInspectorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsDelegationInspectorError';
    this.code = code;
    this.status = status;
  }
}

function domainName(value) {
  try {
    return normalizeDomainSet(value, []).primary;
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw new DnsDelegationInspectorError('dns_delegation_domain_invalid', 'Delegation domain is invalid');
    }
    throw error;
  }
}

function hostname(value) {
  return String(value ?? '').trim().replace(/\.$/, '').toLowerCase();
}

function normalizedIp(value) {
  const family = isIP(value);
  if (!family) return null;
  try {
    return new SocketAddress({
      address: value,
      family: family === 4 ? 'ipv4' : 'ipv6',
      port: 0,
    }).address;
  } catch {
    return null;
  }
}

function dnsCode(error) {
  return typeof error?.code === 'string' && error.code ? error.code : 'DNS_LOOKUP_FAILED';
}

function transientDnsFailure(code) {
  return TRANSIENT_DNS_CODES.has(code);
}

async function safeResolve(resolver, method, value) {
  try {
    const answers = await resolver[method](value);
    return Object.freeze({
      answers: Object.freeze(Array.isArray(answers) ? answers : []),
      errorCode: null,
      transient: false,
    });
  } catch (error) {
    const errorCode = dnsCode(error);
    return Object.freeze({
      answers: Object.freeze([]),
      errorCode,
      transient: transientDnsFailure(errorCode),
    });
  }
}

function normalizeNsAnswers(answers) {
  return Object.freeze([...new Set(answers
    .map((entry) => hostname(entry))
    .filter(Boolean))].sort());
}

function normalizeIpAnswers(answers, family) {
  return Object.freeze([...new Set(answers
    .map((entry) => (typeof entry === 'string' ? entry : entry?.address))
    .map(normalizedIp)
    .filter((entry) => entry && isIP(entry) === family))].sort());
}

function inBailiwick(nameserverHostname, domain) {
  return nameserverHostname === domain || nameserverHostname.endsWith(`.${domain}`);
}

async function inspectNameserver(resolver, role, settings, domain) {
  const ipv4Lookup = await safeResolve(resolver, 'resolve4', settings.hostname);
  const ipv6Lookup = settings.ipv6
    ? await safeResolve(resolver, 'resolve6', settings.hostname)
    : Object.freeze({ answers: Object.freeze([]), errorCode: null, transient: false });
  const observedIpv4 = normalizeIpAnswers(ipv4Lookup.answers, 4);
  const observedIpv6 = normalizeIpAnswers(ipv6Lookup.answers, 6);
  const ipv4Ready = observedIpv4.includes(settings.ipv4);
  const ipv6Ready = settings.ipv6 === null || observedIpv6.includes(settings.ipv6);
  return Object.freeze({
    role,
    hostname: settings.hostname,
    configuredIpv4: settings.ipv4,
    configuredIpv6: settings.ipv6,
    local: settings.local,
    inBailiwick: inBailiwick(settings.hostname, domain),
    observedIpv4,
    observedIpv6,
    ipv4ErrorCode: ipv4Lookup.errorCode,
    ipv6ErrorCode: ipv6Lookup.errorCode,
    ready: ipv4Ready && ipv6Ready,
    transientFailure: ipv4Lookup.transient || ipv6Lookup.transient,
  });
}

function inspectionStatus(delegation, nameservers) {
  if (delegation.transientFailure || nameservers.some((entry) => entry.transientFailure)) return 'unverifiable';
  if (nameservers.some((entry) => entry.inBailiwick && !entry.ready)) return 'pending_glue';
  if (!delegation.ready) return 'pending_delegation';
  if (nameservers.some((entry) => !entry.ready)) return 'pending_nameserver_address';
  return 'ready';
}

function registrarInstructions(domain, nameservers) {
  return Object.freeze({
    domain,
    nameservers: Object.freeze(nameservers.map((entry) => Object.freeze({
      role: entry.role,
      hostname: entry.hostname,
      ipv4: entry.configuredIpv4,
      ipv6: entry.configuredIpv6,
      glueRequiredForThisDomain: entry.inBailiwick,
    }))),
  });
}

export function createDnsDelegationInspector({
  dnsIdentityRegistry,
  resolver = { resolveNs, resolve4, resolve6 },
  now = () => Date.now(),
} = {}) {
  if (!dnsIdentityRegistry || typeof dnsIdentityRegistry.getForServer !== 'function'
    || !resolver || typeof resolver.resolveNs !== 'function'
    || typeof resolver.resolve4 !== 'function' || typeof resolver.resolve6 !== 'function'
    || typeof now !== 'function') {
    throw new DnsDelegationInspectorError(
      'dns_delegation_dependencies_invalid',
      'DNS delegation inspector dependencies are unavailable',
      503,
    );
  }

  async function inspect({ serverId, domain } = {}) {
    const normalizedDomain = domainName(domain);
    const identity = await dnsIdentityRegistry.getForServer(serverId);
    if (!identity?.settings?.ns1 || !identity?.settings?.ns2) {
      throw new DnsDelegationInspectorError(
        'dns_delegation_identity_required',
        'Configure the server DNS identity before checking delegation',
        409,
      );
    }

    const nsLookup = await safeResolve(resolver, 'resolveNs', normalizedDomain);
    const observed = normalizeNsAnswers(nsLookup.answers);
    const expected = Object.freeze([
      identity.settings.ns1.hostname,
      identity.settings.ns2.hostname,
    ].sort());
    const missing = Object.freeze(expected.filter((entry) => !observed.includes(entry)));
    const extra = Object.freeze(observed.filter((entry) => !expected.includes(entry)));
    const delegation = Object.freeze({
      expected,
      observed,
      missing,
      extra,
      errorCode: nsLookup.errorCode,
      transientFailure: nsLookup.transient,
      ready: missing.length === 0,
    });

    const nameservers = Object.freeze(await Promise.all([
      inspectNameserver(resolver, 'ns1', identity.settings.ns1, normalizedDomain),
      inspectNameserver(resolver, 'ns2', identity.settings.ns2, normalizedDomain),
    ]));
    const status = inspectionStatus(delegation, nameservers);

    return Object.freeze({
      version: 1,
      serverId: identity.serverId,
      dnsIdentityRevision: identity.revision,
      domain: normalizedDomain,
      status,
      ready: status === 'ready',
      delegation,
      nameservers,
      registrarInstructions: registrarInstructions(normalizedDomain, nameservers),
      checkedAt: new Date(now()).toISOString(),
    });
  }

  return Object.freeze({ inspect });
}

export const dnsDelegationInspectorInternals = Object.freeze({
  transientDnsFailure,
  normalizedIp,
  normalizeNsAnswers,
  normalizeIpAnswers,
  inBailiwick,
  inspectionStatus,
  registrarInstructions,
});
