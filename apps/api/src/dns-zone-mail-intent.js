export class DnsZoneMailIntentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneMailIntentError';
    this.code = code;
    this.status = status;
  }
}

function domainScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !value.id
    || typeof value.serverId !== 'string' || !value.serverId
    || typeof value.primaryDomain !== 'string' || !value.primaryDomain) {
    throw new DnsZoneMailIntentError('dns_zone_mail_domain_invalid', 'DNS zone mail Domain state is invalid', 409);
  }
  return value;
}

function canonicalDkim(record, mailDomainId, domainName, field) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.mailDomainId !== mailDomainId || record.domainName !== domainName
    || typeof record.selector !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(record.selector)
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || record.dnsRecord?.type !== 'TXT'
    || record.dnsRecord.name !== `${record.selector}._domainkey.${domainName}`
    || typeof record.dnsRecord.value !== 'string' || !record.dnsRecord.value.trim()) {
    throw new DnsZoneMailIntentError(
      'dns_zone_mail_dkim_invalid',
      `${field} DKIM public DNS state is invalid`,
      409,
    );
  }
  return Object.freeze({
    selector: record.selector,
    value: record.dnsRecord.value,
    revision: record.revision,
  });
}

function retirementDkim(retirement, mailDomainId, domainName) {
  if (retirement === null) return null;
  if (!retirement || typeof retirement !== 'object' || Array.isArray(retirement)
    || retirement.mailDomainId !== mailDomainId || retirement.domainName !== domainName
    || retirement.phase !== 'dns_retirement_pending'
    || typeof retirement.previousSelector !== 'string'
    || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(retirement.previousSelector)
    || !Number.isSafeInteger(retirement.revision) || retirement.revision < 1
    || retirement.previousDnsRecord?.type !== 'TXT'
    || retirement.previousDnsRecord.name !== `${retirement.previousSelector}._domainkey.${domainName}`
    || typeof retirement.previousDnsRecord.value !== 'string' || !retirement.previousDnsRecord.value.trim()) {
    throw new DnsZoneMailIntentError(
      'dns_zone_mail_dkim_retirement_invalid',
      'Pending DKIM retirement DNS state is invalid',
      409,
    );
  }
  return Object.freeze({
    selector: retirement.previousSelector,
    value: retirement.previousDnsRecord.value,
    revision: retirement.revision,
  });
}

function disabledEvidence(mailDomain = null) {
  return Object.freeze({
    version: 1,
    managed: true,
    enabled: false,
    mailDomainId: mailDomain?.id ?? null,
    mailDomainRevision: mailDomain?.revision ?? null,
    mailServiceIdentityRevision: null,
    dkimRevisions: Object.freeze([]),
    retirementRevision: null,
  });
}

export function createDnsZoneMailIntentResolver({
  mailDomainRegistry,
  mailDkimRegistry,
  mailDkimRetirementRegistry,
  mailServiceIdentityRegistry,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.listMailDomains !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || !mailDkimRetirementRegistry || typeof mailDkimRetirementRegistry.getRetirement !== 'function'
    || !mailServiceIdentityRegistry || typeof mailServiceIdentityRegistry.getForServer !== 'function') {
    throw new DnsZoneMailIntentError(
      'dns_zone_mail_dependencies_invalid',
      'DNS zone mail intent dependencies are unavailable',
      503,
    );
  }

  async function resolve({ domain } = {}) {
    const scoped = domainScope(domain);
    const matches = (await mailDomainRegistry.listMailDomains())
      .filter((entry) => entry?.webDomainId === scoped.id && entry?.domainName === scoped.primaryDomain);
    if (matches.length > 1) {
      throw new DnsZoneMailIntentError(
        'dns_zone_mail_domain_ambiguous',
        'DNS zone has ambiguous mail-domain ownership',
        409,
      );
    }
    const mailDomain = matches[0] ?? null;
    if (!mailDomain || mailDomain.managementMode !== 'local' || mailDomain.status === 'disabled') {
      return Object.freeze({ intent: null, evidence: disabledEvidence(mailDomain) });
    }
    if (mailDomain.status !== 'enabled' || !Number.isSafeInteger(mailDomain.revision) || mailDomain.revision < 1) {
      throw new DnsZoneMailIntentError('dns_zone_mail_domain_invalid', 'Local mail-domain state is invalid', 409);
    }

    const [identity, currentKey, retirement] = await Promise.all([
      mailServiceIdentityRegistry.getForServer(scoped.serverId),
      mailDkimRegistry.getKey(mailDomain.id),
      mailDkimRetirementRegistry.getRetirement(mailDomain.id),
    ]);
    if (!identity || identity.serverId !== scoped.serverId || identity.ready !== true
      || typeof identity.hostname !== 'string' || !identity.hostname
      || !Number.isSafeInteger(identity.revision) || identity.revision < 1) {
      throw new DnsZoneMailIntentError(
        'dns_zone_mail_service_not_ready',
        'Enabled local mail DNS requires a ready mail service identity',
        409,
      );
    }

    const dkim = [];
    if (currentKey) dkim.push(canonicalDkim(currentKey, mailDomain.id, scoped.primaryDomain, 'Current'));
    const previous = retirementDkim(retirement, mailDomain.id, scoped.primaryDomain);
    if (previous) dkim.push(previous);
    const bySelector = new Map();
    for (const entry of dkim) {
      const existing = bySelector.get(entry.selector);
      if (existing && existing.value !== entry.value) {
        throw new DnsZoneMailIntentError(
          'dns_zone_mail_dkim_conflict',
          'Current and retiring DKIM selectors conflict',
          409,
        );
      }
      bySelector.set(entry.selector, entry);
    }
    const dkimRecords = Object.freeze([...bySelector.values()]
      .sort((left, right) => left.selector.localeCompare(right.selector))
      .map((entry) => Object.freeze({ selector: entry.selector, value: entry.value })));
    const evidence = Object.freeze({
      version: 1,
      managed: true,
      enabled: true,
      mailDomainId: mailDomain.id,
      mailDomainRevision: mailDomain.revision,
      mailServiceIdentityRevision: identity.revision,
      dkimRevisions: Object.freeze(dkim.map((entry) => entry.revision).sort((left, right) => left - right)),
      retirementRevision: retirement?.revision ?? null,
    });
    return Object.freeze({
      intent: Object.freeze({
        enabled: true,
        host: identity.hostname,
        imap: true,
        submission: true,
        webmailEnabled: false,
        dkimRecords,
      }),
      evidence,
    });
  }

  return Object.freeze({ resolve });
}

export const dnsZoneMailIntentInternals = Object.freeze({
  domainScope,
  canonicalDkim,
  retirementDkim,
  disabledEvidence,
});
