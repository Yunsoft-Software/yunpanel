import { createHash } from 'node:crypto';
import {
  createPowerDnsZoneManager,
  PowerDnsZoneManagerError,
  powerDnsZoneManagerInternals,
} from '@yunpanel/host-runtime/powerdns-zone-manager';
import { renderDnsZoneDesiredState } from './dns-zone-desired-state.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REAPPLY_MANAGED_SOURCES = new Set(['template', 'runtime']);
const PRIMARY_KINDS = new Set(['Primary', 'Master']);

export class DnsZoneReapplyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneReapplyError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function serialFloor(now = Date.now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DnsZoneReapplyError('dns_zone_reapply_clock_invalid', 'DNS zone serial clock is invalid', 503);
  }
  const date = new Date(value);
  const serial = Number.parseInt([
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
    '01',
  ].join(''), 10);
  if (!Number.isSafeInteger(serial) || serial < 1 || serial > 4_294_967_295) {
    throw new DnsZoneReapplyError('dns_zone_reapply_clock_invalid', 'DNS zone serial clock is invalid', 503);
  }
  return serial;
}

function nextSerial(current, now = Date.now) {
  if (!Number.isSafeInteger(current) || current < 1 || current > 4_294_967_295) {
    throw new DnsZoneReapplyError('dns_zone_reapply_serial_invalid', 'Current authoritative SOA serial is unavailable', 409);
  }
  const floor = serialFloor(now);
  const next = current < floor ? floor : current + 1;
  if (!Number.isSafeInteger(next) || next > 4_294_967_295) {
    throw new DnsZoneReapplyError('dns_zone_reapply_serial_exhausted', 'DNS zone serial cannot be advanced safely', 409);
  }
  return next;
}

function rootDomain(domain, localServerId) {
  if (!domain) throw new DnsZoneReapplyError('domain_not_found', 'Domain not found', 404);
  if (typeof domain !== 'object' || typeof domain.id !== 'string'
    || typeof domain.serverId !== 'string' || typeof domain.primaryDomain !== 'string'
    || !Array.isArray(domain.aliases)) {
    throw new DnsZoneReapplyError('dns_zone_reapply_domain_invalid', 'Domain state is invalid', 409);
  }
  if (domain.serverId !== localServerId) {
    throw new DnsZoneReapplyError('dns_zone_reapply_local_server_required', 'Local DNS zone reapply is restricted to this panel host', 404);
  }
  if ((domain.parentDomainId ?? null) !== null) {
    throw new DnsZoneReapplyError('dns_zone_reapply_root_domain_required', 'Only root Domains own authoritative zones', 409);
  }
  return domain;
}

function recordsForDomain(domain, desired) {
  const www = `www.${desired.zoneName}`;
  const wantsWwwAlias = domain.aliases.includes(www);
  const records = desired.records.filter((entry) => !(entry.source === 'template' && entry.key === 'www-alias'));
  if (wantsWwwAlias) {
    const builtIn = desired.records.find((entry) => entry.source === 'template' && entry.key === 'www-alias');
    if (builtIn) records.push(builtIn);
  }
  return Object.freeze(records);
}

function publicRrset(rrset) {
  const managed = rrset.managed ?? powerDnsZoneManagerInternals.parseManagedComment(rrset.comments);
  return Object.freeze({
    owner: String(rrset.name ?? '').replace(/\.$/, ''),
    type: rrset.type,
    ttl: rrset.ttl,
    source: managed?.source ?? 'manual',
    key: managed?.key ?? null,
    templateVersion: managed?.templateVersion ?? null,
  });
}

function desiredRrsetMap(records) {
  const map = new Map();
  for (const record of records) {
    const rrset = powerDnsZoneManagerInternals.desiredRrset(record);
    const key = powerDnsZoneManagerInternals.rrsetKey(rrset);
    if (map.has(key)) {
      throw new DnsZoneReapplyError('dns_zone_reapply_desired_conflict', 'Desired DNS RRsets are not unique', 409);
    }
    map.set(key, rrset);
  }
  return map;
}

function diffZone(existing, records) {
  const desired = desiredRrsetMap(records);
  const current = new Map(existing.rrsets.map((rrset) => [powerDnsZoneManagerInternals.rrsetKey(rrset), rrset]));
  const changes = [];
  const conflicts = [];
  const blockers = [];
  let unchanged = 0;
  let preservedManual = 0;

  for (const [key, wanted] of desired.entries()) {
    const observed = current.get(key) ?? null;
    if (!observed) {
      changes.push(Object.freeze({ action: 'add', ...publicRrset(wanted) }));
      current.delete(key);
      continue;
    }
    if (!observed.managed) {
      conflicts.push(Object.freeze({
        code: 'manual_rrset_conflict',
        ...publicRrset(observed),
        desiredSource: powerDnsZoneManagerInternals.parseManagedComment(wanted.comments)?.source ?? null,
      }));
      current.delete(key);
      continue;
    }
    const wantedMetadata = powerDnsZoneManagerInternals.parseManagedComment(wanted.comments);
    if (!wantedMetadata || observed.managed.source !== wantedMetadata.source) {
      blockers.push(Object.freeze({
        code: 'managed_source_conflict',
        affectsDesired: true,
        ...publicRrset(observed),
        desiredSource: wantedMetadata?.source ?? null,
      }));
      current.delete(key);
      continue;
    }
    if (!powerDnsZoneManagerInternals.sameRecords(observed, wanted)
      || !powerDnsZoneManagerInternals.sameManagedMetadata(observed, wanted)) {
      changes.push(Object.freeze({
        action: 'replace',
        ...publicRrset(wanted),
        previousTemplateVersion: observed.managed.templateVersion ?? null,
      }));
    } else {
      unchanged += 1;
    }
    current.delete(key);
  }

  for (const observed of current.values()) {
    if (!observed.managed) {
      preservedManual += 1;
      continue;
    }
    if (REAPPLY_MANAGED_SOURCES.has(observed.managed.source)) {
      changes.push(Object.freeze({ action: 'delete', ...publicRrset(observed) }));
      continue;
    }
    blockers.push(Object.freeze({
      code: 'managed_source_not_reconciled',
      affectsDesired: false,
      ...publicRrset(observed),
      desiredSource: null,
    }));
  }

  return Object.freeze({
    changes: Object.freeze(changes),
    conflicts: Object.freeze(conflicts),
    blockers: Object.freeze(blockers),
    unchanged,
    preservedManual,
  });
}

function topologyState(existing, secondaryDns) {
  const configured = Array.isArray(secondaryDns) && secondaryDns.length > 0;
  if (!configured) return Object.freeze({ configured: false, primaryKindChangeRequired: false, blocker: null });
  if (PRIMARY_KINDS.has(existing.kind)) {
    return Object.freeze({ configured: true, primaryKindChangeRequired: false, blocker: null });
  }
  if (existing.kind === 'Native') {
    return Object.freeze({ configured: true, primaryKindChangeRequired: true, blocker: null });
  }
  return Object.freeze({
    configured: true,
    primaryKindChangeRequired: false,
    blocker: Object.freeze({
      code: 'zone_kind_conflict',
      affectsDesired: true,
      owner: existing.zoneName,
      type: 'SOA',
      ttl: null,
      source: 'runtime',
      key: null,
      templateVersion: null,
      desiredSource: 'runtime',
      currentKind: existing.kind ?? null,
    }),
  });
}

async function mapped(operation, fallbackCode, fallbackMessage) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsZoneReapplyError) throw error;
    if (error instanceof PowerDnsZoneManagerError) {
      throw new DnsZoneReapplyError(error.code, error.message, error.status);
    }
    if (typeof error?.code === 'string' && Number.isInteger(error?.status)) {
      throw new DnsZoneReapplyError(error.code, error.message ?? fallbackMessage, error.status);
    }
    throw new DnsZoneReapplyError(fallbackCode, fallbackMessage, 503);
  }
}

export function createDnsZoneReapplyService({
  domainRegistry,
  dnsIdentityRegistry,
  dnsZoneTemplateRegistry,
  powerDnsSecretRegistry,
  localServerId,
  zoneManager = createPowerDnsZoneManager(),
  now = Date.now,
} = {}) {
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !dnsIdentityRegistry || typeof dnsIdentityRegistry.getForServer !== 'function'
    || !dnsZoneTemplateRegistry || typeof dnsZoneTemplateRegistry.ensureForServer !== 'function'
    || !powerDnsSecretRegistry || typeof powerDnsSecretRegistry.materializeForServer !== 'function'
    || !zoneManager || typeof zoneManager.getZone !== 'function' || typeof zoneManager.apply !== 'function'
    || typeof localServerId !== 'string' || !localServerId || typeof now !== 'function') {
    throw new DnsZoneReapplyError('dns_zone_reapply_dependencies_invalid', 'DNS zone reapply dependencies are unavailable', 503);
  }

  async function buildPreview(domainId) {
    const domain = rootDomain(
      await mapped(() => domainRegistry.getDomain(domainId), 'dns_zone_reapply_domain_unavailable', 'Domain state is unavailable'),
      localServerId,
    );
    const [identity, template, secret] = await Promise.all([
      mapped(
        () => dnsIdentityRegistry.getForServer(domain.serverId),
        'dns_zone_reapply_identity_unavailable',
        'Server DNS identity is unavailable',
      ),
      mapped(
        () => dnsZoneTemplateRegistry.ensureForServer(domain.serverId),
        'dns_zone_reapply_template_unavailable',
        'DNS Zone Template is unavailable',
      ),
      mapped(
        () => powerDnsSecretRegistry.materializeForServer(domain.serverId),
        'dns_zone_reapply_secret_unavailable',
        'PowerDNS credentials are unavailable',
      ),
    ]);
    if (!identity) throw new DnsZoneReapplyError('dns_zone_reapply_identity_required', 'Server DNS identity is not configured', 409);

    const existing = await mapped(
      () => zoneManager.getZone(domain.primaryDomain, secret.apiKey),
      'dns_zone_reapply_inspection_failed',
      'Authoritative DNS zone could not be inspected',
    );
    if (!existing) {
      throw new DnsZoneReapplyError(
        'dns_zone_reapply_zone_missing',
        'Domain does not currently have a local authoritative PowerDNS zone',
        409,
      );
    }
    if (!Number.isSafeInteger(existing.serial) || existing.serial < 1) {
      throw new DnsZoneReapplyError('dns_zone_reapply_serial_invalid', 'Current authoritative SOA serial is unavailable', 409);
    }

    const secondaryDns = Object.freeze([...(identity.settings?.secondaryDns ?? [])]);
    const topology = topologyState(existing, secondaryDns);
    const observedDesired = renderDnsZoneDesiredState({
      zoneName: domain.primaryDomain,
      template,
      dnsIdentity: identity,
      serial: existing.serial,
    });
    const observedRecords = recordsForDomain(domain, observedDesired);
    const initialDiff = diffZone(existing, observedRecords);
    const desiredBlocked = initialDiff.blockers.some((entry) => entry.affectsDesired === true);
    const changeRequired = initialDiff.changes.length > 0
      || initialDiff.conflicts.length > 0
      || desiredBlocked
      || topology.primaryKindChangeRequired
      || topology.blocker !== null;
    const serial = changeRequired ? nextSerial(existing.serial, now) : existing.serial;
    const desired = serial === existing.serial ? observedDesired : renderDnsZoneDesiredState({
      zoneName: domain.primaryDomain,
      template,
      dnsIdentity: identity,
      serial,
    });
    const records = serial === existing.serial ? observedRecords : recordsForDomain(domain, desired);
    const zoneDiff = serial === existing.serial ? initialDiff : diffZone(existing, records);
    const blockers = Object.freeze([
      ...zoneDiff.blockers,
      ...(topology.blocker ? [topology.blocker] : []),
    ]);
    const applyAllowed = changeRequired
      && zoneDiff.conflicts.length === 0
      && blockers.length === 0;
    const payload = Object.freeze({
      version: 1,
      domainId: domain.id,
      serverId: domain.serverId,
      domainRevision: domain.desiredRevision ?? null,
      zoneName: domain.primaryDomain,
      zoneKind: existing.kind ?? null,
      primaryKindChangeRequired: topology.primaryKindChangeRequired,
      secondaryDns,
      templateVersion: desired.templateVersion,
      templateSnapshotDigest: digest(desired.templateSnapshot),
      dnsIdentityRevision: desired.dnsIdentityRevision,
      observedSerial: existing.serial,
      nextSerial: serial,
      dnssec: existing.dnssec === true,
      records,
      changes: zoneDiff.changes,
      conflicts: zoneDiff.conflicts,
      blockers,
    });
    const previewDigest = digest(payload);
    return Object.freeze({
      ...payload,
      changeRequired,
      noChanges: !changeRequired,
      applyAllowed,
      unchangedRrsetCount: zoneDiff.unchanged,
      preservedManualRrsetCount: zoneDiff.preservedManual,
      previewDigest,
      confirmation: applyAllowed ? `reapply-dns-zone-template:${domain.id}:${previewDigest}` : null,
    });
  }

  async function preview({ domainId } = {}) {
    if (typeof domainId !== 'string' || !domainId) {
      throw new DnsZoneReapplyError('dns_zone_reapply_domain_id_invalid', 'Domain ID is required');
    }
    return buildPreview(domainId);
  }

  async function apply({ domainId, previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
      throw new DnsZoneReapplyError('dns_zone_reapply_confirmation_invalid', 'A current DNS zone reapply preview digest is required', 409);
    }
    const plan = await preview({ domainId });
    if (plan.noChanges) {
      throw new DnsZoneReapplyError('dns_zone_reapply_no_changes', 'DNS zone already matches the current Zone Template and secondary DNS topology', 409);
    }
    if (plan.conflicts.length > 0) {
      throw new DnsZoneReapplyError('dns_zone_reapply_manual_conflict', 'Manual DNS RRsets conflict with the current Zone Template', 409);
    }
    if (plan.blockers.length > 0) {
      throw new DnsZoneReapplyError(
        'dns_zone_reapply_managed_source_blocked',
        'DNS zone contains managed sources or authority topology that this reapply operation cannot safely reconcile',
        409,
      );
    }
    if (!plan.applyAllowed || plan.previewDigest !== previewDigest || plan.confirmation !== confirmation) {
      throw new DnsZoneReapplyError('dns_zone_reapply_confirmation_invalid', 'DNS zone reapply preview is stale or confirmation is invalid', 409);
    }
    const secret = await mapped(
      () => powerDnsSecretRegistry.materializeForServer(plan.serverId),
      'dns_zone_reapply_secret_unavailable',
      'PowerDNS credentials are unavailable',
    );
    const result = await mapped(
      () => zoneManager.apply({
        zoneName: plan.zoneName,
        apiKey: secret.apiKey,
        records: plan.records,
        dnssec: plan.dnssec,
        notifySecondaries: plan.secondaryDns.length > 0,
      }),
      'dns_zone_reapply_apply_failed',
      'DNS zone reapply failed',
    );
    return Object.freeze({
      domainId: plan.domainId,
      serverId: plan.serverId,
      zoneName: plan.zoneName,
      zoneKind: result.kind ?? plan.zoneKind,
      primaryKindChanged: result.primaryKindChanged === true,
      secondaryDns: plan.secondaryDns,
      notifiedSerial: result.notifiedSerial ?? result.notification?.notifiedSerial ?? null,
      notifyAccepted: result.notification?.accepted === true,
      templateVersion: plan.templateVersion,
      dnsIdentityRevision: plan.dnsIdentityRevision,
      serial: result.serial ?? plan.nextSerial,
      changedRrsetCount: result.changedRrsetCount ?? plan.changes.length,
      manualRrsetCount: result.manualRrsetCount ?? plan.preservedManualRrsetCount,
      previewDigest: plan.previewDigest,
      satisfied: result.satisfied === true,
    });
  }

  return Object.freeze({ preview, apply });
}

export const dnsZoneReapplyInternals = Object.freeze({
  serialFloor,
  nextSerial,
  rootDomain,
  recordsForDomain,
  publicRrset,
  desiredRrsetMap,
  diffZone,
  topologyState,
  digest,
});
