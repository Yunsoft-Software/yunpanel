import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCloudflareDnsManager,
  CloudflareDnsManagerError,
  cloudflareDnsManagerInternals,
} from '../src/cloudflare-dns-manager.js';

const ZONE_PROVIDER_ID = 'a'.repeat(32);
const RECORD_PROVIDER_ID = 'b'.repeat(32);
const CREDENTIAL_ID = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const DNS_ZONE_ID = '822fa920-166c-4a7a-a26b-476c81d82165';
const TOKEN = 'cloudflare_private_token_for_dns_test';

function response(result, { status = 200, success = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify({ success, result }); },
  };
}

function fixture(initialRecords = []) {
  const calls = [];
  let records = initialRecords.map((entry) => ({ id: RECORD_PROVIDER_ID, ...entry }));
  const fetchFn = async (url, options) => {
    const parsed = new URL(url);
    const call = { url, pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams), ...options };
    calls.push(call);
    assert.equal(parsed.origin + parsed.pathname.split('/zones')[0], cloudflareDnsManagerInternals.apiRoot);
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    if (parsed.pathname === '/client/v4/zones') {
      return response([{ id: ZONE_PROVIDER_ID, name: 'example.test', status: 'active' }]);
    }
    if (parsed.pathname === `/client/v4/zones/${ZONE_PROVIDER_ID}/dns_records` && options.method === 'GET') {
      return response(records);
    }
    if (parsed.pathname === `/client/v4/zones/${ZONE_PROVIDER_ID}/dns_records` && options.method === 'POST') {
      records = [{ id: RECORD_PROVIDER_ID, ...JSON.parse(options.body) }];
      return response(records[0]);
    }
    if (parsed.pathname === `/client/v4/zones/${ZONE_PROVIDER_ID}/dns_records/${RECORD_PROVIDER_ID}` && options.method === 'PUT') {
      records = [{ id: RECORD_PROVIDER_ID, ...JSON.parse(options.body) }];
      return response(records[0]);
    }
    if (parsed.pathname === `/client/v4/zones/${ZONE_PROVIDER_ID}/dns_records/${RECORD_PROVIDER_ID}` && options.method === 'DELETE') {
      records = [];
      return response({ id: RECORD_PROVIDER_ID });
    }
    throw new Error(`unexpected Cloudflare request ${options.method} ${parsed.pathname}`);
  };
  return {
    calls,
    currentRecords: () => records,
    setRecords(value) { records = value; },
    manager: createCloudflareDnsManager({ fetchFn }),
  };
}

function credential() {
  return { id: CREDENTIAL_ID, dnsZoneId: DNS_ZONE_ID, provider: 'cloudflare', token: TOKEN };
}

function desired(overrides = {}) {
  return { type: 'A', name: 'app.example.test', content: '203.0.113.10', ttl: 300, proxied: false, ...overrides };
}

function apply(snapshot, action = 'upsert') {
  return {
    provider: 'cloudflare', credentialId: CREDENTIAL_ID, dnsZoneId: DNS_ZONE_ID,
    zoneName: snapshot.zoneName, action, record: snapshot.desired,
    expectedSnapshotDigest: snapshot.snapshotDigest,
  };
}

function inspect(record = desired(), zoneName = 'example.test') {
  return {
    provider: 'cloudflare', credentialId: CREDENTIAL_ID, dnsZoneId: DNS_ZONE_ID, zoneName, record,
  };
}

test('Cloudflare adapter creates and confirms an absent record without exposing credentials', async () => {
  const fx = fixture();
  const snapshot = await fx.manager.inspectRecord(inspect(desired(), 'EXAMPLE.test.'), { dnsCredential: credential() });
  assert.deepEqual(snapshot.records, []);
  assert.match(snapshot.snapshotDigest, /^[a-f0-9]{64}$/);

  const result = await fx.manager.applyRecord(apply(snapshot), { dnsCredential: credential() });
  assert.deepEqual(result, {
    provider: 'cloudflare', action: 'upsert', zoneName: 'example.test',
    record: desired(), changed: true, state: 'present',
  });
  assert.equal(fx.currentRecords()[0].content, '203.0.113.10');
  assert.deepEqual(fx.calls.map(({ method }) => method), ['GET', 'GET', 'GET', 'GET', 'POST', 'GET']);
  assert.equal(fx.calls.every((call) => !String(call.url).includes(TOKEN) && !String(call.body ?? '').includes(TOKEN)), true);
  assert.doesNotMatch(JSON.stringify({ snapshot, result }), /cloudflare_private_token|10714f5d|822fa920/);
});

test('Cloudflare adapter replaces one previewed record and canonicalizes IPv6', async () => {
  const fx = fixture([desired({ content: '198.51.100.20' })]);
  const next = desired({ type: 'AAAA', content: '2001:0db8:0:0:0:0:0:10' });
  fx.setRecords([{ id: RECORD_PROVIDER_ID, ...next, content: '2001:db8::20' }]);
  const snapshot = await fx.manager.inspectRecord(inspect(next), { dnsCredential: credential() });
  assert.equal(snapshot.desired.content, '2001:db8::10');
  assert.equal(snapshot.records[0].content, '2001:db8::20');
  const result = await fx.manager.applyRecord(apply(snapshot), { dnsCredential: credential() });
  assert.equal(result.changed, true);
  assert.equal(result.record.content, '2001:db8::10');
  assert.ok(fx.calls.some(({ method }) => method === 'PUT'));
});

test('Cloudflare delete is exact and safe to repeat after an uncertain completion', async () => {
  const fx = fixture([desired()]);
  const snapshot = await fx.manager.inspectRecord(inspect(), { dnsCredential: credential() });
  const input = apply(snapshot, 'delete');
  const first = await fx.manager.applyRecord(input, { dnsCredential: credential() });
  assert.deepEqual({ changed: first.changed, state: first.state }, { changed: true, state: 'absent' });
  const repeated = await fx.manager.applyRecord(input, { dnsCredential: credential() });
  assert.deepEqual({ changed: repeated.changed, state: repeated.state }, { changed: false, state: 'absent' });
  assert.equal(fx.calls.filter(({ method }) => method === 'DELETE').length, 1);
});

test('Cloudflare adapter rejects provider drift before mutation', async () => {
  const fx = fixture();
  const snapshot = await fx.manager.inspectRecord(inspect(desired(), 'example.test_ignored'), { dnsCredential: credential() })
    .catch((error) => error);
  assert.equal(snapshot instanceof CloudflareDnsManagerError, true);

  const validSnapshot = await fx.manager.inspectRecord(inspect(), { dnsCredential: credential() });
  fx.setRecords([{ id: RECORD_PROVIDER_ID, ...desired({ content: '198.51.100.55' }) }]);
  await assert.rejects(
    fx.manager.applyRecord(apply(validSnapshot), { dnsCredential: credential() }),
    (error) => error instanceof CloudflareDnsManagerError && error.code === 'dns_provider_snapshot_stale',
  );
  assert.equal(fx.calls.some(({ method }) => ['POST', 'PUT', 'DELETE'].includes(method)), false);
});

test('Cloudflare adapter validates zone boundaries and sanitizes provider failures', async () => {
  const manager = createCloudflareDnsManager({
    fetchFn: async () => response([{ errors: [{ message: `do not leak ${TOKEN}` }] }], { status: 403, success: false }),
  });
  await assert.rejects(
    manager.inspectRecord(inspect(desired({ name: 'lookalike-example.test' })), { dnsCredential: credential() }),
    (error) => error instanceof CloudflareDnsManagerError && error.code === 'dns_record_outside_zone',
  );
  await assert.rejects(
    manager.inspectRecord(inspect(), { dnsCredential: credential() }),
    (error) => error instanceof CloudflareDnsManagerError && error.code === 'dns_provider_unauthorized'
      && !error.message.includes(TOKEN),
  );
});
