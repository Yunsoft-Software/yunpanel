import assert from 'node:assert/strict';
import test from 'node:test';
import { createDnsReadinessService, dnsReadinessInternals, DnsReadinessError } from '../src/dns-readiness.js';

const ZONE_ID = 'zone-1';
const DOMAIN_ID = 'domain-1';
const SERVER_ID = 'server-1';

function absent(code = 'ENODATA') {
  return Object.assign(new Error('private resolver detail must not escape'), { code });
}

function fixture({
  domain = {},
  server = {},
  credential = { id: 'credential-1', provider: 'cloudflare', configured: true },
  resolve4,
  resolve6 = async () => { throw absent(); },
  resolveCname = async () => { throw absent(); },
} = {}) {
  const currentDomain = {
    id: DOMAIN_ID,
    serverId: SERVER_ID,
    primaryDomain: 'example.test',
    aliases: ['www.example.test'],
    state: 'active',
    desiredRevision: 2,
    appliedRevision: 2,
    ...domain,
  };
  const currentServer = {
    id: SERVER_ID,
    inventory: {
      network: [
        { interface: 'eth0', family: 'IPv4', address: '203.0.113.10' },
        { interface: 'eth0', family: 'IPv6', address: '2001:0db8:0:0:0:0:0:10' },
      ],
    },
    ...server,
  };
  return createDnsReadinessService({
    dnsHostingRegistry: {
      async getZone(id) {
        return id === ZONE_ID ? { id, zoneName: currentDomain.primaryDomain, webDomainId: currentDomain.id } : null;
      },
    },
    domainRegistry: { async getDomain(id) { return id === DOMAIN_ID ? currentDomain : null; } },
    serverRegistry: { async getServer(id) { return id === SERVER_ID ? currentServer : null; } },
    dnsProviderCredentialRegistry: { async getForZone(id) { return id === ZONE_ID ? credential : null; } },
    resolve4,
    resolve6,
    resolveCname,
    now: () => Date.parse('2026-09-11T08:30:00.000Z'),
  });
}

test('DNS readiness resolves canonical A, AAAA and CNAME evidence without exposing provider secrets', async () => {
  const service = fixture({
    resolve4: async (hostname) => [{ address: '203.0.113.10', ttl: hostname.startsWith('www.') ? 120 : 300 }],
    resolve6: async () => [{ address: '2001:db8::10', ttl: 300 }],
    resolveCname: async (hostname) => {
      if (hostname.startsWith('www.')) return ['EXAMPLE.test.'];
      throw absent();
    },
  });

  const result = await service.inspectZone(ZONE_ID);
  assert.equal(result.observedAt, '2026-09-11T08:30:00.000Z');
  assert.deepEqual(result.expected, { ipv4: ['203.0.113.10'], ipv6: ['2001:db8::10'] });
  assert.deepEqual(result.hostnames.map(({ hostname, state }) => ({ hostname, state })), [
    { hostname: 'example.test', state: 'ready' },
    { hostname: 'www.example.test', state: 'ready' },
  ]);
  assert.deepEqual(result.hostnames[1].records.cname, ['example.test']);
  assert.deepEqual(result.hostnames[0].matchedAddresses, ['2001:db8::10', '203.0.113.10']);
  assert.deepEqual(result.routing, { ready: true, reasonCodes: [], action: null });
  assert.deepEqual(result.acme.http01, { ready: true, reasonCodes: [], action: null });
  assert.deepEqual(result.acme.dns01, {
    ready: true, provider: 'cloudflare', reasonCodes: [], action: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /token|private resolver detail/i);
});

test('DNS readiness degrades with bounded resolver, target and ACME diagnosis', async () => {
  const service = fixture({
    domain: { state: 'draft', desiredRevision: 3, appliedRevision: 2 },
    credential: null,
    resolve4: async (hostname) => {
      if (hostname.startsWith('www.')) throw absent('ETIMEOUT');
      return [{ address: '198.51.100.44', ttl: 60 }];
    },
  });

  const result = await service.inspectZone(ZONE_ID);
  assert.deepEqual(result.hostnames.map(({ state, action }) => ({ state, action })), [
    { state: 'target_mismatch', action: 'point_hostname_to_managed_server' },
    { state: 'resolver_error', action: 'retry_dns_resolution' },
  ]);
  assert.deepEqual(result.routing, {
    ready: false,
    reasonCodes: ['dns_resolver_unavailable', 'dns_target_mismatch'],
    action: 'correct_public_dns_records',
  });
  assert.deepEqual(result.acme.http01, {
    ready: false,
    reasonCodes: ['dns_resolver_unavailable', 'dns_target_mismatch', 'dns_http_domain_not_active'],
    action: 'activate_domain_for_http01',
  });
  assert.deepEqual(result.acme.dns01, {
    ready: false,
    provider: null,
    reasonCodes: ['dns_provider_credential_required'],
    action: 'configure_dns_provider_credential',
  });
  assert.doesNotMatch(JSON.stringify(result), /ETIMEOUT|private resolver detail/);
});

test('DNS readiness does not claim a target match when managed Server addresses are unavailable', async () => {
  const service = fixture({
    server: { inventory: { network: [] } },
    resolve4: async () => [{ address: '203.0.113.10', ttl: 60 }],
  });
  const result = await service.inspectZone(ZONE_ID);
  assert.equal(result.hostnames[0].state, 'expected_unavailable');
  assert.equal(result.hostnames[0].action, 'inspect_managed_server_addresses');
  assert.deepEqual(result.routing.reasonCodes, ['dns_expected_address_unavailable']);
});

test('DNS readiness degrades when any published address leaves the managed Server', async () => {
  const service = fixture({
    domain: { aliases: [] },
    resolve4: async () => [
      { address: '203.0.113.10', ttl: 60 },
      { address: '198.51.100.44', ttl: 60 },
    ],
  });
  const result = await service.inspectZone(ZONE_ID);
  assert.equal(result.hostnames[0].state, 'target_mismatch');
  assert.deepEqual(result.hostnames[0].matchedAddresses, ['203.0.113.10']);
  assert.deepEqual(result.routing.reasonCodes, ['dns_target_mismatch']);
});

test('DNS readiness requires exact persisted relationships and bounds resolver output', async () => {
  const missingZone = fixture({ resolve4: async () => [] });
  await assert.rejects(
    missingZone.inspectZone('missing-zone'),
    (error) => error instanceof DnsReadinessError && error.code === 'dns_zone_not_found' && error.status === 404,
  );
  assert.throws(
    () => dnsReadinessInternals.addressRecords(Array.from({ length: 17 }, () => ({ address: '203.0.113.10', ttl: 60 })), 4),
    (error) => error instanceof DnsReadinessError && error.code === 'dns_resolution_invalid' && error.status === 503,
  );
});

test('DNS readiness fails closed when credential metadata cannot be inspected', async () => {
  const service = createDnsReadinessService({
    dnsHostingRegistry: { async getZone() { return { id: ZONE_ID, zoneName: 'example.test', webDomainId: DOMAIN_ID }; } },
    domainRegistry: {
      async getDomain() {
        return {
          id: DOMAIN_ID, serverId: SERVER_ID, primaryDomain: 'example.test', aliases: [],
          state: 'active', desiredRevision: 1, appliedRevision: 1,
        };
      },
    },
    serverRegistry: {
      async getServer() {
        return { id: SERVER_ID, inventory: { network: [{ family: 'IPv4', address: '203.0.113.10' }] } };
      },
    },
    dnsProviderCredentialRegistry: { async getForZone() { throw new Error('private store path'); } },
    resolve4: async () => [{ address: '203.0.113.10', ttl: 60 }],
    resolve6: async () => { throw absent(); },
    resolveCname: async () => { throw absent(); },
  });
  const result = await service.inspectZone(ZONE_ID);
  assert.deepEqual(result.acme.dns01, {
    ready: false,
    provider: null,
    reasonCodes: ['dns_provider_credential_unavailable'],
    action: 'inspect_dns_provider_credential_store',
  });
  assert.doesNotMatch(JSON.stringify(result), /private store path/);
});
