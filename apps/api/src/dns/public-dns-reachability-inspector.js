export class PublicDnsReachabilityInspectorError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'PublicDnsReachabilityInspectorError';
    this.code = code;
    this.status = status;
  }
}

function unverified(identity) {
  return Object.freeze({
    version: 1,
    status: 'unverified',
    ready: false,
    udp53: null,
    tcp53: null,
    reason: 'external_vantage_probe_unconfigured',
    vantage: null,
    targets: Object.freeze({
      ipv4: identity?.settings?.publicIpv4 ?? null,
      ipv6: identity?.settings?.publicIpv6 ?? null,
    }),
    checkedAt: null,
  });
}

function normalizeProbeResult(result, identity, now) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.externalVantage !== true
    || typeof result.vantage !== 'string' || !result.vantage.trim()
    || typeof result.udp53 !== 'boolean' || typeof result.tcp53 !== 'boolean') {
    throw new PublicDnsReachabilityInspectorError(
      'public_dns_probe_result_invalid',
      'Public DNS probe did not provide verified external-vantage UDP/TCP evidence',
    );
  }
  const ready = result.udp53 && result.tcp53;
  return Object.freeze({
    version: 1,
    status: ready ? 'ready' : 'unreachable',
    ready,
    udp53: result.udp53,
    tcp53: result.tcp53,
    reason: ready ? null : 'public_dns_port_unreachable',
    vantage: result.vantage.trim(),
    targets: Object.freeze({
      ipv4: identity?.settings?.publicIpv4 ?? null,
      ipv6: identity?.settings?.publicIpv6 ?? null,
    }),
    checkedAt: new Date(now()).toISOString(),
  });
}

export function createPublicDnsReachabilityInspector({
  probe = null,
  now = () => Date.now(),
} = {}) {
  if (probe !== null && typeof probe !== 'function') {
    throw new PublicDnsReachabilityInspectorError(
      'public_dns_probe_dependencies_invalid',
      'Public DNS reachability probe dependency is invalid',
    );
  }
  if (typeof now !== 'function') {
    throw new PublicDnsReachabilityInspectorError(
      'public_dns_probe_dependencies_invalid',
      'Public DNS reachability clock dependency is invalid',
    );
  }

  async function inspect({ serverId, identity } = {}) {
    if (typeof serverId !== 'string' || !serverId || !identity?.settings?.publicIpv4) {
      throw new PublicDnsReachabilityInspectorError(
        'public_dns_probe_identity_invalid',
        'Public DNS reachability requires a configured server DNS identity',
        409,
      );
    }
    if (!probe) return unverified(identity);
    let result;
    try {
      result = await probe(Object.freeze({
        serverId,
        ipv4: identity.settings.publicIpv4,
        ipv6: identity.settings.publicIpv6 ?? null,
        port: 53,
        protocols: Object.freeze(['udp', 'tcp']),
      }));
    } catch (error) {
      return Object.freeze({
        version: 1,
        status: 'unverifiable',
        ready: false,
        udp53: null,
        tcp53: null,
        reason: typeof error?.code === 'string' && error.code ? error.code : 'external_vantage_probe_failed',
        vantage: null,
        targets: Object.freeze({
          ipv4: identity.settings.publicIpv4,
          ipv6: identity.settings.publicIpv6 ?? null,
        }),
        checkedAt: new Date(now()).toISOString(),
      });
    }
    return normalizeProbeResult(result, identity, now);
  }

  return Object.freeze({ inspect });
}

export const publicDnsReachabilityInspectorInternals = Object.freeze({
  unverified,
  normalizeProbeResult,
});
