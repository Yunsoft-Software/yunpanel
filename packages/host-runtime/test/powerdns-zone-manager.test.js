import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPowerDnsZoneManager,
  PowerDnsZoneManagerError,
  powerDnsZoneManagerInternals,
} from '../src/powerdns-zone-manager.js';

const key = 'a'.repeat(43);

function response(status, payload = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  };
}

function desiredRecords() {
  return [
    {
      key: 'zone-soa', owner: 'example.com', type: 'SOA', ttl: 300,
      values: ['ns1.host.example hostmaster.host.example 2026091501 3600 900 1209600 300'],
      source: 'template', templateVersion: 7,
    },
    {
      key: 'apex-nameservers', owner: 'example.com', type: 'NS', ttl: 300,
      values: ['ns1.host.example', 'ns2.host.example'], source: 'template', templateVersion: 7,
    },
    {
      key: 'apex-ipv4', owner: 'example.com', type: 'A', ttl: 300,
      values: ['203.0.113.10'], source: 'template', templateVersion: 7,
    },
    {
      key: 'mail-spf', owner: 'example.com', type: 'TXT', ttl: 300,
      values: ['v=spf1 mx -all'], source: 'mail', templateVersion: null,
    },
  ];
}

function fakePowerDnsApi({ initialZone = null } = {}) {
  let zone = initialZone ? structuredClone(initialZone) : null;
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET' && path.endsWith('/zones/example.com.')) {
      return zone ? response(200, structuredClone(zone)) : response(404, { error: 'not found' });
    }
    if (method === 'POST' && path.endsWith('/zones')) {
      const body = JSON.parse(options.body);
      zone = {
        id: 'example.com.',
        kind: body.kind,
        dnssec: body.dnssec === true,
        rrsets: [
          {
            name: 'example.com.', type: 'SOA', ttl: 3600,
            records: [{ content: 'ns1.host.example. hostmaster.host.example. 1 10800 3600 604800 3600', disabled: false }],
            comments: [],
          },
          {
            name: 'example.com.', type: 'NS', ttl: 3600,
            records: body.nameservers.map((content) => ({ content, disabled: false })),
            comments: [],
          },
        ],
      };
      return response(201, structuredClone(zone));
    }
    if (method === 'PATCH' && path.endsWith('/zones/example.com.')) {
      const body = JSON.parse(options.body);
      for (const rrset of body.rrsets) {
        const index = zone.rrsets.findIndex((candidate) => candidate.name === rrset.name && candidate.type === rrset.type);
        if (rrset.changetype === 'DELETE') {
          if (index >= 0) zone.rrsets.splice(index, 1);
        } else if (index >= 0) zone.rrsets[index] = structuredClone(rrset);
        else zone.rrsets.push(structuredClone(rrset));
      }
      return response(204);
    }
    if (method === 'DELETE' && path.endsWith('/zones/example.com.')) {
      zone = null;
      return response(204);
    }
    return response(500, { error: 'unexpected request' });
  };
  return { fetchFn, calls, get zone() { return zone; } };
}

test('serializes PowerDNS content and ownership comments', () => {
  const rrset = powerDnsZoneManagerInternals.desiredRrset(desiredRecords()[3]);
  assert.equal(rrset.name, 'example.com.');
  assert.equal(rrset.records[0].content, '"v=spf1 mx -all"');
  assert.equal(rrset.comments[0].account, 'yunpanel');
  assert.deepEqual(powerDnsZoneManagerInternals.parseManagedComment(rrset.comments), {
    source: 'mail',
    key: 'mail-spf',
    templateVersion: null,
  });
});

test('creates a zone then replaces generated SOA and NS with managed RRsets', async () => {
  const api = fakePowerDnsApi();
  const manager = createPowerDnsZoneManager({ fetchFn: api.fetchFn });
  const applied = await manager.apply({
    zoneName: 'example.com',
    apiKey: key,
    records: desiredRecords(),
    dnssec: false,
  });
  assert.equal(applied.satisfied, true);
  assert.equal(applied.created, true);
  assert.equal(applied.managedRrsetCount, 4);
  assert.equal(applied.manualRrsetCount, 0);
  assert.equal(api.calls.some((call) => call.method === 'POST'), true);
  const patch = api.calls.find((call) => call.method === 'PATCH');
  assert.ok(patch);
  assert.equal(patch.body.rrsets.some((rrset) => rrset.type === 'SOA'), true);
  assert.equal(patch.body.rrsets.every((rrset) => rrset.comments?.[0]?.account === 'yunpanel'), true);
});

test('fails closed instead of overwriting a manual RRset', async () => {
  const api = fakePowerDnsApi({
    initialZone: {
      id: 'example.com.', kind: 'Native', dnssec: false,
      rrsets: [{
        name: 'example.com.', type: 'A', ttl: 300,
        records: [{ content: '198.51.100.44', disabled: false }], comments: [],
      }],
    },
  });
  const manager = createPowerDnsZoneManager({ fetchFn: api.fetchFn });
  await assert.rejects(
    manager.apply({ zoneName: 'example.com', apiKey: key, records: desiredRecords() }),
    (error) => error instanceof PowerDnsZoneManagerError && error.code === 'powerdns_zone_manual_record_conflict',
  );
  assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
  assert.equal(api.calls.some((call) => call.method === 'DELETE'), false);
});

test('preserves unrelated manual RRsets while inspecting managed desired state', async () => {
  const rrsets = desiredRecords().map(powerDnsZoneManagerInternals.desiredRrset).map((entry) => structuredClone(entry));
  rrsets.push({
    name: 'custom.example.com.', type: 'A', ttl: 300,
    records: [{ content: '198.51.100.20', disabled: false }], comments: [],
  });
  const api = fakePowerDnsApi({ initialZone: { id: 'example.com.', kind: 'Native', dnssec: false, rrsets } });
  const manager = createPowerDnsZoneManager({ fetchFn: api.fetchFn });
  const result = await manager.inspect({ zoneName: 'example.com', apiKey: key, records: desiredRecords() });
  assert.equal(result.satisfied, true);
  assert.equal(result.manualRrsetCount, 1);
});

test('refuses compensation when a zone has manual RRsets', async () => {
  const managed = desiredRecords().map(powerDnsZoneManagerInternals.desiredRrset).map((entry) => structuredClone(entry));
  managed.push({
    name: 'manual.example.com.', type: 'TXT', ttl: 300,
    records: [{ content: '"keep-me"', disabled: false }], comments: [],
  });
  const api = fakePowerDnsApi({ initialZone: { id: 'example.com.', kind: 'Native', dnssec: false, rrsets: managed } });
  const manager = createPowerDnsZoneManager({ fetchFn: api.fetchFn });
  await assert.rejects(
    manager.compensate({ zoneName: 'example.com', apiKey: key }),
    (error) => error instanceof PowerDnsZoneManagerError && error.code === 'powerdns_zone_compensation_manual_records',
  );
  assert.ok(api.zone);
});
