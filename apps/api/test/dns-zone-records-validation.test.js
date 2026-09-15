import assert from 'node:assert/strict';
import test from 'node:test';
import { createDnsZoneRecordsService, DnsZoneRecordsError } from '../src/dns-zone-records.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const domain = Object.freeze({ id: domainId, serverId, primaryDomain: 'example.com', parentDomainId: null });

test('manual DNS service rejects extra body fields before materializing PowerDNS credentials', async () => {
  let secretCalls = 0;
  let mutationCalls = 0;
  const service = createDnsZoneRecordsService({
    domainRegistry: { getDomain: async () => domain },
    powerDnsSecretRegistry: {
      materializeForServer: async () => {
        secretCalls += 1;
        return { serverId, apiKey: 'a'.repeat(43) };
      },
    },
    localServerId: serverId,
    manager: {
      getZone: async () => ({}),
      apply: async () => { mutationCalls += 1; return {}; },
      remove: async () => { mutationCalls += 1; return {}; },
    },
  });

  await assert.rejects(
    service.apply({
      domainId,
      input: {
        owner: '@',
        type: 'TXT',
        ttl: 300,
        values: ['hello'],
        expectedSerial: 2026091601,
        domainId: '997c6ac8-4db4-4500-a24e-0c8ff84825c6',
      },
    }),
    (error) => error instanceof DnsZoneRecordsError && error.code === 'dns_zone_record_input_invalid',
  );
  assert.equal(secretCalls, 0);
  assert.equal(mutationCalls, 0);
});
