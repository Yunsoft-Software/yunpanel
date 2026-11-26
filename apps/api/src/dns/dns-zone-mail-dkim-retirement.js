import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DnsZoneMailDkimRetirementError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneMailDkimRetirementError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function request(value, { apply = false } = {}) {
  const fields = new Set(apply
    ? ['mailDomainId', 'expectedRevision', 'previewDigest', 'confirmation']
    : ['mailDomainId', 'expectedRevision']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.mailDomainId !== 'string' || !value.mailDomainId
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
    || (apply && (typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
      || typeof value.confirmation !== 'string' || !value.confirmation || value.confirmation.length > 300))) {
    throw new DnsZoneMailDkimRetirementError(
      'mail_dkim_local_retirement_input_invalid',
      'Local DKIM retirement request is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function previousRecordState(zone, domainName, retirement) {
  if (!zone || zone.zoneName !== domainName || !Number.isSafeInteger(zone.serial) || zone.serial < 1
    || !Array.isArray(zone.rrsets)) {
    throw new DnsZoneMailDkimRetirementError(
      'mail_dkim_local_retirement_zone_invalid',
      'Authoritative DNS zone state is invalid',
      503,
    );
  }
  const owner = retirement.previousDnsRecord?.name;
  const value = retirement.previousDnsRecord?.value;
  if (retirement.previousDnsRecord?.type !== 'TXT'
    || owner !== `${retirement.previousSelector}._domainkey.${domainName}`
    || typeof value !== 'string' || !value) {
    throw new DnsZoneMailDkimRetirementError(
      'mail_dkim_local_retirement_state_invalid',
      'DKIM retirement DNS metadata is invalid',
      409,
    );
  }
  const matches = zone.rrsets.filter((rrset) => rrset.owner === owner && rrset.type === 'TXT');
  if (matches.length === 0) {
    return Object.freeze({ state: 'absent', owner, key: `mail-dkim-${retirement.previousSelector}` });
  }
  if (matches.length !== 1) {
    throw new DnsZoneMailDkimRetirementError(
      'mail_dkim_local_retirement_record_ambiguous',
      'Previous DKIM selector has ambiguous authoritative RRset state',
      409,
    );
  }
  const rrset = matches[0];
  const expectedKey = `mail-dkim-${retirement.previousSelector}`;
  if (rrset.source !== 'mail' || rrset.key !== expectedKey
    || !Array.isArray(rrset.records) || rrset.records.length !== 1
    || rrset.records[0]?.disabled === true || rrset.records[0]?.value !== value) {
    throw new DnsZoneMailDkimRetirementError(
      'mail_dkim_local_retirement_record_conflict',
      'Previous DKIM selector is not the exact YunPanel-managed retirement RRset',
      409,
    );
  }
  return Object.freeze({ state: 'managed', owner, key: expectedKey });
}

function retirementOnlyPlan(zonePreview, previous) {
  if (previous.state === 'absent') return Object.freeze({ ready: true, mutationRequired: false, blocker: null });
  if (!zonePreview || zonePreview.applyAllowed !== true || zonePreview.noChanges === true
    || !Array.isArray(zonePreview.changes) || !Array.isArray(zonePreview.conflicts)
    || !Array.isArray(zonePreview.blockers) || zonePreview.conflicts.length > 0 || zonePreview.blockers.length > 0) {
    return Object.freeze({ ready: false, mutationRequired: true, blocker: 'dns_zone_reapply_blocked' });
  }
  const meaningful = zonePreview.changes.filter(
    (change) => !(change.action === 'replace' && change.source === 'template' && change.key === 'zone-soa'),
  );
  const exact = meaningful.length === 1
    && meaningful[0].action === 'delete'
    && meaningful[0].source === 'mail'
    && meaningful[0].key === previous.key
    && meaningful[0].owner === previous.owner
    && meaningful[0].type === 'TXT';
  return Object.freeze({
    ready: exact,
    mutationRequired: true,
    blocker: exact ? null : 'mail_dkim_local_retirement_requires_clean_zone',
  });
}

export function createDnsZoneMailDkimRetirementService({
  mailDomainRegistry,
  mailDkimRetirementRegistry,
  domainRegistry,
  dnsZoneRecordsService,
  dnsZoneReapplyRuntime,
  localServerId,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !mailDkimRetirementRegistry || typeof mailDkimRetirementRegistry.getRetirement !== 'function'
    || typeof mailDkimRetirementRegistry.beginRetirement !== 'function'
    || typeof mailDkimRetirementRegistry.clearRetirement !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !dnsZoneRecordsService || typeof dnsZoneRecordsService.getZone !== 'function'
    || !dnsZoneReapplyRuntime || typeof dnsZoneReapplyRuntime.preview !== 'function'
    || typeof dnsZoneReapplyRuntime.start !== 'function'
    || typeof localServerId !== 'string' || !localServerId) {
    throw new DnsZoneMailDkimRetirementError(
      'mail_dkim_local_retirement_dependencies_invalid',
      'Local DKIM retirement dependencies are unavailable',
      503,
    );
  }

  async function scope(input) {
    const mailDomain = await mailDomainRegistry.getMailDomain(input.mailDomainId);
    if (!mailDomain || mailDomain.managementMode !== 'local' || mailDomain.status !== 'enabled'
      || typeof mailDomain.webDomainId !== 'string' || !mailDomain.webDomainId) {
      throw new DnsZoneMailDkimRetirementError(
        mailDomain ? 'mail_domain_not_locally_enabled' : 'mail_domain_not_found',
        mailDomain ? 'DKIM retirement requires an enabled local mail domain' : 'Mail domain was not found',
        mailDomain ? 409 : 404,
      );
    }
    const domain = await domainRegistry.getDomain(mailDomain.webDomainId);
    if (!domain || domain.id !== mailDomain.webDomainId || domain.serverId !== localServerId
      || domain.primaryDomain !== mailDomain.domainName || (domain.parentDomainId ?? null) !== null) {
      throw new DnsZoneMailDkimRetirementError('mail_domain_not_found', 'Mail domain was not found', 404);
    }
    const retirement = await mailDkimRetirementRegistry.getRetirement(mailDomain.id);
    if (!retirement || !['dns_retirement_pending', 'dns_retirement_applying'].includes(retirement.phase)) {
      throw new DnsZoneMailDkimRetirementError(
        'mail_dkim_retirement_not_found',
        'Pending local DKIM retirement was not found',
        404,
      );
    }
    if (retirement.revision !== input.expectedRevision) {
      throw new DnsZoneMailDkimRetirementError(
        'stale_mail_dkim_retirement_revision',
        'DKIM retirement state changed; refresh and retry',
        409,
      );
    }
    return Object.freeze({ mailDomain, domain, retirement });
  }

  async function buildPreview(rawInput) {
    const input = request(rawInput);
    const scoped = await scope(input);
    const retirePendingDkim = scoped.retirement.phase === 'dns_retirement_pending'
      ? Object.freeze({
        mailDomainId: scoped.mailDomain.id,
        expectedRevision: scoped.retirement.revision,
        selector: scoped.retirement.previousSelector,
      })
      : null;
    const [zonePreview, zone] = await Promise.all([
      dnsZoneReapplyRuntime.preview({ domainId: scoped.domain.id, retirePendingDkim }),
      dnsZoneRecordsService.getZone({ domainId: scoped.domain.id }),
    ]);
    if (zonePreview.domainId !== scoped.domain.id || zonePreview.zoneName !== scoped.domain.primaryDomain
      || zone.domainId !== scoped.domain.id || zone.serverId !== scoped.domain.serverId
      || zonePreview.observedSerial !== zone.serial
      || typeof zonePreview.previewDigest !== 'string' || !SHA256_PATTERN.test(zonePreview.previewDigest)
      || zonePreview.mailState?.retirementPhase !== 'dns_retirement_applying'
      || zonePreview.mailState?.retirementRevision !== (scoped.retirement.phase === 'dns_retirement_pending'
        ? scoped.retirement.revision + 1
        : scoped.retirement.revision)) {
      throw new DnsZoneMailDkimRetirementError(
        'mail_dkim_local_retirement_preview_inconsistent',
        'Authoritative DNS and retirement preview state are inconsistent',
        409,
      );
    }
    const previous = previousRecordState(zone, scoped.domain.primaryDomain, scoped.retirement);
    const plan = retirementOnlyPlan(zonePreview, previous);
    const identity = Object.freeze({
      version: 1,
      operation: 'mail_dkim_local_retirement',
      mailDomainId: scoped.mailDomain.id,
      retirementRevision: scoped.retirement.revision,
      retirementPhase: scoped.retirement.phase,
      previousSelector: scoped.retirement.previousSelector,
      domainId: scoped.domain.id,
      serverId: scoped.domain.serverId,
      zoneName: scoped.domain.primaryDomain,
      authoritativeSerial: zone.serial,
      previousRecordState: previous.state,
      zonePreviewDigest: zonePreview.previewDigest,
      zoneMailStateDigest: zonePreview.mailStateDigest,
      mutationRequired: plan.mutationRequired,
      blocker: plan.blocker,
    });
    const previewDigest = digest(identity);
    return Object.freeze({
      ...identity,
      readyToApply: plan.ready,
      previewDigest,
      confirmation: plan.ready
        ? `retire-local-mail-dkim:${scoped.mailDomain.id}:${scoped.retirement.revision}:${previewDigest}`
        : null,
      zoneChanges: Object.freeze([...(zonePreview.changes ?? [])]),
      zoneConflicts: Object.freeze([...(zonePreview.conflicts ?? [])]),
      zoneBlockers: Object.freeze([...(zonePreview.blockers ?? [])]),
      sideEffects: false,
    });
  }

  async function preview(rawInput) {
    return buildPreview(rawInput);
  }

  async function clear(scoped) {
    await mailDkimRetirementRegistry.clearRetirement(scoped.mailDomain.id, {
      expectedRevision: scoped.retirement.revision,
      confirmation: `clear-dkim-retirement:${scoped.mailDomain.id}:${scoped.retirement.previousSelector}:${scoped.retirement.revision}`,
    });
    return Object.freeze({
      completed: true,
      retirementCleared: true,
      operation: null,
      sideEffects: Object.freeze({ dnsChanged: false }),
    });
  }

  async function apply(rawInput) {
    const input = request(rawInput, { apply: true });
    const selected = await buildPreview({
      mailDomainId: input.mailDomainId,
      expectedRevision: input.expectedRevision,
    });
    if (!selected.readyToApply || selected.previewDigest !== input.previewDigest
      || selected.confirmation !== input.confirmation) {
      throw new DnsZoneMailDkimRetirementError(
        'mail_dkim_local_retirement_preview_stale',
        'Local DKIM retirement preview is stale, blocked or confirmation is invalid',
        409,
      );
    }
    let scoped = await scope({ mailDomainId: input.mailDomainId, expectedRevision: input.expectedRevision });
    if (scoped.retirement.phase === 'dns_retirement_pending') {
      const applying = await mailDkimRetirementRegistry.beginRetirement(scoped.mailDomain.id, {
        expectedRevision: scoped.retirement.revision,
        confirmation: `begin-dkim-retirement:${scoped.mailDomain.id}:${scoped.retirement.previousSelector}:${scoped.retirement.revision}`,
      });
      scoped = await scope({ mailDomainId: input.mailDomainId, expectedRevision: applying.revision });
    }
    const current = await buildPreview({
      mailDomainId: scoped.mailDomain.id,
      expectedRevision: scoped.retirement.revision,
    });
    if (current.previousRecordState === 'absent') return clear(scoped);
    if (!current.readyToApply || current.zonePreviewDigest !== selected.zonePreviewDigest) {
      throw new DnsZoneMailDkimRetirementError(
        'mail_dkim_local_retirement_preview_stale',
        'Authoritative DNS changed after retirement intent was persisted',
        409,
      );
    }
    const operation = await dnsZoneReapplyRuntime.start({
      domainId: scoped.domain.id,
      previewDigest: current.zonePreviewDigest,
      confirmation: `reapply-dns-zone-template:${scoped.domain.id}:${current.zonePreviewDigest}`,
    });
    if (operation?.status !== 'succeeded') {
      return Object.freeze({
        completed: false,
        retirementCleared: false,
        operation,
        sideEffects: Object.freeze({ dnsChanged: false }),
      });
    }
    const verified = await buildPreview({
      mailDomainId: scoped.mailDomain.id,
      expectedRevision: scoped.retirement.revision,
    });
    if (verified.previousRecordState !== 'absent') {
      throw new DnsZoneMailDkimRetirementError(
        'mail_dkim_local_retirement_postcondition_failed',
        'Previous DKIM selector is still present after zone reapply',
        503,
      );
    }
    const cleared = await clear(scoped);
    return Object.freeze({
      ...cleared,
      operation,
      sideEffects: Object.freeze({ dnsChanged: true }),
    });
  }

  return Object.freeze({ preview, apply });
}

export const dnsZoneMailDkimRetirementInternals = Object.freeze({
  digest,
  request,
  previousRecordState,
  retirementOnlyPlan,
});
