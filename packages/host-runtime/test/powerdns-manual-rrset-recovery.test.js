import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPowerDnsManualRrsetManager,
  PowerDnsManualRrsetManagerError,
} from '../src/powerdns-manual-rrset-manager.js';

const apiKey = 'a'.repeat(43);

function rrset({ name, type, ttl = 300, contents, managed = null }) {
  return Object.freeze({
    name,
    type,
    ttl,
    records: Object.freeze(contents.map((content) => Object.freeze({ content, disabled: false }))),
    comments: Object.freeze([]),
    managed,
  });
}

function zone(rrsets, serial) {
  return Object.freeze({
    zoneName: 'example.com',
    id: 'example.com.',
    kind: 'Native',
    dnssec: false,
    serial,
    rrsets: Object.freeze(rrsets),
  });
}

function soa(serial = 2026091601) {
  return rrset({
    name: 'example.com.',
    type: 'SOA',
    contents: [`ns1.example.com. hostmaster.example.com. ${serial} 3600 900 1209600 300`],
  });
}

test('manual DNS mutation rejects a stale expected SOA serial before PATCH', async () => {
  let patchCalls = 0;
  const manager = createPowerDnsManualRrsetManager({
    zoneManager: { getZone: async () => zone([], 2026091602) },
    fetchFn: async () => { patchCalls += 1; return { ok: true, status: 204 }; },
  });

  await assert.rejects(
    manager.apply({
      zoneName: 'example.com',
      apiKey,
      expectedSerial: 2026091601,
      record: { owner: 'app.example.com', type: 'A', ttl: 300, values: ['198.51.100.44'] },
    }),
    (error) => error instanceof PowerDnsManualRrsetManagerError
      && error.code === 'powerdns_manual_serial_conflict'
      && error.status === 409,
  );
  assert.equal(patchCalls, 0);
});

test('manual DNS apply accepts an uncertain PATCH when post-condition proves the RRset exists', async () => {
  const before = zone([soa()], 2026091601);
  const after = zone([
    soa(2026091602),
    rrset({ name: 'app.example.com.', type: 'A', contents: ['198.51.100.44'] }),
  ], 2026091602);
  const inspections = [before, after];
  const manager = createPowerDnsManualRrsetManager({
    zoneManager: { getZone: async () => inspections.shift() ?? after },
    fetchFn: async () => { throw new Error('connection closed after PATCH'); },
  });

  const result = await manager.apply({
    zoneName: 'example.com',
    apiKey,
    expectedSerial: 2026091601,
    record: { owner: 'app.example.com', type: 'A', ttl: 300, values: ['198.51.100.44'] },
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.changed, true);
  assert.equal(result.serial, 2026091602);
});

test('manual DNS delete accepts an uncertain PATCH when post-condition proves absence', async () => {
  const existing = rrset({ name: 'app.example.com.', type: 'TXT', contents: ['"delete-me"'] });
  const before = zone([soa(), existing], 2026091601);
  const after = zone([soa(2026091602)], 2026091602);
  const inspections = [before, after];
  const manager = createPowerDnsManualRrsetManager({
    zoneManager: { getZone: async () => inspections.shift() ?? after },
    fetchFn: async () => { throw new Error('connection closed after PATCH'); },
  });

  const result = await manager.remove({
    zoneName: 'example.com',
    apiKey,
    owner: 'app.example.com',
    type: 'TXT',
    expectedSerial: 2026091601,
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.changed, true);
  assert.equal(result.serial, 2026091602);
});
