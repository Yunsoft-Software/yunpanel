export class DnsZoneMailIntentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneMailIntentError';
    this.code = code;
    this.status = status;
  }
}

const DISCOVERY_ENDPOINTS = Object.freeze({
  autodiscover: Object.freeze({ prefix: 'autodiscover', path: '/autodiscover/autodiscover.xml' }),
  autoconfig: Object.freeze({ prefix: 'autoconfig', path: '/mail/config-v1.1.xml' }),
});

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

function retirementDkim(retirement, mailDomainId, domainName, { exclude = false } = {}) {
  if (retirement === null) return null;
  if (!retirement || typeof retirement !== 'object' || Array.isArray(retirement)
    || retirement.mailDomainId !== mailDomainId || retirement.domainName !== domainName
    || !['dns_retirement_pending', 'dns_retirement_applying'].includes(retirement.phase)
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
  if (exclude || retirement.phase === 'dns_retirement_applying') return null;
  return Object.freeze({
    selector: retirement.previousSelector,
    value: retirement.previousDnsRecord.value,
    revision: retirement.revision,
  });
}

function retirementPreview(value, retirement, mailDomainId) {
  if (value === null) return null;
  const fields = new Set(['mailDomainId', 'expectedRevision', 'selector']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.mailDomainId !== mailDomainId
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
    || typeof value.selector !== 'string' || !value.selector) {
    throw new DnsZoneMailIntentError(
      'dns_zone_mail_retirement_preview_invalid',
      'DKIM retirement preview identity is invalid',
      409,
    );
  }
  if (!retirement || retirement.phase !== 'dns_retirement_pending'
    || retirement.mailDomainId !== value.mailDomainId
    || retirement.revision !== value.expectedRevision
    || retirement.previousSelector !== value.selector) {
    throw new DnsZoneMailIntentError(
      'dns_zone_mail_retirement_preview_stale',
      'DKIM retirement state changed before DNS preview',
      409,
    );
  }
  return Object.freeze({ phase: 'dns_retirement_applying', revision: retirement.revision + 1 });
}

function discoveryEndpoint(value, kind, domainName) {
  if (value === null) return null;
  const fields = new Set(['ready', 'hostname', 'protocol', 'path']);
  const policy = DISCOVERY_ENDPOINTS[kind];
  if (!policy || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.ready !== true
    || ![domainName, `${policy.prefix}.${domainName}`].includes(value.hostname)
    || value.protocol !== 'https' || value.path !== policy.path) {
    throw new DnsZoneMailIntentError(
      'dns_zone_mail_discovery_invalid',
      `${kind} endpoint readiness evidence is invalid`,
      409,
    );
  }
  return Object.freeze({
    hostname: value.hostname,
    protocol: value.protocol,
    path: value.path,
  });
}

function discoveryIntent(value, mailDomain, domain) {
  if (value === null) return Object.freeze({ intent: null, revision: null });
  const fields = new Set(['version', 'mailDomainId', 'serverId', 'revision', 'autodiscover', 'autoconfig']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.version !== 1 || value.mailDomainId !== mailDomain.id || value.serverId !== domain.serverId
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new DnsZoneMailIntentError(
      'dns_zone_mail_discovery_invalid',
      'Mail discovery endpoint readiness evidence is invalid',
      409,
    );
  }
  return Object.freeze({
    intent: Object.freeze({
      revision: value.revision,
      autodiscover: discoveryEndpoint(value.autodiscover, 'autodiscover', domain.primaryDomain),
      autoconfig: discoveryEndpoint(value.autoconfig, 'autoconfig', domain.primaryDomain),
    }),
    revision: value.revision,
  });
}

function webmailEndpoint(value, mailDomain, domain) {
  if (value === null) {
    return Object.freeze({
      intent: null,
      mappingRevision: null,
      roundcubePreviewSha256: null,
    });
  }
  const fields = new Set([
    'version', 'mailDomainId', 'serverId', 'mappingId', 'mappingRevision',
    'hostname', 'protocol', 'path', 'roundcubePreviewSha256', 'roundcubeApplyJobId', 'ready',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || value.version !== 1 || value.mailDomainId !== mailDomain.id
    || value.serverId !== domain.serverId || value.ready !== true
    || !Number.isSafeInteger(value.mappingRevision) || value.mappingRevision < 1
    || value.hostname !== `webmail.${domain.primaryDomain}`
    || value.protocol !== 'https' || value.path !== '/'
    || typeof value.roundcubePreviewSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.roundcubePreviewSha256)
    || typeof value.mappingId !== 'string' || !value.mappingId
    || typeof value.roundcubeApplyJobId !== 'string' || !value.roundcubeApplyJobId) {
    throw new DnsZoneMailIntentError(
      'dns_zone_mail_webmail_invalid',
      'Roundcube webmail endpoint readiness evidence is invalid',
      409,
    );
  }
  return Object.freeze({
    intent: Object.freeze({
      hostname: value.hostname,
      protocol: 'https',
      path: '/',
    }),
    mappingRevision: value.mappingRevision,
    roundcubePreviewSha256: value.roundcubePreviewSha256,
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
    mailDiscoveryEndpointRevision: null,
    roundcubeWebmailMappingRevision: null,
    roundcubeWebmailPreviewSha256: null,
    dkimRevisions: Object.freeze([]),
    retirementPhase: null,
    retirementRevision: null,
  });
}

export function createDnsZoneMailIntentResolver({
  mailDomainRegistry,
  mailDkimRegistry,
  mailDkimRetirementRegistry,
  mailServiceIdentityRegistry,
  mailDiscoveryEndpointResolver = null,
  roundcubeWebmailEndpointResolver = null,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.listMailDomains !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || !mailDkimRetirementRegistry || typeof mailDkimRetirementRegistry.getRetirement !== 'function'
    || !mailServiceIdentityRegistry || typeof mailServiceIdentityRegistry.getForServer !== 'function'
    || (mailDiscoveryEndpointResolver !== null
      && typeof mailDiscoveryEndpointResolver?.resolve !== 'function')
    || (roundcubeWebmailEndpointResolver !== null
      && typeof roundcubeWebmailEndpointResolver?.resolve !== 'function')) {
    throw new DnsZoneMailIntentError(
      'dns_zone_mail_dependencies_invalid',
      'DNS zone mail intent dependencies are unavailable',
      503,
    );
  }

  async function resolve({ domain, retirePendingDkim = null } = {}) {
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

    const [identity, currentKey, retirement, discoveryState, webmailState] = await Promise.all([
      mailServiceIdentityRegistry.getForServer(scoped.serverId),
      mailDkimRegistry.getKey(mailDomain.id),
      mailDkimRetirementRegistry.getRetirement(mailDomain.id),
      mailDiscoveryEndpointResolver
        ? mailDiscoveryEndpointResolver.resolve({ mailDomain, domain: scoped })
        : null,
      roundcubeWebmailEndpointResolver
        ? roundcubeWebmailEndpointResolver.resolve({ mailDomain, domain: scoped })
        : null,
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

    const retirementTarget = retirementPreview(retirePendingDkim, retirement, mailDomain.id);
    const discovery = discoveryIntent(discoveryState, mailDomain, scoped);
    const webmail = webmailEndpoint(webmailState, mailDomain, scoped);
    const dkim = [];
    if (currentKey) dkim.push(canonicalDkim(currentKey, mailDomain.id, scoped.primaryDomain, 'Current'));
    const previous = retirementDkim(retirement, mailDomain.id, scoped.primaryDomain, {
      exclude: retirementTarget !== null,
    });
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
      mailDiscoveryEndpointRevision: discovery.revision,
      roundcubeWebmailMappingRevision: webmail.mappingRevision,
      roundcubeWebmailPreviewSha256: webmail.roundcubePreviewSha256,
      dkimRevisions: Object.freeze(dkim.map((entry) => entry.revision).sort((left, right) => left - right)),
      retirementPhase: retirementTarget?.phase ?? retirement?.phase ?? null,
      retirementRevision: retirementTarget?.revision ?? retirement?.revision ?? null,
    });
    return Object.freeze({
      intent: Object.freeze({
        enabled: true,
        host: identity.hostname,
        imap: true,
        submission: true,
        webmailEnabled: true,
        webmailReady: webmail.intent !== null,
        webmailHost: `webmail.${scoped.primaryDomain}`,
        discovery: discovery.intent,
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
  retirementPreview,
  discoveryEndpoint,
  discoveryIntent,
  webmailEndpoint,
  disabledEvidence,
});
