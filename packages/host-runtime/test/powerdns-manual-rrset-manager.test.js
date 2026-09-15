import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPowerDnsManualRrsetManager,
  PowerDnsManualRrsetManagerError,
  powerDnsManualRrsetManagerInternals,
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

function zone(rrsets, serial = 2026091601) {
  return Object.freeze({
    zoneName: 'example.com',
    id: 'example.com.',
    kind: 'Native',
    dnssec: false,
    serial,
    rrsets: Object.freeze(rrsets),
  });
}

function response(status = 204) {
  return { status, ok: status >= 200 && status < 300 };
}

test('manual RRset manager converts PowerDNS wire content into a safe public zone view', async () => {
  const live = zone([
    rrset({ name: 'example.com.', type: 'TXT', contents: ['"hello " "world"'] }),
    rrset({ name: 'example.com.', type: 'CAA', contents: ['0 issue "letsencrypt.org"'] }),
    rrset({ name: 'mail.example.com.', type: 'MX', contents: ['10 mx.example.net.'] }),
  ]);
  const manager = createPowerDnsManualRrsetManager({
    zoneManager: { getZone: async () => live },
    fetchFn: async () => { throw new Error('unused'); },
  });

  const result = await manager.getZone({ zoneName: 'example.com', apiKey });
  assert.equal(result.zoneName, 'example.com');
  assert.deepEqual(result.rrsets[0].records, [{ value: 'hello world', disabled: false }]);
  assert.deepEqual(result.rrsets[1].records, [{ value: '0 issue letsencrypt.org', disabled: false }]);
  assert.deepEqual(result.rrsets[2].records, [{ value: '10 mx.example.net', disabled: false }]);
  assert.equal(result.rrsets.every((entry) => entry.source === 'manual'), true);
});

test('manual RRset apply PATCHes an unmanaged record and verifies post-condition', async () => {
  const before = zone([]);
  const after = zone([
    rrset({ name: 'custom.example.com.', type: 'A', contents: ['198.51.100.44'] }),
  ], 2026091602);
  const inspections = [before, after];
  const requests = [];
  const manager = createPowerDnsManualRrsetManager({
    zoneManager: { getZone: async () => inspections.shift() ?? after },
    fetchFn: async (url, options) => {
      requests.push({ url, options });
      return response();
    },
  });

  const result = await manager.apply({
    zoneName: 'example.com',
    apiKey,
    record: { owner: 'custom.example.com', type: 'A', ttl: 300, values: ['198.51.100.44'] },
  });

  assert.equal(result.changed, true);
  assert.equal(result.record.source, 'manual');
  assert.equal(result.record.owner, 'custom.example.com');
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.rrsets[0].changetype, 'REPLACE');
  assert.deepEqual(body.rrsets[0].comments, []);
  assert.deepEqual(body.rrsets[0].records, [{ content: '198.51.100.44', disabled: false }]);
});

test('manual RRset apply is a no-op when the unmanaged live RRset already matches', async () => {
  const live = zone([
    rrset({ name: 'custom.example.com.', type: 'A', contents: ['198.51.100.44'] }),
  ]);
  let mutationCalls = 0;
  const manager = createPowerDnsManualRrsetManager({
    zoneManager: { getZone: async () => live },
    fetchFn: async () => { mutationCalls += 1; return response(); },
  });

  const result = await manager.apply({
    zoneName: 'example.com',
    apiKey,
    record: { owner: 'custom.example.com', type: 'A', ttl: 300, values: ['198.51.100.44'] },
  });
  assert.equal(result.changed, false);
  assert.equal(mutationCalls, 0);
});

test('manual RRset manager refuses to overwrite or delete YunPanel-managed RRsets', async () => {
  const managed = rrset({
    name: 'example.com.',
    type: 'A',
    contents: ['203.0.113.10'],
    managed: { source: 'template', key: 'apex-ipv4', templateVersion: 4 },
  });
  const manager = createPowerDnsManualRrsetManager({
    zoneManager: { getZone: async () => zone([managed]) },
    fetchFn: async () => { throw new Error('must not mutate'); },
  });

  await assert.rejects(
    manager.apply({
      zoneName: 'example.com',
      apiKey,
      record: { owner: 'example.com', type: 'A', ttl: 300, values: ['198.51.100.44'] },
    }),
    (error) => error instanceof PowerDnsManualRrsetManagerError
      && error.code === 'powerdns_manual_managed_record_conflict'
      && error.status === 409,
  );
  await assert.rejects(
    manager.remove({ zoneName: 'example.com', apiKey, owner: 'example.com', type: 'A' }),
    (error) => error instanceof PowerDnsManualRrsetManagerError
      && error.code === 'powerdns_manual_managed_record_conflict',
  );
});

test('manual RRset delete PATCHes only the requested unmanaged owner/type and verifies absence', async () => {
  const existing = rrset({ name: 'custom.example.com.', type: 'TXT', contents: ['"remove-me"'] });
  const inspections = [zone([existing]), zone([], 2026091602)];
  const requests = [];
  const manager = createPowerDnsManualRrsetManager({
    zoneManager: { getZone: async () => inspections.shift() ?? zone([]) },
    fetchFn: async (_url, options) => { requests.push(options); return response(); },
  });

  const result = await manager.remove({ zoneName: 'example.com', apiKey, owner: 'custom.example.com', type: 'TXT' });
  assert.equal(result.changed, true);
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].body);
  assert.deepEqual(body.rrsets[0], {
    name: 'custom.example.com.',
    type: 'TXT',
    changetype: 'DELETE',
    records: [],
    comments: [],
  });
});

test('manual RRset manager blocks CNAME coexistence and owners outside the zone', async () => {
  const existing = rrset({ name: 'app.example.com.', type: 'A', contents: ['198.51.100.44'] });
  const manager = createPowerDnsManualRrsetManager({
    zoneManager: { getZone: async () => zone([existing]) },
    fetchFn: async () => { throw new Error('must not mutate'); },
  });

  await assert.rejects(
    manager.apply({
      zoneName: 'example.com',
      apiKey,
      record: { owner: 'app.example.com', type: 'CNAME', ttl: 300, values: ['target.example.com'] },
    }),
    (error) => error instanceof PowerDnsManualRrsetManagerError && error.code === 'powerdns_manual_cname_conflict',
  );
  assert.throws(
    () => powerDnsManualRrsetManagerInternals.normalizeManualRecord(
      { owner: 'outside.example.net', type: 'A', ttl: 300, values: ['198.51.100.44'] },
      'example.com',
    ),
    (error) => error instanceof PowerDnsManualRrsetManagerError && error.code === 'powerdns_manual_owner_outside_zone',
  );
});
