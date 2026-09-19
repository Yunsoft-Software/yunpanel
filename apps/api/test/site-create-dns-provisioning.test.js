import assert from 'node:assert/strict';
import test from 'node:test';
import { siteCreateProvisioningPlan } from '../src/site-create-dns-provisioning.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const domainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const wwwDomainId = 'c47d5168-708f-4a8a-83d9-d3a7f3a1b43c';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const unixUser = 'yunapp-4dc352e64a14';

function preview({ wwwMode = 'none', parentDomainId = null, mailMode = 'none' } = {}) {
  const independent = wwwMode === 'independent';
  const mailDomain = mailMode === 'none' ? null : {
    id: mailDomainId,
    domainName: 'example.com',
    webDomainId: domainId,
    managementMode: mailMode,
    initialStatus: mailMode === 'local' ? 'disabled' : 'unverified',
    desiredStatus: mailMode === 'local' ? 'enabled' : null,
  };
  return {
    operationId,
    complete: false,
    source: {
      kind: 'new_static',
      repositoryUrl: 'https://github.com/example/static-app.git',
      branch: 'main',
      build: { mode: 'none', installMode: null, buildScript: null, outputDir: '.', healthFile: 'index.html' },
      retention: 5,
    },
    ids: { websiteId, applicationId, primaryDomainId: domainId, wwwDomainId: independent ? wwwDomainId : null, mailDomainId: mailDomain?.id ?? null },
    hostname: {
      primaryDomain: 'example.com',
      parentDomainId,
      wwwMode,
      aliases: wwwMode === 'alias' ? ['www.example.com'] : [],
      independentWwwDomain: independent ? 'www.example.com' : null,
    },
    steps: {
      applicationReady: false,
      websiteReady: false,
      primaryDomainReady: false,
      wwwDomainReady: independent ? false : null,
      mailDomainReady: mailDomain ? false : null,
    },
    plan: {
      application: {
        id: applicationId,
        serverId,
        type: 'static',
        repositoryUrl: 'https://github.com/example/static-app.git',
        branch: 'main',
        retention: 5,
        build: { mode: 'none', installMode: null, buildScript: null, outputDir: '.', healthFile: 'index.html' },
        runtime: null,
        webRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
      },
      dockerWorkload: null,
      website: {
        id: websiteId,
        serverId,
        applicationId,
        runtimeType: 'static',
        unixUser,
        documentRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
      },
      primaryDomain: {
        id: domainId,
        serverId,
        websiteId,
        primaryDomain: 'example.com',
        parentDomainId,
        aliases: wwwMode === 'alias' ? ['www.example.com'] : [],
        targetType: 'static',
        target: { root: `/var/www/yunpanel/apps/${applicationId}/current`, spaFallback: true },
        httpsMode: mailMode === 'local' ? 'managed' : 'off',
      },
      wwwDomain: independent ? {
        id: wwwDomainId,
        serverId,
        websiteId,
        primaryDomain: 'www.example.com',
        parentDomainId: domainId,
        aliases: [],
        targetType: 'static',
        target: { root: `/var/www/yunpanel/apps/${applicationId}/current`, spaFallback: true },
        httpsMode: 'off',
      } : null,
      mailDomain,
      webmail: mailMode === 'local'
        ? { hostname: 'webmail.example.com', sharedRoundcube: true, certificateCoverageRequired: true }
        : null,
    },
  };
}

function identity() {
  return {
    serverId,
    revision: 4,
    settings: {
      publicIpv4: '203.0.113.10',
      publicIpv6: '2001:db8::10',
      ns1: { hostname: 'ns1.host.example', ipv4: '203.0.113.10', ipv6: '2001:db8::10', local: true },
      ns2: { hostname: 'ns2.host.example', ipv4: '203.0.113.11', ipv6: null, local: false },
      soa: {
        primaryNs: 'ns1.host.example', rname: 'hostmaster.host.example',
        refresh: 3600, retry: 900, expire: 1209600, minimum: 300, ttl: 300,
      },
      dnssecDefault: false,
      secondaryDns: [],
    },
  };
}

function template() {
  return {
    serverId,
    schemaVersion: 1,
    version: 5,
    records: [
      { key: 'apex-nameservers', owner: '@', type: 'NS', ttl: null, values: ['<ns1>', '<ns2>'], condition: 'always' },
      { key: 'apex-ipv4', owner: '@', type: 'A', ttl: null, values: ['<server-ipv4>'], condition: 'always' },
      { key: 'apex-ipv6', owner: '@', type: 'AAAA', ttl: null, values: ['<server-ipv6>'], condition: 'ipv6' },
      { key: 'www-alias', owner: 'www', type: 'CNAME', ttl: null, values: ['<domain>'], condition: 'always' },
    ],
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  };
}

function dependencies({ identityValue = identity(), templateValue = template() } = {}) {
  return {
    now: () => Date.parse('2026-09-15T12:00:00.000Z'),
    serverDnsIdentityRegistry: { getForServer: async () => identityValue },
    dnsZoneTemplateRegistry: { getForServer: async () => templateValue },
  };
}

test('root Website provisioning snapshots DNS template and identity before Nginx', async () => {
  const plan = await siteCreateProvisioningPlan(preview({ wwwMode: 'alias' }), dependencies());
  const dns = plan.steps.find((step) => step.id === 'dns_zone');
  assert.ok(dns);
  assert.equal(dns.kind, 'dns_zone');
  assert.equal(dns.intent.templateVersion, 5);
  assert.equal(dns.intent.dnsIdentityRevision, 4);
  assert.equal(dns.intent.serial, 2026091501);
  assert.equal(dns.intent.zoneName, 'example.com');
  assert.equal(dns.intent.webDomainId, domainId);
  assert.equal(dns.intent.records.some((record) => record.key === 'www-alias'), true);
  assert.ok(plan.steps.findIndex((step) => step.id === 'dns_zone') < plan.steps.findIndex((step) => step.id === 'nginx'));
});

test('local mail adds operation-owned DNS reapply after the DKIM key step', async () => {
  const plan = await siteCreateProvisioningPlan(preview({ mailMode: 'local' }), dependencies());
  const dkim = plan.steps.find((step) => step.id === 'mail_dkim_key');
  const mailDns = plan.steps.find((step) => step.id === 'mail_dns_reapply');
  const roundcube = plan.steps.find((step) => step.id === 'roundcube_mapping');
  const webmailDns = plan.steps.find((step) => step.id === 'webmail_dns_reapply');

  assert.ok(dkim);
  assert.ok(mailDns);
  assert.ok(roundcube);
  assert.ok(webmailDns);
  assert.equal(mailDns.kind, 'mail_dns_reapply');
  assert.equal(mailDns.required, true);
  assert.equal(mailDns.state, 'pending');
  assert.equal(mailDns.compensation.state, 'pending');
  assert.deepEqual(mailDns.intent, {
    adapter: 'powerdns-mail-reapply',
    serverId,
    websiteId,
    webDomainId: domainId,
    zoneName: 'example.com',
    mailDomainId,
    domainName: 'example.com',
    expectedMailDomainRevision: 2,
    expectedMailDomainStatus: 'enabled',
    expectedDkimKeyRevision: 1,
    selector: 'yp-9ae512c0a7174611943c6ce2',
  });
  assert.ok(plan.steps.findIndex((step) => step.id === 'mail_dkim_key')
    < plan.steps.findIndex((step) => step.id === 'mail_dns_reapply'));
  assert.deepEqual(webmailDns.intent, mailDns.intent);
  assert.equal(webmailDns.kind, 'webmail_dns_reapply');
  assert.equal(webmailDns.required, true);
  assert.equal(webmailDns.state, 'pending');
  assert.equal(webmailDns.compensation.state, 'pending');
  assert.ok(plan.steps.findIndex((step) => step.id === 'mail_dns_reapply')
    < plan.steps.findIndex((step) => step.id === 'mail_dkim_config'));
  assert.ok(plan.steps.findIndex((step) => step.id === 'mail_dkim_config')
    < plan.steps.findIndex((step) => step.id === 'roundcube_mapping'));
  assert.ok(plan.steps.findIndex((step) => step.id === 'roundcube_mapping')
    < plan.steps.findIndex((step) => step.id === 'webmail_dns_reapply'));
  assert.equal(plan.ready, false);
});

test('external mail does not create a local authoritative mail DNS mutation', async () => {
  const plan = await siteCreateProvisioningPlan(preview({ mailMode: 'external' }), dependencies());
  assert.equal(plan.steps.some((step) => step.id === 'mail_dns_reapply'), false);
  assert.equal(plan.steps.some((step) => step.id === 'webmail_dns_reapply'), false);
});

test('www none removes the built-in DNS alias so no dead endpoint is published', async () => {
  const plan = await siteCreateProvisioningPlan(preview({ wwwMode: 'none' }), dependencies());
  const dns = plan.steps.find((step) => step.id === 'dns_zone');
  assert.equal(dns.intent.records.some((record) => record.key === 'www-alias'), false);
  assert.equal(dns.intent.records.some((record) => record.owner === 'www.example.com'), false);
});

test('independent www cannot share the parent Website DNS provisioning operation', async () => {
  await assert.rejects(
    siteCreateProvisioningPlan(preview({ wwwMode: 'independent' }), dependencies()),
    /Independent www provisioning requires a dedicated Website operation/,
  );
});

test('subdomain Website does not create a delegated authoritative zone implicitly', async () => {
  const plan = await siteCreateProvisioningPlan(preview({ parentDomainId: '980dd209-c2fc-4621-bb2f-889e05400ab4' }), dependencies());
  assert.equal(plan.steps.some((step) => step.id === 'dns_zone'), false);
});

test('root Website planning requires configured server DNS identity', async () => {
  await assert.rejects(
    siteCreateProvisioningPlan(preview(), dependencies({ identityValue: null })),
    (error) => error.code === 'site_create_dns_identity_required' && error.status === 409,
  );
});
