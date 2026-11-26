import { createDnsSecondarySyncInspector, DnsSecondarySyncInspectorError } from '@yunpanel/host-runtime/dns-secondary-sync-inspector';
import { createPowerDnsZoneManager, PowerDnsZoneManagerError } from '@yunpanel/host-runtime/powerdns-zone-manager';

export class DnsZoneSecondaryStatusError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneSecondaryStatusError';
    this.code = code;
    this.status = status;
  }
}

function rootDomain(domain, localServerId) {
  if (!domain) throw new DnsZoneSecondaryStatusError('domain_not_found', 'Domain not found', 404);
  if (typeof domain !== 'object' || typeof domain.id !== 'string'
    || typeof domain.serverId !== 'string' || typeof domain.primaryDomain !== 'string') {
    throw new DnsZoneSecondaryStatusError('dns_secondary_domain_invalid', 'Domain state is invalid', 409);
  }
  if (domain.serverId !== localServerId) {
    throw new DnsZoneSecondaryStatusError('dns_secondary_local_server_required', 'Secondary DNS status is available only on this panel host', 404);
  }
  if ((domain.parentDomainId ?? null) !== null) {
    throw new DnsZoneSecondaryStatusError('dns_secondary_root_domain_required', 'Only root Domains own authoritative DNS zones', 409);
  }
  return domain;
}

function mapped(error) {
  if (error instanceof DnsZoneSecondaryStatusError) return error;
  if (error instanceof PowerDnsZoneManagerError || error instanceof DnsSecondarySyncInspectorError) {
    return new DnsZoneSecondaryStatusError(error.code, error.message, error.status);
  }
  return error;
}

function primaryKind(kind) {
  return kind === 'Primary' || kind === 'Master';
}

function notifyEvidence(zone) {
  const current = Number.isSafeInteger(zone?.serial) && zone.serial > 0
    && Number.isSafeInteger(zone?.notifiedSerial) && zone.notifiedSerial >= zone.serial;
  return Object.freeze({
    serial: zone?.serial ?? null,
    notifiedSerial: zone?.notifiedSerial ?? null,
    currentSerialNotified: current,
  });
}

export function dnsZoneSecondaryHealthPolicy({ configured, status, ready, sync } = {}) {
  if (configured === false || status === 'disabled') {
    return Object.freeze({
      healthGate: 'not_applicable',
      severity: 'info',
      recovery: 'none',
      automaticMutationAllowed: false,
    });
  }
  if (status === 'synced' && ready === true) {
    return Object.freeze({
      healthGate: 'pass',
      severity: 'healthy',
      recovery: 'none',
      automaticMutationAllowed: false,
    });
  }
  if (status === 'primary_kind_required') {
    return Object.freeze({
      healthGate: 'block',
      severity: 'error',
      recovery: 'manual_intervention',
      automaticMutationAllowed: false,
    });
  }
  const targetStatuses = Array.isArray(sync?.targets)
    ? sync.targets.map((target) => target?.status).filter((targetStatus) => typeof targetStatus === 'string')
    : [];
  const ahead = targetStatuses.includes('ahead');
  const expectedWarning = status === 'drift' || status === 'unverifiable';
  return Object.freeze({
    healthGate: 'block',
    severity: ahead || !expectedWarning ? 'error' : 'warning',
    recovery: 'observe_only',
    automaticMutationAllowed: false,
  });
}

export function createDnsZoneSecondaryStatusService({
  domainRegistry,
  dnsIdentityRegistry,
  powerDnsSecretRegistry,
  localServerId,
  zoneManager = createPowerDnsZoneManager(),
  secondaryInspector = createDnsSecondarySyncInspector(),
} = {}) {
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !dnsIdentityRegistry || typeof dnsIdentityRegistry.getForServer !== 'function'
    || !powerDnsSecretRegistry || typeof powerDnsSecretRegistry.materializeForServer !== 'function'
    || typeof localServerId !== 'string' || !localServerId
    || !zoneManager || typeof zoneManager.getZone !== 'function'
    || !secondaryInspector || typeof secondaryInspector.inspect !== 'function') {
    throw new DnsZoneSecondaryStatusError('dns_secondary_dependencies_invalid', 'Secondary DNS status dependencies are unavailable', 503);
  }

  async function status({ domainId } = {}) {
    if (typeof domainId !== 'string' || !domainId) {
      throw new DnsZoneSecondaryStatusError('dns_secondary_domain_id_invalid', 'Domain ID is required');
    }
    let domain;
    let identity;
    try {
      domain = rootDomain(await domainRegistry.getDomain(domainId), localServerId);
      identity = await dnsIdentityRegistry.getForServer(domain.serverId);
    } catch (error) { throw mapped(error); }
    if (!identity) {
      throw new DnsZoneSecondaryStatusError('dns_secondary_identity_required', 'Server DNS identity is unavailable', 409);
    }
    const targets = Object.freeze([...(identity.settings?.secondaryDns ?? [])]);
    if (targets.length === 0) {
      const result = {
        version: 1,
        domainId: domain.id,
        serverId: domain.serverId,
        dnsIdentityRevision: identity.revision,
        zoneName: domain.primaryDomain,
        configured: false,
        ready: true,
        status: 'disabled',
        zoneKind: null,
        notify: Object.freeze({ serial: null, notifiedSerial: null, currentSerialNotified: false }),
        sync: Object.freeze({ version: 1, zoneName: domain.primaryDomain, status: 'disabled', ready: true, expectedSerial: null, targets: Object.freeze([]), checkedAt: null }),
      };
      return Object.freeze({ ...result, policy: dnsZoneSecondaryHealthPolicy(result) });
    }

    let secret;
    let zone;
    try {
      secret = await powerDnsSecretRegistry.materializeForServer(domain.serverId);
      zone = await zoneManager.getZone(domain.primaryDomain, secret.apiKey);
    } catch (error) { throw mapped(error); }
    if (!zone) throw new DnsZoneSecondaryStatusError('dns_secondary_zone_not_found', 'Local authoritative DNS zone was not found', 404);
    if (!Number.isSafeInteger(zone.serial) || zone.serial < 1) {
      throw new DnsZoneSecondaryStatusError('dns_secondary_primary_serial_invalid', 'Primary SOA serial is unavailable', 409);
    }

    let sync;
    try {
      sync = await secondaryInspector.inspect({
        zoneName: domain.primaryDomain,
        expectedSerial: zone.serial,
        targets,
      });
    } catch (error) { throw mapped(error); }
    const primary = primaryKind(zone.kind);
    const statusValue = !primary ? 'primary_kind_required' : sync.status;
    const result = {
      version: 1,
      domainId: domain.id,
      serverId: domain.serverId,
      dnsIdentityRevision: identity.revision,
      zoneName: domain.primaryDomain,
      configured: true,
      ready: primary && sync.ready === true,
      status: statusValue,
      zoneKind: zone.kind,
      notify: notifyEvidence(zone),
      sync,
    };
    return Object.freeze({ ...result, policy: dnsZoneSecondaryHealthPolicy(result) });
  }

  return Object.freeze({ status });
}

export const dnsZoneSecondaryStatusInternals = Object.freeze({
  rootDomain,
  primaryKind,
  notifyEvidence,
});
