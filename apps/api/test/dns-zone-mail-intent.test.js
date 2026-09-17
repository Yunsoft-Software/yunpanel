import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnsZoneMailIntentResolver,
  DnsZoneMailIntentError,
} from '../src/dns-zone-mail-intent.js';

const domain = Object.freeze({
  id: '8bc307db-9e2d-4c3f-91ea-49e740d259a9',
  serverId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
  primaryDomain: 'example.com',
});
const mailDomain = Object.freeze({
  id: 'f77d9d70-3f77-4be9-b257-0ade06401fb7',
  webDomainId: domain.id,
  domainName: domain.primaryDomain,
  managementMode: 'local',
  status: 'enabled',
  revision: 4,
});

function key(selector = 'current', revision = 3) {
  return Object.freeze({
    mailDomainId: mailDomain.id,
    domainName: mailDomain.domainName,
    selector,
    revision,
    dnsRecord: Object.freeze({
      type: 'TXT',
      name: `${selector}._domainkey.${mailDomain.domainName}`,
      value: `v=DKIM1; k=rsa; p=${selector}`,
    }),
  });
}

function fixture({
  domains = [mailDomain],
  identity = null,
  currentKey = key(),
  retirement = null,
  mailDiscoveryEndpointResolver = null,
} = {}) {
  const resolver = createDnsZoneMailIntentResolver({
    mailDomainRegistry: { listMailDomains: async () => domains },
    mailDkimRegistry: { getKey: async () => currentKey },
    mailDkimRetirementRegistry: { getRetirement: async () => retirement },
    mailServiceIdentityRegistry: {
      getForServer: async () => identity ?? {
        serverId: domain.serverId,
        hostname: 'mail.example.com',
        revision: 2,
        ready: true,
      },
    },
    mailDiscoveryEndpointResolver,
  });
  return resolver.resolve({ domain });
}

test('enabled local mail resolves service endpoints and current plus retiring public DKIM intent', async () => {
  const resolved = await fixture({
    retirement: {
      mailDomainId: mailDomain.id,
      domainName: mailDomain.domainName,
      previousSelector: 'previous',
      previousDnsRecord: {
        type: 'TXT',
        name: `previous._domainkey.${mailDomain.domainName}`,
        value: 'v=DKIM1; k=rsa; p=previous',
      },
      phase: 'dns_retirement_pending',
      revision: 2,
    },
  });

  assert.deepEqual(resolved.intent, {
    enabled: true,
    host: 'mail.example.com',
    imap: true,
    submission: true,
    webmailEnabled: false,
    discovery: null,
    dkimRecords: [
      { selector: 'current', value: 'v=DKIM1; k=rsa; p=current' },
      { selector: 'previous', value: 'v=DKIM1; k=rsa; p=previous' },
    ],
  });
  assert.deepEqual(resolved.evidence, {
    version: 1,
    managed: true,
    enabled: true,
    mailDomainId: mailDomain.id,
    mailDomainRevision: 4,
    mailServiceIdentityRevision: 2,
    mailDiscoveryEndpointRevision: null,
    dkimRevisions: [2, 3],
    retirementPhase: 'dns_retirement_pending',
    retirementRevision: 2,
  });
  assert.equal(JSON.stringify(resolved).includes('private'), false);
});

test('mail discovery DNS intent requires exact endpoint readiness evidence', async () => {
  const resolved = await fixture({
    mailDiscoveryEndpointResolver: {
      resolve: async ({ mailDomain: requestedMailDomain, domain: requestedDomain }) => {
        assert.equal(requestedMailDomain.id, mailDomain.id);
        assert.equal(requestedDomain.id, domain.id);
        return {
          version: 1,
          mailDomainId: mailDomain.id,
          serverId: domain.serverId,
          revision: 6,
          autodiscover: {
            ready: true,
            hostname: 'autodiscover.example.com',
            protocol: 'https',
            path: '/autodiscover/autodiscover.xml',
          },
          autoconfig: null,
        };
      },
    },
  });

  assert.deepEqual(resolved.intent.discovery, {
    revision: 6,
    autodiscover: {
      hostname: 'autodiscover.example.com',
      protocol: 'https',
      path: '/autodiscover/autodiscover.xml',
    },
    autoconfig: null,
  });
  assert.equal(resolved.evidence.mailDiscoveryEndpointRevision, 6);

  await assert.rejects(
    fixture({
      mailDiscoveryEndpointResolver: {
        resolve: async () => ({
          version: 1,
          mailDomainId: mailDomain.id,
          serverId: domain.serverId,
          revision: 7,
          autodiscover: null,
          autoconfig: {
            ready: true,
            hostname: 'autoconfig.example.com',
            protocol: 'http',
            path: '/mail/config-v1.1.xml',
          },
        }),
      },
    }),
    (error) => error instanceof DnsZoneMailIntentError
      && error.code === 'dns_zone_mail_discovery_invalid',
  );
});

test('disabled or absent local mail produces an explicit empty managed source without endpoint lookups', async () => {
  let endpointLookups = 0;
  const disabled = { ...mailDomain, status: 'disabled', revision: 5 };
  const resolver = createDnsZoneMailIntentResolver({
    mailDomainRegistry: { listMailDomains: async () => [disabled] },
    mailDkimRegistry: { getKey: async () => { endpointLookups += 1; return null; } },
    mailDkimRetirementRegistry: { getRetirement: async () => { endpointLookups += 1; return null; } },
    mailServiceIdentityRegistry: { getForServer: async () => { endpointLookups += 1; return null; } },
  });

  const resolved = await resolver.resolve({ domain });
  assert.equal(resolved.intent, null);
  assert.equal(resolved.evidence.enabled, false);
  assert.equal(resolved.evidence.mailDomainRevision, 5);
  assert.equal(endpointLookups, 0);
  assert.equal((await fixture({ domains: [] })).intent, null);
});

test('enabled local mail fails closed when the service identity or DKIM ownership is inconsistent', async () => {
  await assert.rejects(
    fixture({ identity: { serverId: domain.serverId, hostname: 'mail.example.com', revision: 2, ready: false } }),
    (error) => error instanceof DnsZoneMailIntentError && error.code === 'dns_zone_mail_service_not_ready',
  );
  await assert.rejects(
    fixture({ currentKey: { ...key(), domainName: 'other.example' } }),
    (error) => error instanceof DnsZoneMailIntentError && error.code === 'dns_zone_mail_dkim_invalid',
  );
});

test('pending retirement preview and persisted applying state exclude only the previous selector', async () => {
  const retirement = {
    mailDomainId: mailDomain.id,
    domainName: mailDomain.domainName,
    previousSelector: 'previous',
    previousDnsRecord: {
      type: 'TXT',
      name: `previous._domainkey.${mailDomain.domainName}`,
      value: 'v=DKIM1; k=rsa; p=previous',
    },
    phase: 'dns_retirement_pending',
    revision: 2,
  };
  const resolver = createDnsZoneMailIntentResolver({
    mailDomainRegistry: { listMailDomains: async () => [mailDomain] },
    mailDkimRegistry: { getKey: async () => key() },
    mailDkimRetirementRegistry: { getRetirement: async () => retirement },
    mailServiceIdentityRegistry: {
      getForServer: async () => ({
        serverId: domain.serverId, hostname: 'mail.example.com', revision: 2, ready: true,
      }),
    },
  });
  const preview = await resolver.resolve({
    domain,
    retirePendingDkim: {
      mailDomainId: mailDomain.id,
      expectedRevision: retirement.revision,
      selector: retirement.previousSelector,
    },
  });
  assert.deepEqual(preview.intent.dkimRecords, [
    { selector: 'current', value: 'v=DKIM1; k=rsa; p=current' },
  ]);
  assert.equal(preview.evidence.retirementPhase, 'dns_retirement_applying');
  assert.equal(preview.evidence.retirementRevision, 3);

  retirement.phase = 'dns_retirement_applying';
  retirement.revision = 3;
  const applying = await resolver.resolve({ domain });
  assert.deepEqual(applying.intent.dkimRecords, preview.intent.dkimRecords);
  assert.deepEqual(applying.evidence, preview.evidence);
});
