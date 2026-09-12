import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';

const KINDS = new Set(['current', 'retirement']);
const DEFAULT_TTL = 300;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class MailDkimDnsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDkimDnsError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function input(value, { apply = false } = {}) {
  const fields = new Set(apply
    ? ['kind', 'expectedRevision', 'previewDigest', 'confirmation']
    : ['kind', 'expectedRevision']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !KINDS.has(value.kind) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
    || (apply && (typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
      || typeof value.confirmation !== 'string' || value.confirmation.length > 300))) {
    throw new MailDkimDnsError('mail_dkim_dns_input_invalid', 'DKIM DNS operation fields are invalid');
  }
  return Object.freeze({ ...value });
}

function providerRecord(record, { ttl = DEFAULT_TTL } = {}) {
  if (!record || record.type !== 'TXT' || typeof record.name !== 'string' || typeof record.value !== 'string') {
    throw new MailDkimDnsError('mail_dkim_dns_state_invalid', 'DKIM DNS metadata is invalid', 409);
  }
  return Object.freeze({
    type: 'TXT',
    name: record.name,
    content: record.value,
    ttl,
    proxied: false,
  });
}

function sameContent(left, right) {
  return left?.type === 'TXT' && right?.type === 'TXT'
    && left.name === right.name && left.content === right.content;
}

export function createMailDkimDnsService({
  mailDomainRegistry,
  mailDkimRegistry,
  mailDkimRetirementRegistry,
  domainRegistry,
  dnsHostingRegistry,
  dnsProviderCredentialRegistry,
  dnsRecordManager,
  jobRegistry,
  localServerId = null,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || !mailDkimRetirementRegistry || typeof mailDkimRetirementRegistry.getRetirement !== 'function'
    || typeof mailDkimRetirementRegistry.clearRetirement !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !dnsHostingRegistry || typeof dnsHostingRegistry.listZones !== 'function'
    || !dnsProviderCredentialRegistry || typeof dnsProviderCredentialRegistry.getForZone !== 'function'
    || typeof dnsProviderCredentialRegistry.materialize !== 'function'
    || !dnsRecordManager || typeof dnsRecordManager.inspectRecord !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function') {
    throw new MailDkimDnsError('mail_dkim_dns_dependencies_invalid', 'DKIM DNS dependencies are unavailable', 503);
  }

  async function scope(mailDomainId) {
    const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
    if (!mailDomain) throw new MailDkimDnsError('mail_domain_not_found', 'Mail domain was not found', 404);
    if (mailDomain.managementMode !== 'local' || !mailDomain.webDomainId) {
      throw new MailDkimDnsError('mail_domain_not_locally_managed', 'DKIM DNS requires a local mail domain bound to a web Domain', 409);
    }
    const webDomain = await domainRegistry.getDomain(mailDomain.webDomainId);
    if (!webDomain || webDomain.primaryDomain !== mailDomain.domainName
      || (localServerId !== null && webDomain.serverId !== localServerId)) {
      throw new MailDkimDnsError('mail_domain_not_found', 'Mail domain was not found', 404);
    }
    const zones = (await dnsHostingRegistry.listZones())
      .filter((zone) => zone.webDomainId === webDomain.id && zone.zoneName === mailDomain.domainName);
    if (zones.length !== 1) {
      throw new MailDkimDnsError(
        zones.length === 0 ? 'mail_dkim_dns_zone_required' : 'mail_dkim_dns_zone_ambiguous',
        zones.length === 0
          ? 'DKIM DNS automation requires one DNS zone bound to this web Domain'
          : 'DKIM DNS automation found ambiguous DNS zone state',
        409,
      );
    }
    const zone = zones[0];
    const credential = await dnsProviderCredentialRegistry.getForZone(zone.id);
    if (!credential?.configured || credential.provider !== 'cloudflare') {
      throw new MailDkimDnsError('mail_dkim_dns_credential_required', 'A Cloudflare DNS provider credential is required', 409);
    }
    const secret = await dnsProviderCredentialRegistry.materialize(credential.id);
    return Object.freeze({ mailDomain, webDomain, zone, credential, secret });
  }

  async function assertZoneIdle(zoneId) {
    const jobs = await jobRegistry.listJobs({ resourceType: 'dns_zone', resourceId: zoneId });
    if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
      throw new MailDkimDnsError('dns_zone_job_conflict', 'Wait for the active DNS zone operation', 409);
    }
  }

  async function desiredState(mailDomainId, kind, expectedRevision) {
    if (kind === 'current') {
      const key = await mailDkimRegistry.getKey(mailDomainId);
      if (!key) throw new MailDkimDnsError('mail_dkim_key_not_found', 'DKIM key was not found', 404);
      if (key.revision !== expectedRevision) {
        throw new MailDkimDnsError('stale_mail_dkim_revision', 'DKIM key state changed; refresh and retry', 409);
      }
      return Object.freeze({
        revision: key.revision,
        selector: key.selector,
        dnsRecord: key.dnsRecord,
      });
    }
    const retirement = await mailDkimRetirementRegistry.getRetirement(mailDomainId);
    if (!retirement || retirement.phase !== 'dns_retirement_pending') {
      throw new MailDkimDnsError('mail_dkim_retirement_not_found', 'Pending DKIM DNS retirement was not found', 404);
    }
    if (retirement.revision !== expectedRevision) {
      throw new MailDkimDnsError(
        'stale_mail_dkim_retirement_revision',
        'DKIM retirement state changed; refresh and retry',
        409,
      );
    }
    return Object.freeze({
      revision: retirement.revision,
      selector: retirement.previousSelector,
      dnsRecord: retirement.previousDnsRecord,
    });
  }

  async function buildPreview(rawInput) {
    const request = input(rawInput);
    const scoped = await scope(request.mailDomainId);
    await assertZoneIdle(scoped.zone.id);
    const desired = await desiredState(request.mailDomainId, request.kind, request.expectedRevision);
    const canonicalRecord = providerRecord(desired.dnsRecord);
    const snapshot = await dnsRecordManager.inspectRecord({
      provider: scoped.credential.provider,
      credentialId: scoped.credential.id,
      dnsZoneId: scoped.zone.id,
      zoneName: scoped.zone.zoneName,
      record: canonicalRecord,
    }, { dnsCredential: scoped.secret });
    if (!snapshot || snapshot.provider !== 'cloudflare' || !Array.isArray(snapshot.records)
      || snapshot.records.length > 1 || typeof snapshot.snapshotDigest !== 'string') {
      throw new MailDkimDnsError('mail_dkim_dns_snapshot_invalid', 'DNS provider snapshot is invalid', 503);
    }
    const existing = snapshot.records[0] ?? null;
    if (existing && !sameContent(existing, canonicalRecord)) {
      throw new MailDkimDnsError(
        'mail_dkim_dns_record_conflict',
        'The DKIM selector name already contains different TXT content at the DNS provider',
        409,
      );
    }
    const record = request.kind === 'retirement' && existing
      ? Object.freeze({ ...existing })
      : canonicalRecord;
    const action = request.kind === 'current' ? 'upsert' : 'delete';
    const effect = action === 'upsert'
      ? existing === null ? 'create'
        : existing.ttl === record.ttl && existing.proxied === record.proxied ? 'no_change' : 'update'
      : existing === null ? 'no_change' : 'delete';
    const identity = Object.freeze({
      version: 1,
      operation: 'mail_dkim_dns_apply',
      kind: request.kind,
      mailDomainId: scoped.mailDomain.id,
      expectedRevision: request.expectedRevision,
      selector: desired.selector,
      dnsZoneId: scoped.zone.id,
      zoneRevision: scoped.zone.revision,
      provider: scoped.credential.provider,
      credentialId: scoped.credential.id,
      credentialUpdatedAt: scoped.credential.updatedAt,
      action,
      record,
      providerSnapshotDigest: snapshot.snapshotDigest,
      effect,
    });
    const previewDigest = digest(identity);
    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation: `apply-mail-dkim-dns:${scoped.mailDomain.id}:${request.kind}:${previewDigest}`,
      sideEffects: false,
    });
  }

  async function preview(rawInput) {
    return buildPreview(input(rawInput));
  }

  async function apply(rawInput) {
    const request = input(rawInput, { apply: true });
    const preview = await buildPreview({
      mailDomainId: request.mailDomainId,
      kind: request.kind,
      expectedRevision: request.expectedRevision,
    });
    if (request.previewDigest !== preview.previewDigest || request.confirmation !== preview.confirmation) {
      throw new MailDkimDnsError('mail_dkim_dns_preview_stale', 'DKIM DNS state changed after preview', 409);
    }
    if (request.kind === 'retirement' && preview.effect === 'no_change') {
      const retirement = await mailDkimRetirementRegistry.getRetirement(request.mailDomainId);
      if (!retirement || retirement.revision !== request.expectedRevision) {
        throw new MailDkimDnsError('mail_dkim_dns_preview_stale', 'DKIM retirement state changed after preview', 409);
      }
      await mailDkimRetirementRegistry.clearRetirement(request.mailDomainId, {
        expectedRevision: retirement.revision,
        confirmation: `clear-dkim-retirement:${request.mailDomainId}:${retirement.previousSelector}:${retirement.revision}`,
      });
      return Object.freeze({
        previewDigest: preview.previewDigest,
        completed: true,
        job: null,
        retirementCleared: true,
        sideEffects: Object.freeze({ dnsChanged: false }),
      });
    }
    const job = await jobRegistry.enqueue({
      serverId: (await domainRegistry.getDomain((await mailDomainRegistry.getMailDomain(request.mailDomainId)).webDomainId)).serverId,
      type: OPERATIONS.DNS_RECORD_APPLY,
      operation: OPERATIONS.DNS_RECORD_APPLY,
      payload: {
        provider: preview.provider,
        credentialId: preview.credentialId,
        dnsZoneId: preview.dnsZoneId,
        zoneName: (await dnsHostingRegistry.listZones()).find((zone) => zone.id === preview.dnsZoneId)?.zoneName,
        action: preview.action,
        record: preview.record,
        expectedSnapshotDigest: preview.providerSnapshotDigest,
      },
      resourceType: 'dns_zone',
      resourceId: preview.dnsZoneId,
      idempotencyKey: `dkim-dns:${preview.dnsZoneId}:${preview.previewDigest}`,
    });
    return Object.freeze({
      previewDigest: preview.previewDigest,
      completed: false,
      job,
      retirementCleared: false,
      sideEffects: Object.freeze({ dnsChanged: false }),
    });
  }

  async function reconcileRetirement(mailDomainId) {
    const retirement = await mailDkimRetirementRegistry.getRetirement(mailDomainId);
    if (!retirement || retirement.phase !== 'dns_retirement_pending') {
      return Object.freeze({ pending: false, cleared: false });
    }
    const preview = await buildPreview({
      mailDomainId,
      kind: 'retirement',
      expectedRevision: retirement.revision,
    });
    if (preview.effect !== 'no_change') {
      return Object.freeze({ pending: true, cleared: false, preview });
    }
    await mailDkimRetirementRegistry.clearRetirement(mailDomainId, {
      expectedRevision: retirement.revision,
      confirmation: `clear-dkim-retirement:${mailDomainId}:${retirement.previousSelector}:${retirement.revision}`,
    });
    return Object.freeze({ pending: false, cleared: true });
  }

  return Object.freeze({ preview, apply, reconcileRetirement });
}

export const mailDkimDnsInternals = Object.freeze({
  kinds: Object.freeze([...KINDS]),
  defaultTtl: DEFAULT_TTL,
  providerRecord,
  sameContent,
  input,
});
