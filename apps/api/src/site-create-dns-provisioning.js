import path from 'node:path';
import { createDnsZoneTemplateRegistry, dnsZoneTemplateInternals } from './dns-zone-template-registry.js';
import { renderDnsZoneDesiredState } from './dns-zone-desired-state.js';
import { createServerDnsIdentityRegistry } from './server-dns-identity-registry.js';
import { SiteCreateError } from './site-create.js';
import { siteCreateProvisioningPlan as createBaseSiteCreateProvisioningPlan } from './site-create-mail-provisioning.js';
import { createWebsiteProvisioningPlan } from './website-provisioning-plan.js';

function stateRoot(env) {
  return path.dirname(env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json'));
}

function identityStorePath(env) {
  return env.YUNPANEL_SERVER_DNS_IDENTITY_STORE
    ?? path.join(stateRoot(env), 'server-dns-identity-registry.json');
}

function templateStorePath(env) {
  return env.YUNPANEL_DNS_ZONE_TEMPLATE_STORE
    ?? path.join(stateRoot(env), 'dns-zone-template-registry.json');
}

function serialFromNow(now = Date.now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SiteCreateError('site_create_dns_clock_invalid', 'DNS zone serial clock is invalid', 503);
  }
  const date = new Date(value);
  const serial = Number.parseInt([
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
    '01',
  ].join(''), 10);
  if (!Number.isSafeInteger(serial) || serial < 1 || serial > 4_294_967_295) {
    throw new SiteCreateError('site_create_dns_clock_invalid', 'DNS zone serial clock is invalid', 503);
  }
  return serial;
}

function syntheticDefaultTemplate(serverId, now = Date.now) {
  const timestamp = new Date(now()).toISOString();
  return Object.freeze({
    serverId,
    schemaVersion: 1,
    version: 1,
    records: Object.freeze(dnsZoneTemplateInternals.defaultRecords.map((entry) => Object.freeze({
      ...entry,
      values: Object.freeze([...entry.values]),
    }))),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function loadDnsIdentity(serverId, dependencies) {
  const injected = dependencies.serverDnsIdentityRegistry ?? null;
  if (injected) {
    if (typeof injected.getForServer !== 'function') {
      throw new SiteCreateError('site_create_dns_dependencies_invalid', 'Server DNS identity registry is unavailable', 503);
    }
    return injected.getForServer(serverId);
  }
  const serverRegistry = dependencies.registry;
  if (!serverRegistry || typeof serverRegistry.getServer !== 'function') {
    throw new SiteCreateError('site_create_dns_dependencies_invalid', 'Server registry is unavailable for DNS planning', 503);
  }
  const registry = createServerDnsIdentityRegistry({
    filePath: identityStorePath(dependencies.env ?? process.env),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await registry.init();
  return registry.getForServer(serverId);
}

async function loadDnsTemplate(serverId, dependencies) {
  const injected = dependencies.dnsZoneTemplateRegistry ?? null;
  if (injected) {
    if (typeof injected.getForServer !== 'function') {
      throw new SiteCreateError('site_create_dns_dependencies_invalid', 'DNS zone template registry is unavailable', 503);
    }
    return (await injected.getForServer(serverId)) ?? syntheticDefaultTemplate(serverId, dependencies.now ?? Date.now);
  }
  const serverRegistry = dependencies.registry;
  if (!serverRegistry || typeof serverRegistry.getServer !== 'function') {
    throw new SiteCreateError('site_create_dns_dependencies_invalid', 'Server registry is unavailable for DNS planning', 503);
  }
  const registry = createDnsZoneTemplateRegistry({
    filePath: templateStorePath(dependencies.env ?? process.env),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await registry.init();
  return (await registry.getForServer(serverId)) ?? syntheticDefaultTemplate(serverId, dependencies.now ?? Date.now);
}

function assertAuthoritativeNameservers(template) {
  const apexNs = template.records.filter((entry) => entry.owner === '@' && entry.type === 'NS');
  if (apexNs.length !== 1 || JSON.stringify(apexNs[0].values) !== JSON.stringify(['<ns1>', '<ns2>'])) {
    throw new SiteCreateError(
      'site_create_dns_template_nameservers_invalid',
      'DNS zone template must keep the authoritative apex NS RRset bound to <ns1> and <ns2>',
      409,
    );
  }
}

function runtimeAwareRecords(preview, desired, dnsIdentity) {
  const wwwMode = preview.hostname?.wwwMode ?? 'none';
  const zoneName = desired.zoneName;
  let records = desired.records.filter((entry) => !(entry.key === 'www-alias' && entry.source === 'template'));
  if (wwwMode === 'alias') {
    const builtIn = desired.records.find((entry) => entry.key === 'www-alias' && entry.source === 'template');
    if (builtIn) records.push(builtIn);
  } else if (wwwMode === 'independent') {
    const owner = `www.${zoneName}`;
    records.push(Object.freeze({
      key: 'www-runtime-ipv4',
      owner,
      type: 'A',
      ttl: dnsIdentity.settings.soa.ttl,
      values: Object.freeze([dnsIdentity.settings.publicIpv4]),
      source: 'runtime',
      templateVersion: null,
    }));
    if (dnsIdentity.settings.publicIpv6) {
      records.push(Object.freeze({
        key: 'www-runtime-ipv6',
        owner,
        type: 'AAAA',
        ttl: dnsIdentity.settings.soa.ttl,
        values: Object.freeze([dnsIdentity.settings.publicIpv6]),
        source: 'runtime',
        templateVersion: null,
      }));
    }
  }
  return Object.freeze(records);
}

async function dnsZoneStep(preview, dependencies) {
  const domain = preview.plan?.primaryDomain;
  if (!domain || domain.parentDomainId !== null) return null;
  const serverId = preview.plan?.website?.serverId ?? preview.plan?.primaryDomain?.serverId ?? dependencies.localServerId ?? null;
  const normalizedServerId = serverId ?? preview.input?.serverId ?? preview.serverId ?? null;
  if (typeof normalizedServerId !== 'string' || !normalizedServerId) {
    throw new SiteCreateError('site_create_dns_dependencies_invalid', 'DNS planning could not resolve the target server', 503);
  }
  const [dnsIdentity, template] = await Promise.all([
    loadDnsIdentity(normalizedServerId, dependencies),
    loadDnsTemplate(normalizedServerId, dependencies),
  ]);
  if (!dnsIdentity) {
    throw new SiteCreateError(
      'site_create_dns_identity_required',
      'Configure this server DNS identity and nameservers before creating a locally hosted root domain',
      409,
    );
  }
  assertAuthoritativeNameservers(template);
  const desired = renderDnsZoneDesiredState({
    zoneName: domain.primaryDomain,
    template,
    dnsIdentity,
    serial: serialFromNow(dependencies.now ?? Date.now),
  });
  const records = runtimeAwareRecords(preview, desired, dnsIdentity);
  return Object.freeze({
    id: 'dns_zone',
    kind: 'dns_zone',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: 'powerdns-zone',
      serverId: normalizedServerId,
      webDomainId: domain.id,
      zoneName: desired.zoneName,
      templateVersion: desired.templateVersion,
      templateSnapshot: desired.templateSnapshot,
      dnsIdentityRevision: desired.dnsIdentityRevision,
      secondaryDns: Object.freeze([...dnsIdentity.settings.secondaryDns]),
      serial: desired.serial,
      dnssec: dnsIdentity.settings.dnssecDefault === true,
      records,
    }),
    compensation: Object.freeze({ state: 'pending' }),
  });
}

function mailDnsReapplyStep(base, preview, dns) {
  const mailDomain = preview.plan?.mailDomain;
  if (!dns || !mailDomain || mailDomain.managementMode !== 'local') return null;
  const dkim = base.steps.find((step) => step.id === 'mail_dkim_key');
  if (!dkim || dkim.intent?.mailDomainId !== mailDomain.id) {
    throw new SiteCreateError(
      'site_create_mail_dkim_plan_invalid',
      'Local authoritative mail DNS requires the operation-owned DKIM key step',
      409,
    );
  }
  return Object.freeze({
    id: 'mail_dns_reapply',
    kind: 'mail_dns_reapply',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: 'powerdns-mail-reapply',
      serverId: dns.intent.serverId,
      websiteId: base.websiteId,
      webDomainId: dns.intent.webDomainId,
      zoneName: dns.intent.zoneName,
      mailDomainId: mailDomain.id,
      domainName: mailDomain.domainName,
      expectedMailDomainRevision: 2,
      expectedMailDomainStatus: 'enabled',
      expectedDkimKeyRevision: 1,
      selector: dkim.intent.selector,
    }),
    compensation: Object.freeze({ state: 'pending' }),
  });
}

function webmailDnsReapplyStep(base, mailDns) {
  if (!mailDns) return null;
  const roundcube = base.steps.find((step) => step.id === 'roundcube_mapping');
  if (!roundcube || roundcube.kind !== 'roundcube_mapping'
    || roundcube.intent?.mailDomainId !== mailDns.intent.mailDomainId
    || roundcube.intent?.webDomainId !== mailDns.intent.webDomainId) {
    throw new SiteCreateError(
      'site_create_roundcube_plan_invalid',
      'Local authoritative webmail DNS requires the shared Roundcube mapping step',
      409,
    );
  }
  return Object.freeze({
    id: 'webmail_dns_reapply',
    kind: 'webmail_dns_reapply',
    required: true,
    state: 'pending',
    intent: Object.freeze({ ...mailDns.intent }),
    compensation: Object.freeze({ state: 'pending' }),
  });
}

export async function siteCreateProvisioningPlan(preview, dependencies = {}) {
  const base = createBaseSiteCreateProvisioningPlan(preview);
  if (base.steps.some((step) => step.id === 'dns_zone')) return base;
  const dns = await dnsZoneStep(preview, dependencies);
  if (!dns) return base;
  const mailDns = mailDnsReapplyStep(base, preview, dns);
  const webmailDns = webmailDnsReapplyStep(base, mailDns);
  const steps = base.steps.map((step) => ({
    ...step,
    intent: { ...step.intent },
    compensation: { ...step.compensation },
  }));
  const nginxIndex = steps.findIndex((step) => step.id === 'nginx');
  const insertAt = nginxIndex >= 0 ? nginxIndex : steps.length;
  steps.splice(insertAt, 0, dns);
  if (mailDns) {
    if (steps.some((step) => ['mail_dns_reapply', 'webmail_dns_reapply'].includes(step.id)
      || ['mail_dns_reapply', 'webmail_dns_reapply'].includes(step.kind))) {
      throw new SiteCreateError(
        'site_create_mail_dns_plan_conflict',
        'Website provisioning already contains a local mail DNS reapply step',
        409,
      );
    }
    const dkimIndex = steps.findIndex((step) => step.id === 'mail_dkim_key');
    steps.splice(dkimIndex >= 0 ? dkimIndex + 1 : steps.length, 0, mailDns);
    if (webmailDns) {
      const roundcubeIndex = steps.findIndex((step) => step.id === 'roundcube_mapping');
      steps.splice(roundcubeIndex >= 0 ? roundcubeIndex + 1 : steps.length, 0, webmailDns);
    }
  }
  return createWebsiteProvisioningPlan({
    operationId: base.operationId,
    websiteId: base.websiteId,
    resources: base.resources,
    steps,
  });
}

export const siteCreateDnsProvisioningInternals = Object.freeze({
  stateRoot,
  identityStorePath,
  templateStorePath,
  serialFromNow,
  syntheticDefaultTemplate,
  loadDnsIdentity,
  loadDnsTemplate,
  assertAuthoritativeNameservers,
  runtimeAwareRecords,
  dnsZoneStep,
  mailDnsReapplyStep,
  webmailDnsReapplyStep,
});
