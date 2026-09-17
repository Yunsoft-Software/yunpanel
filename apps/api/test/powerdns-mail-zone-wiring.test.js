import assert from 'node:assert/strict';
import test from 'node:test';
import { PowerDnsHttpError, powerDnsHttpInternals } from '../src/powerdns-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const mailDomainId = 'f77d9d70-3f77-4be9-b257-0ade06401fb7';

const identity = Object.freeze({
  serverId,
  revision: 1,
  settings: Object.freeze({
    publicIpv4: '203.0.113.10',
    publicIpv6: null,
    ns1: Object.freeze({ hostname: 'ns1.host.example' }),
    ns2: Object.freeze({ hostname: 'ns2.host.example' }),
    soa: Object.freeze({
      primaryNs: 'ns1.host.example',
      rname: 'hostmaster.host.example',
      refresh: 3600,
      retry: 900,
      expire: 1209600,
      minimum: 300,
      ttl: 300,
    }),
    secondaryDns: Object.freeze([]),
  }),
});

const template = Object.freeze({
  serverId,
  version: 1,
  records: Object.freeze([
    Object.freeze({ key: 'apex-nameservers', owner: '@', type: 'NS', ttl: null, values: Object.freeze(['<ns1>', '<ns2>']), condition: 'always' }),
    Object.freeze({ key: 'apex-ipv4', owner: '@', type: 'A', ttl: null, values: Object.freeze(['<server-ipv4>']), condition: 'always' }),
  ]),
});

test('PowerDNS default zone reapply composition consumes live mail and DKIM registries', async () => {
  const service = await powerDnsHttpInternals.defaultZoneReapplyService({
    dnsIdentityRegistry: { getForServer: async () => identity },
    dnsZoneTemplateRegistry: { ensureForServer: async () => template },
    authoritativeService: { localServerId: serverId },
    domainRegistry: {
      getDomain: async () => ({
        id: domainId,
        serverId,
        websiteId: '2b4a28c2-b7fd-41cb-99a8-28ec7e84449d',
        primaryDomain: 'example.com',
        aliases: [],
        parentDomainId: null,
        desiredRevision: 1,
      }),
    },
    powerDnsSecretRegistry: { materializeForServer: async () => ({ serverId, apiKey: 'secret' }) },
    mailDomainRegistry: {
      listMailDomains: async () => [{
        id: mailDomainId,
        webDomainId: domainId,
        domainName: 'example.com',
        managementMode: 'local',
        status: 'enabled',
        revision: 2,
      }],
    },
    mailDkimRegistry: {
      getKey: async () => ({
        mailDomainId,
        domainName: 'example.com',
        selector: 'current',
        revision: 1,
        dnsRecord: {
          type: 'TXT',
          name: 'current._domainkey.example.com',
          value: 'v=DKIM1; k=rsa; p=current',
        },
      }),
    },
    mailDkimRetirementRegistry: { getRetirement: async () => null },
    mailServiceIdentityRegistry: {
      getForServer: async () => ({
        serverId,
        hostname: 'mail.example.com',
        revision: 3,
        ready: true,
      }),
    },
    mailDiscoveryEndpointResolver: {
      resolve: async () => ({
        version: 1,
        mailDomainId,
        serverId,
        revision: 1,
        autodiscover: {
          ready: true,
          hostname: 'autodiscover.example.com',
          protocol: 'https',
          path: '/autodiscover/autodiscover.xml',
        },
        autoconfig: null,
      }),
    },
    zoneManager: {
      getZone: async () => ({
        zoneName: 'example.com',
        kind: 'Native',
        dnssec: false,
        serial: 2026091601,
        rrsets: [],
      }),
      apply: async () => { throw new Error('preview must not mutate'); },
    },
    now: () => Date.parse('2026-09-17T00:00:00.000Z'),
  });

  const preview = await service.preview({ domainId });
  const keys = new Set(preview.records.map((record) => record.key));
  assert.equal(preview.mailState.enabled, true);
  assert.equal(keys.has('mail-mx'), true);
  assert.equal(keys.has('mail-dkim-current'), true);
  assert.equal(keys.has('mail-imap'), true);
  assert.equal(keys.has('mail-submission'), true);
  assert.equal(keys.has('mail-autodiscover-ipv4'), true);
  assert.equal(keys.has('mail-autoconfig-ipv4'), false);
  assert.equal(preview.mailState.mailDiscoveryEndpointRevision, 1);
  assert.equal(JSON.stringify(preview).includes('secret'), false);
});

test('PowerDNS zone reapply composition rejects partial mail desired-state wiring', async () => {
  await assert.rejects(
    powerDnsHttpInternals.defaultZoneReapplyService({
      dnsIdentityRegistry: { getForServer: async () => identity },
      dnsZoneTemplateRegistry: { ensureForServer: async () => template },
      authoritativeService: { localServerId: serverId },
      domainRegistry: { getDomain: async () => null },
      powerDnsSecretRegistry: { materializeForServer: async () => ({}) },
      mailDomainRegistry: { listMailDomains: async () => [] },
      zoneManager: { getZone: async () => null, apply: async () => ({}) },
    }),
    (error) => error instanceof PowerDnsHttpError
      && error.code === 'dns_zone_reapply_mail_dependencies_invalid',
  );
});
