import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteDnsZoneProvisioningHandler } from '../src/website-dns-zone-provisioning-handler.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'a'.repeat(43);

function context() {
  return {
    intent: {
      adapter: 'powerdns-zone',
      serverId,
      webDomainId: '3854e385-adfc-42bd-bccf-f655f24cd68f',
      zoneName: 'example.com',
      templateVersion: 5,
      templateSnapshot: [
        { key: 'apex-nameservers', owner: '@', type: 'NS', ttl: null, values: ['<ns1>', '<ns2>'], condition: 'always' },
      ],
      dnsIdentityRevision: 4,
      secondaryDns: [],
      serial: 2026091501,
      dnssec: false,
      records: [
        { key: 'zone-soa', owner: 'example.com', type: 'SOA', ttl: 300, values: ['ns1.host.example hostmaster.host.example 2026091501 3600 900 1209600 300'], source: 'template', templateVersion: 5 },
        { key: 'apex-nameservers', owner: 'example.com', type: 'NS', ttl: 300, values: ['ns1.host.example', 'ns2.host.example'], source: 'template', templateVersion: 5 },
      ],
    },
  };
}

test('applies immutable DNS intent and exposes snapshot evidence', async () => {
  const calls = [];
  const handler = createWebsiteDnsZoneProvisioningHandler({
    materializeSecret: async () => ({ serverId, apiKey }),
    zoneManager: {
      inspect: async () => ({ satisfied: false, reason: 'powerdns_zone_missing' }),
      apply: async (input) => {
        calls.push(input);
        return { satisfied: true, serial: 2026091501, dnssec: false, managedRrsetCount: 2, manualRrsetCount: 0, created: true, changedRrsetCount: 2 };
      },
      compensate: async () => ({ satisfied: true, deleted: true }),
      inspectCompensation: async () => ({ satisfied: true, deleted: true }),
    },
  });
  const evidence = await handler.apply(context());
  assert.equal(calls[0].zoneName, 'example.com');
  assert.equal(calls[0].apiKey, apiKey);
  assert.equal(calls[0].records.length, 2);
  assert.equal(evidence.templateVersion, 5);
  assert.match(evidence.templateSnapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(evidence.created, true);
});

test('inspect does not mutate a missing zone', async () => {
  let applyCalls = 0;
  const handler = createWebsiteDnsZoneProvisioningHandler({
    materializeSecret: async () => ({ serverId, apiKey }),
    zoneManager: {
      inspect: async () => ({ satisfied: false, reason: 'powerdns_zone_missing' }),
      apply: async () => { applyCalls += 1; return { satisfied: true }; },
      compensate: async () => ({ satisfied: true }),
      inspectCompensation: async () => ({ satisfied: true }),
    },
  });
  const result = await handler.inspect(context());
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'powerdns_zone_missing');
  assert.equal(applyCalls, 0);
});

test('compensation delegates to manual-record-safe PowerDNS manager', async () => {
  let compensated = null;
  const handler = createWebsiteDnsZoneProvisioningHandler({
    materializeSecret: async () => ({ serverId, apiKey }),
    zoneManager: {
      inspect: async () => ({ satisfied: true }),
      apply: async () => ({ satisfied: true }),
      compensate: async (input) => { compensated = input; return { satisfied: true, deleted: true }; },
      inspectCompensation: async () => ({ satisfied: false }),
    },
  });
  const result = await handler.compensate(context());
  assert.equal(result.satisfied, true);
  assert.equal(compensated.zoneName, 'example.com');
  assert.equal(compensated.apiKey, apiKey);
});
