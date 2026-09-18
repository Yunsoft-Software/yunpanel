import { createHash } from 'node:crypto';
import { powerDnsZoneManagerInternals } from '@yunpanel/host-runtime/powerdns-zone-manager';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROOT_ZONE_BLOCKERS = Object.freeze({
  ownership: 'dns_zone_delete_ownership_evidence_required',
  manual: 'dns_zone_manual_rrsets_present',
  dnssec: 'dns_zone_dnssec_retirement_required',
});

export class DnsZoneRetirementError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneRetirementError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function localDomain(domain, localServerId) {
  if (!domain) throw new DnsZoneRetirementError('domain_not_found', 'Domain not found', 404);
  if (!domain || typeof domain !== 'object'
    || typeof domain.id !== 'string' || !domain.id
    || typeof domain.serverId !== 'string' || !domain.serverId
    || typeof domain.primaryDomain !== 'string' || !domain.primaryDomain
    || !Array.isArray(domain.aliases)
    || !Number.isSafeInteger(domain.desiredRevision) || domain.desiredRevision < 1
    || !Number.isSafeInteger(domain.appliedRevision) || domain.appliedRevision < 0) {
    throw new DnsZoneRetirementError(
      'dns_zone_retirement_domain_invalid',
      'Domain state is invalid for DNS retirement impact inspection',
      409,
    );
  }
  if (localServerId && domain.serverId !== localServerId) {
    throw new DnsZoneRetirementError('domain_not_found', 'Domain not found', 404);
  }
  return domain;
}

function descendants(domains, domainId) {
  const pending = [domainId];
  const visited = new Set(pending);
  const result = [];
  while (pending.length > 0) {
    const parentId = pending.shift();
    for (const candidate of domains) {
      if (!candidate || typeof candidate !== 'object' || typeof candidate.id !== 'string') continue;
      if ((candidate.parentDomainId ?? null) !== parentId || visited.has(candidate.id)) continue;
      visited.add(candidate.id);
      pending.push(candidate.id);
      result.push(Object.freeze({
        id: candidate.id,
        primaryDomain: candidate.primaryDomain,
        parentDomainId: candidate.parentDomainId ?? null,
        websiteId: candidate.websiteId ?? null,
      }));
    }
  }
  return Object.freeze(result.sort((left, right) => left.id.localeCompare(right.id)));
}

function zoneImpact(zone) {
  if (!zone) return Object.freeze({
    exists: false,
    snapshotDigest: null,
    kind: null,
    dnssec: false,
    rrsetCount: 0,
    managedRrsetCount: 0,
    manualRrsetCount: 0,
    ownership: 'absent',
  });
  let snapshot;
  try { snapshot = powerDnsZoneManagerInternals.zoneSnapshot(zone); }
  catch (error) {
    throw new DnsZoneRetirementError(
      'dns_zone_retirement_zone_invalid',
      'Authoritative PowerDNS zone state is invalid',
      409,
    );
  }
  const managedRrsetCount = zone.rrsets.filter((rrset) => (
    powerDnsZoneManagerInternals.parseManagedComment(rrset.comments) !== null
  )).length;
  const manualRrsetCount = zone.rrsets.length - managedRrsetCount;
  return Object.freeze({
    exists: true,
    snapshotDigest: digest(snapshot),
    kind: snapshot.kind,
    dnssec: snapshot.dnssec,
    rrsetCount: snapshot.rrsets.length,
    managedRrsetCount,
    manualRrsetCount,
    // Managed comments identify individual RRsets; they do not prove that the
    // entire zone was created by the operation that now wants to retire it.
    ownership: manualRrsetCount > 0 ? 'mixed_unproven' : 'managed_rrsets_unproven',
  });
}

function routingActive(domain) {
  return domain.appliedRevision > 0
    || domain.stagedRevision > 0
    || ['active', 'staged'].includes(domain.state);
}

function previewIdentity(domain, relatedDomains, authoritativeZone) {
  const children = descendants(relatedDomains, domain.id);
  const root = (domain.parentDomainId ?? null) === null;
  const zone = root ? zoneImpact(authoritativeZone) : Object.freeze({
    exists: false,
    snapshotDigest: null,
    kind: null,
    dnssec: false,
    rrsetCount: 0,
    managedRrsetCount: 0,
    manualRrsetCount: 0,
    ownership: 'parent_zone_owned',
  });
  const blockers = [];
  if (children.length > 0) blockers.push('domain_descendants_present');
  if ((domain.websiteId ?? null) !== null) blockers.push('domain_website_binding_present');
  if ((domain.certificateId ?? null) !== null) blockers.push('domain_certificate_present');
  if (routingActive(domain)) blockers.push('domain_routing_active');
  if (root && zone.exists) {
    blockers.push(ROOT_ZONE_BLOCKERS.ownership);
    if (zone.manualRrsetCount > 0) blockers.push(ROOT_ZONE_BLOCKERS.manual);
    if (zone.dnssec) blockers.push(ROOT_ZONE_BLOCKERS.dnssec);
  }

  return Object.freeze({
    version: 1,
    operation: 'dns_zone_retirement_impact',
    domain: Object.freeze({
      id: domain.id,
      serverId: domain.serverId,
      websiteId: domain.websiteId ?? null,
      primaryDomain: domain.primaryDomain,
      parentDomainId: domain.parentDomainId ?? null,
      certificateId: domain.certificateId ?? null,
      desiredRevision: domain.desiredRevision,
      appliedRevision: domain.appliedRevision,
      state: domain.state,
    }),
    hierarchy: Object.freeze({
      descendantCount: children.length,
      descendants: children,
    }),
    routing: Object.freeze({
      active: routingActive(domain),
      stagedRevision: domain.stagedRevision ?? 0,
      appliedRevision: domain.appliedRevision,
      appliedPrimaryDomain: domain.appliedPrimaryDomain ?? null,
    }),
    zone,
    blockers: Object.freeze(blockers),
    retirementPlanReady: blockers.length === 0,
  });
}

export function createDnsZoneRetirementService({
  domainRegistry,
  powerDnsSecretRegistry,
  zoneManager,
  localServerId,
} = {}) {
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || typeof domainRegistry.listDomains !== 'function'
    || !powerDnsSecretRegistry || typeof powerDnsSecretRegistry.materializeForServer !== 'function'
    || !zoneManager || typeof zoneManager.getZone !== 'function'
    || typeof localServerId !== 'string' || !localServerId) {
    throw new DnsZoneRetirementError(
      'dns_zone_retirement_dependencies_invalid',
      'DNS zone retirement dependencies are invalid',
      500,
    );
  }

  async function preview({ domainId } = {}) {
    const domain = localDomain(await domainRegistry.getDomain(domainId), localServerId);
    let relatedDomains;
    try { relatedDomains = await domainRegistry.listDomains(); }
    catch {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_hierarchy_unavailable',
        'Domain hierarchy could not be inspected',
        503,
      );
    }
    if (!Array.isArray(relatedDomains)) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_hierarchy_invalid',
        'Domain hierarchy is invalid',
        503,
      );
    }

    let authoritativeZone = null;
    if ((domain.parentDomainId ?? null) === null) {
      let secret;
      try { secret = await powerDnsSecretRegistry.materializeForServer(domain.serverId); }
      catch {
        throw new DnsZoneRetirementError(
          'dns_zone_retirement_secret_unavailable',
          'PowerDNS credentials are unavailable',
          503,
        );
      }
      if (!secret || typeof secret.apiKey !== 'string' || !secret.apiKey) {
        throw new DnsZoneRetirementError(
          'dns_zone_retirement_secret_invalid',
          'PowerDNS credentials are invalid',
          503,
        );
      }
      try { authoritativeZone = await zoneManager.getZone(domain.primaryDomain, secret.apiKey); }
      catch {
        throw new DnsZoneRetirementError(
          'dns_zone_retirement_inspection_failed',
          'Authoritative PowerDNS zone could not be inspected',
          503,
        );
      }
    }

    const identity = previewIdentity(domain, relatedDomains, authoritativeZone);
    const previewDigest = digest(identity);
    if (!SHA256_PATTERN.test(previewDigest)) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_digest_invalid',
        'DNS zone retirement preview digest is invalid',
        503,
      );
    }
    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation: null,
      sideEffects: false,
    });
  }

  return Object.freeze({ preview });
}

export const dnsZoneRetirementInternals = Object.freeze({
  rootZoneBlockers: ROOT_ZONE_BLOCKERS,
  digest,
  localDomain,
  descendants,
  zoneImpact,
  routingActive,
  previewIdentity,
});
