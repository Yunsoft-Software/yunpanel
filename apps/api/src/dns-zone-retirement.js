import { createHash } from 'node:crypto';
import {
  createPowerDnsZoneManager,
  powerDnsZoneManagerInternals,
} from '@yunpanel/host-runtime/powerdns-zone-manager';
import { websiteDnsZoneProvisioningInternals } from './website-dns-zone-provisioning-handler.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROOT_ZONE_BLOCKERS = Object.freeze({
  ownership: 'dns_zone_delete_ownership_evidence_required',
  manual: 'dns_zone_manual_rrsets_present',
  dnssec: 'dns_zone_dnssec_retirement_required',
  retention: 'dns_zone_delete_retention_policy_required',
  mail: 'dns_zone_mail_dependencies_present',
  mailInventory: 'dns_zone_mail_dependency_inventory_unavailable',
  jobs: 'dns_zone_domain_jobs_active',
  jobInventory: 'dns_zone_job_inventory_unavailable',
});
const MAX_RETENTION_DAYS = 3650;


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

function retentionPolicy(value) {
  if (value === null || value === undefined) {
    return Object.freeze({ configured: false, snapshotRetentionDays: null });
  }
  const fields = new Set(['snapshotRetentionDays']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !Number.isSafeInteger(value.snapshotRetentionDays)
    || value.snapshotRetentionDays < 1 || value.snapshotRetentionDays > MAX_RETENTION_DAYS) {
    throw new DnsZoneRetirementError(
      'dns_zone_retirement_policy_invalid',
      'DNS zone retirement retention policy is invalid',
      500,
    );
  }
  return Object.freeze({
    configured: true,
    snapshotRetentionDays: value.snapshotRetentionDays,
  });
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

function provisioningOwnership(domain, operations) {
  if ((domain.parentDomainId ?? null) !== null) {
    return Object.freeze({ status: 'parent_zone_owned', operationId: null, evidenceDigest: null });
  }
  if (operations === null) {
    return Object.freeze({ status: 'unavailable', operationId: null, evidenceDigest: null });
  }
  if (!Array.isArray(operations)) {
    throw new DnsZoneRetirementError(
      'dns_zone_retirement_provisioning_history_invalid',
      'Website provisioning history is invalid',
      503,
    );
  }

  const candidates = [];
  let invalidEvidenceCount = 0;
  for (const operation of operations) {
    if (!operation || typeof operation.websiteId !== 'string' || !operation.websiteId
      || !Array.isArray(operation.steps)) continue;
    for (const step of operation.steps) {
      if (!step || step.kind !== 'dns_zone' || step.state !== 'succeeded'
        || step.compensation?.state === 'succeeded' || !step.evidence || step.evidence.created !== true) {
        continue;
      }
      try {
        const ownership = websiteDnsZoneProvisioningInternals.compensationOwnership(
          { intent: step.intent, evidence: step.evidence },
          websiteDnsZoneProvisioningInternals.normalizedIntent({ intent: step.intent }),
        );
        if (!ownership.operationOwned
          || step.intent.serverId !== domain.serverId
          || step.intent.webDomainId !== domain.id
          || step.intent.zoneName !== domain.primaryDomain) {
          invalidEvidenceCount += 1;
          continue;
        }
        candidates.push(Object.freeze({
          operationId: operation.operationId,
          updatedAt: operation.updatedAt,
          evidenceDigest: digest({
            operationId: operation.operationId,
            websiteId: operation.websiteId,
            intent: step.intent,
            evidence: step.evidence,
          }),
        }));
      } catch {
        invalidEvidenceCount += 1;
      }
    }
  }

  if (candidates.length === 1) {
    return Object.freeze({
      status: 'provisioning_created',
      operationId: candidates[0].operationId,
      updatedAt: candidates[0].updatedAt,
      evidenceDigest: candidates[0].evidenceDigest,
    });
  }
  if (candidates.length > 1) {
    return Object.freeze({
      status: 'ambiguous',
      operationId: null,
      evidenceDigest: null,
      candidateCount: candidates.length,
    });
  }
  return Object.freeze({
    status: invalidEvidenceCount > 0 ? 'invalid' : 'not_found',
    operationId: null,
    evidenceDigest: null,
  });
}

function routingActive(domain) {
  return domain.appliedRevision > 0
    || domain.stagedRevision > 0
    || ['active', 'staged'].includes(domain.state);
}

function previewIdentity(
  domain,
  relatedDomains,
  authoritativeZone,
  ownershipOrigin = null,
  rawRetentionPolicy = null,
  dependencyImpact = null,
) {
  const children = descendants(relatedDomains, domain.id);
  const root = (domain.parentDomainId ?? null) === null;
  const ownership = ownershipOrigin ?? provisioningOwnership(domain, null);
  const retention = retentionPolicy(rawRetentionPolicy);
  const dependencies = dependencyImpact ?? Object.freeze({
    mail: Object.freeze({ status: 'unavailable', count: 0, ids: Object.freeze([]) }),
    jobs: Object.freeze({ status: 'unavailable', count: 0, ids: Object.freeze([]) }),
  });
  const zoneBase = root ? zoneImpact(authoritativeZone) : Object.freeze({
    exists: false,
    snapshotDigest: null,
    kind: null,
    dnssec: false,
    rrsetCount: 0,
    managedRrsetCount: 0,
    manualRrsetCount: 0,
    ownership: 'parent_zone_owned',
  });
  const zone = Object.freeze({
    ...zoneBase,
    ownership: root && zoneBase.exists && ownership.status === 'provisioning_created'
      ? (zoneBase.manualRrsetCount > 0 ? 'provisioning_created_mixed' : 'provisioning_created')
      : zoneBase.ownership,
    ownershipOrigin: ownership,
  });
  const blockers = [];
  if (children.length > 0) blockers.push('domain_descendants_present');
  if ((domain.websiteId ?? null) !== null) blockers.push('domain_website_binding_present');
  if ((domain.certificateId ?? null) !== null) blockers.push('domain_certificate_present');
  if (routingActive(domain)) blockers.push('domain_routing_active');
  if (root && zone.exists) {
    if (dependencies.mail.status !== 'available') blockers.push(ROOT_ZONE_BLOCKERS.mailInventory);
    else if (dependencies.mail.count > 0) blockers.push(ROOT_ZONE_BLOCKERS.mail);
    if (dependencies.jobs.status !== 'available') blockers.push(ROOT_ZONE_BLOCKERS.jobInventory);
    else if (dependencies.jobs.count > 0) blockers.push(ROOT_ZONE_BLOCKERS.jobs);
    if (ownership.status !== 'provisioning_created') {
      blockers.push(ROOT_ZONE_BLOCKERS.ownership);
    } else if (!retention.configured) {
      blockers.push(ROOT_ZONE_BLOCKERS.retention);
    }
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
    retention,
    dependencies,
    blockers: Object.freeze(blockers),
    retirementPlanReady: blockers.length === 0,
  });
}

export function createDnsZoneRetirementService({
  domainRegistry,
  powerDnsSecretRegistry,
  provisioningRegistry = null,
  mailDomainRegistry = null,
  jobRegistry = null,
  retentionPolicy: rawRetentionPolicy = null,
  zoneManager = createPowerDnsZoneManager(),
  localServerId,
} = {}) {
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || typeof domainRegistry.listDomains !== 'function'
    || !powerDnsSecretRegistry || typeof powerDnsSecretRegistry.materializeForServer !== 'function'
    || (provisioningRegistry !== null && typeof provisioningRegistry.listForDnsZone !== 'function')
    || (mailDomainRegistry !== null && typeof mailDomainRegistry.listMailDomains !== 'function')
    || (jobRegistry !== null && typeof jobRegistry.listJobs !== 'function')
    || !zoneManager || typeof zoneManager.getZone !== 'function'
    || typeof zoneManager.inspectSnapshotDeletion !== 'function'
    || typeof zoneManager.deleteSnapshot !== 'function'
    || typeof localServerId !== 'string' || !localServerId) {
    throw new DnsZoneRetirementError(
      'dns_zone_retirement_dependencies_invalid',
      'DNS zone retirement dependencies are invalid',
      500,
    );
  }
  const configuredRetentionPolicy = retentionPolicy(rawRetentionPolicy);

  async function materializeSecret(serverId) {
    let secret;
    try { secret = await powerDnsSecretRegistry.materializeForServer(serverId); }
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
    return secret;
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

    let provisioningOperations = null;
    if ((domain.parentDomainId ?? null) === null && provisioningRegistry !== null) {
      try {
        provisioningOperations = await provisioningRegistry.listForDnsZone({
          serverId: domain.serverId,
          webDomainId: domain.id,
          zoneName: domain.primaryDomain,
        });
      } catch {
        throw new DnsZoneRetirementError(
          'dns_zone_retirement_provisioning_history_unavailable',
          'Website provisioning ownership history could not be inspected',
          503,
        );
      }
    }
    const ownershipOrigin = provisioningOwnership(domain, provisioningOperations);

    let mailDependencies = null;
    if (mailDomainRegistry !== null) {
      try {
        const allMailDomains = await mailDomainRegistry.listMailDomains();
        if (!Array.isArray(allMailDomains)) throw new Error('invalid mail inventory');
        mailDependencies = allMailDomains
          .filter((entry) => entry?.webDomainId === domain.id)
          .map((entry) => String(entry.id))
          .filter((id) => id.length > 0 && id.length <= 128)
          .sort();
      } catch {
        throw new DnsZoneRetirementError(
          'dns_zone_retirement_mail_inventory_unavailable',
          'Mail-domain dependencies could not be inspected',
          503,
        );
      }
    }
    let domainJobs = null;
    if (jobRegistry !== null) {
      try {
        const jobs = await jobRegistry.listJobs({ resourceType: 'domain', resourceId: domain.id });
        if (!Array.isArray(jobs)) throw new Error('invalid job inventory');
        domainJobs = jobs
          .filter((job) => ['queued', 'running'].includes(job?.status))
          .map((job) => String(job.id))
          .filter((id) => id.length > 0 && id.length <= 128)
          .sort();
      } catch {
        throw new DnsZoneRetirementError(
          'dns_zone_retirement_job_inventory_unavailable',
          'Active Domain jobs could not be inspected',
          503,
        );
      }
    }
    const dependencyImpact = Object.freeze({
      mail: Object.freeze({
        status: mailDependencies === null ? 'unavailable' : 'available',
        count: mailDependencies?.length ?? 0,
        ids: Object.freeze(mailDependencies ?? []),
      }),
      jobs: Object.freeze({
        status: domainJobs === null ? 'unavailable' : 'available',
        count: domainJobs?.length ?? 0,
        ids: Object.freeze(domainJobs ?? []),
      }),
    });

    let authoritativeZone = null;
    if ((domain.parentDomainId ?? null) === null) {
      const secret = await materializeSecret(domain.serverId);
      try { authoritativeZone = await zoneManager.getZone(domain.primaryDomain, secret.apiKey); }
      catch {
        throw new DnsZoneRetirementError(
          'dns_zone_retirement_inspection_failed',
          'Authoritative PowerDNS zone could not be inspected',
          503,
        );
      }
    }

    const identity = previewIdentity(
      domain,
      relatedDomains,
      authoritativeZone,
      ownershipOrigin,
      configuredRetentionPolicy.configured
        ? { snapshotRetentionDays: configuredRetentionPolicy.snapshotRetentionDays }
        : null,
      dependencyImpact,
    );
    const previewDigest = digest(identity);
    if (!SHA256_PATTERN.test(previewDigest)) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_digest_invalid',
        'DNS zone retirement preview digest is invalid',
        503,
      );
    }
    const confirmation = identity.retirementPlanReady && identity.zone.exists
      ? `retire-authoritative-zone:${domain.id}:${domain.desiredRevision}:${identity.zone.snapshotDigest}:${identity.zone.ownershipOrigin.evidenceDigest}:${identity.retention.snapshotRetentionDays}:${previewDigest}`
      : null;
    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation,
      sideEffects: false,
    });
  }

  async function captureDeletionSnapshot({ domainId, previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_confirmation_invalid',
        'A current DNS zone retirement preview digest and exact confirmation are required',
        409,
      );
    }
    const current = await preview({ domainId });
    if (!current.zone.exists) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_zone_absent',
        'Authoritative PowerDNS zone is already absent',
        409,
      );
    }
    if (!current.retirementPlanReady || current.confirmation === null) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_blocked',
        'DNS zone retirement is blocked by current Domain or authoritative DNS state',
        409,
      );
    }
    if (current.previewDigest !== previewDigest || current.confirmation !== confirmation) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_preview_stale',
        'DNS zone retirement preview changed before snapshot capture',
        409,
      );
    }

    const domain = localDomain(await domainRegistry.getDomain(domainId), localServerId);
    const secret = await materializeSecret(domain.serverId);
    let authoritativeZone;
    try { authoritativeZone = await zoneManager.getZone(domain.primaryDomain, secret.apiKey); }
    catch {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_inspection_failed',
        'Authoritative PowerDNS zone could not be inspected',
        503,
      );
    }
    if (!authoritativeZone) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_preview_stale',
        'Authoritative PowerDNS zone disappeared before snapshot capture',
        409,
      );
    }
    let snapshot;
    try { snapshot = powerDnsZoneManagerInternals.zoneSnapshot(authoritativeZone); }
    catch {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_zone_invalid',
        'Authoritative PowerDNS zone state is invalid',
        409,
      );
    }
    const snapshotDigest = digest(snapshot);
    if (snapshotDigest !== current.zone.snapshotDigest
      || domain.desiredRevision !== current.domain.desiredRevision
      || domain.primaryDomain !== current.domain.primaryDomain) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_preview_stale',
        'Authoritative DNS or Domain state changed before snapshot capture',
        409,
      );
    }
    return Object.freeze({
      version: 1,
      domainId: domain.id,
      serverId: domain.serverId,
      zoneName: domain.primaryDomain,
      domainRevision: domain.desiredRevision,
      previewDigest: current.previewDigest,
      snapshotDigest,
      ownershipEvidenceDigest: current.zone.ownershipOrigin.evidenceDigest,
      snapshotRetentionDays: current.retention.snapshotRetentionDays,
      confirmation: current.confirmation,
      snapshot,
    });
  }

  async function inspectDeletion({ serverId, zoneName, snapshot } = {}) {
    if (serverId !== localServerId) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_local_server_required',
        'DNS zone retirement is restricted to this panel host',
        404,
      );
    }
    const secret = await materializeSecret(serverId);
    try {
      return await zoneManager.inspectSnapshotDeletion({
        zoneName,
        apiKey: secret.apiKey,
        snapshot,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('powerdns_')) {
        throw new DnsZoneRetirementError(error.code, error.message, error.status ?? 503);
      }
      throw error;
    }
  }

  async function deleteCapturedSnapshot({ serverId, zoneName, snapshot } = {}) {
    if (serverId !== localServerId) {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_local_server_required',
        'DNS zone retirement is restricted to this panel host',
        404,
      );
    }
    const secret = await materializeSecret(serverId);
    try {
      return await zoneManager.deleteSnapshot({
        zoneName,
        apiKey: secret.apiKey,
        snapshot,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('powerdns_')) {
        throw new DnsZoneRetirementError(error.code, error.message, error.status ?? 503);
      }
      throw error;
    }
  }

  return Object.freeze({
    preview,
    captureDeletionSnapshot,
    inspectDeletion,
    deleteCapturedSnapshot,
  });
}

export const dnsZoneRetirementInternals = Object.freeze({
  rootZoneBlockers: ROOT_ZONE_BLOCKERS,
  maxRetentionDays: MAX_RETENTION_DAYS,
  digest,
  retentionPolicy,
  localDomain,
  descendants,
  zoneImpact,
  provisioningOwnership,
  routingActive,
  previewIdentity,
});
