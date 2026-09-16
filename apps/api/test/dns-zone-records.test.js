import assert from 'node:assert/strict';
import test from 'node:test';
import { createDnsZoneRecordsService, DnsZoneRecordsError, dnsZoneRecordsInternals } from '../src/dns-zone-records.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'a'.repeat(43);
const domain = Object.freeze({
  id: domainId,
  serverId,
  primaryDomain: 'example.com',
  parentDomainId: null,
});

function fixture({ domainState = domain } = {}) {
  const calls = [];
  const manager = {
    getZone: async (input) => {
      calls.push(['getZone', input]);
      return { zoneName: 'example.com', serial: 2026091601, dnssec: false, kind: 'Native', rrsets: [] };
    },
    apply: async (input) => {
      calls.push(['apply', input]);
      return { satisfied: true, changed: true, serial: 2026091602, record: { ...input.record, source: 'manual' } };
    },
    remove: async (input) => {
      calls.push(['remove', input]);
      return { satisfied: true, changed: true, serial: 2026091602, owner: input.owner, type: input.type };
    },
  };
  const service = createDnsZoneRecordsService({
    domainRegistry: { getDomain: async (id) => id === domainState.id ? domainState : null },
    powerDnsSecretRegistry: { materializeForServer: async () => ({ serverId, revision: 2, apiKey }) },
    localServerId: serverId,
    manager,
  });
  return { calls, service };
}

test('Domain DNS zone read returns provider RRsets without exposing the PowerDNS key', async () => {
  const { calls, service } = fixture();
  const result = await service.getZone({ domainId });

  assert.equal(result.domainId, domainId);
  assert.equal(result.serverId, serverId);
  assert.equal(result.zoneName, 'example.com');
  assert.equal(result.serial, 2026091601);
  assert.deepEqual(calls, [['getZone', { zoneName: 'example.com', apiKey }]]);
  assert.equal(Object.hasOwn(result, 'apiKey'), false);
});

test('manual DNS apply uses canonical owner/value validation and expected SOA serial', async () => {
  const { calls, service } = fixture();
  const result = await service.apply({
    domainId,
    input: {
      owner: '_submission._tcp',
      type: 'srv',
      ttl: 300,
      values: ['000 001 00587 mail.example.com.'],
      expectedSerial: 2026091601,
    },
  });

  assert.equal(result.changed, true);
  const apply = calls.find((entry) => entry[0] === 'apply')[1];
  assert.equal(apply.zoneName, 'example.com');
  assert.equal(apply.apiKey, apiKey);
  assert.equal(apply.expectedSerial, 2026091601);
  assert.deepEqual(apply.record, {
    owner: '_submission._tcp.example.com',
    type: 'SRV',
    ttl: 300,
    values: ['0 1 587 mail.example.com'],
  });
});

test('manual DNS apply supports wildcard and canonical CAA normalization', async () => {
  const { calls, service } = fixture();
  await service.apply({
    domainId,
    input: {
      owner: '*',
      type: 'CAA',
      ttl: 600,
      values: ['000 ISSUE letsencrypt.org'],
      expectedSerial: 2026091601,
    },
  });

  const apply = calls.find((entry) => entry[0] === 'apply')[1];
  assert.equal(apply.record.owner, '*.example.com');
  assert.deepEqual(apply.record.values, ['0 issue letsencrypt.org']);
});

test('manual DNS delete normalizes an in-zone FQDN and carries expected serial', async () => {
  const { calls, service } = fixture();
  const result = await service.remove({
    domainId,
    input: { owner: 'custom.example.com', type: 'txt', expectedSerial: 2026091601 },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(calls.find((entry) => entry[0] === 'remove')[1], {
    zoneName: 'example.com',
    apiKey,
    owner: 'custom.example.com',
    type: 'TXT',
    expectedSerial: 2026091601,
    notifySecondaries: false,
  });
});

test('manual DNS record validation rejects malformed CNAME values and stale-shape bodies before provider mutation', async () => {
  const { calls, service } = fixture();
  await assert.rejects(
    service.apply({
      domainId,
      input: {
        owner: 'www',
        type: 'CNAME',
        ttl: 300,
        values: ['target.example.com', 'second.example.com'],
        expectedSerial: 2026091601,
      },
    }),
    (error) => error instanceof DnsZoneRecordsError && error.code === 'dns_zone_record_values_invalid',
  );
  assert.equal(calls.some((entry) => entry[0] === 'apply'), false);
});

test('manual DNS record service is root-domain and local-server scoped', async () => {
  const child = fixture({ domainState: { ...domain, parentDomainId: '94827596-8c2b-42aa-a438-8118f2bf0c62' } }).service;
  await assert.rejects(
    child.getZone({ domainId }),
    (error) => error instanceof DnsZoneRecordsError && error.code === 'dns_zone_root_domain_required',
  );

  const remote = fixture({ domainState: { ...domain, serverId: 'b139cd61-fe69-4726-b2c7-3f8609376c7e' } }).service;
  await assert.rejects(
    remote.getZone({ domainId }),
    (error) => error instanceof DnsZoneRecordsError && error.code === 'dns_zone_local_server_required',
  );
});

test('manual DNS owner helper accepts apex, relative and in-zone FQDN forms', () => {
  assert.equal(dnsZoneRecordsInternals.recordOwner('example.com', '@'), 'example.com');
  assert.equal(dnsZoneRecordsInternals.recordOwner('example.com', 'www'), 'www.example.com');
  assert.equal(dnsZoneRecordsInternals.recordOwner('example.com', 'www.example.com'), 'www.example.com');
});
