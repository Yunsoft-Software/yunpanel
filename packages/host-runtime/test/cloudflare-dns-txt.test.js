import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCloudflareDnsManager,
  CloudflareDnsManagerError,
} from '../src/cloudflare-dns-manager.js';

const ZONE_ID = 'a'.repeat(32);
const RECORD_ID = 'b'.repeat(32);
const CREDENTIAL_ID = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const DNS_ZONE_ID = '822fa920-166c-4a7a-a26b-476c81d82165';
const TOKEN = 'cloudflare_private_token_for_txt_test';
const DKIM = `v=DKIM1; k=rsa; p=${Buffer.alloc(256, 9).toString('base64')}`;

function response(result) {
  return { ok: true, status: 200, async text() { return JSON.stringify({ success: true, result }); } };
}

function fixture() {
  let records = [];
  const calls = [];
  const fetchFn = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ pathname: parsed.pathname, method: options.method, body: options.body });
    if (parsed.pathname === '/client/v4/zones') {
      return response([{ id: ZONE_ID, name: 'example.test', status: 'active' }]);
    }
    if (parsed.pathname === `/client/v4/zones/${ZONE_ID}/dns_records` && options.method === 'GET') {
      return response(records);
    }
    if (parsed.pathname === `/client/v4/zones/${ZONE_ID}/dns_records` && options.method === 'POST') {
      records = [{ id: RECORD_ID, ...JSON.parse(options.body) }];
      return response(records[0]);
    }
    if (parsed.pathname === `/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}` && options.method === 'DELETE') {
      records = [];
      return response({ id: RECORD_ID });
    }
    throw new Error(`unexpected request ${options.method} ${parsed.pathname}`);
  };
  return { manager: createCloudflareDnsManager({ fetchFn }), calls, records: () => records };
}

function credential() {
  return { id: CREDENTIAL_ID, dnsZoneId: DNS_ZONE_ID, provider: 'cloudflare', token: TOKEN };
}

function record(overrides = {}) {
  return {
    type: 'TXT',
    name: 'mail-2026._domainkey.example.test',
    content: DKIM,
    ttl: 300,
    proxied: false,
    ...overrides,
  };
}

function inspectInput(value = record()) {
  return {
    provider: 'cloudflare',
    credentialId: CREDENTIAL_ID,
    dnsZoneId: DNS_ZONE_ID,
    zoneName: 'example.test',
    record: value,
  };
}

test('Cloudflare TXT adapter preserves DKIM content through create and exact delete', async () => {
  const fx = fixture();
  const snapshot = await fx.manager.inspectRecord(inspectInput(), { dnsCredential: credential() });
  assert.equal(snapshot.desired.content, DKIM);
  const create = await fx.manager.applyRecord({
    ...inspectInput(snapshot.desired),
    action: 'upsert',
    expectedSnapshotDigest: snapshot.snapshotDigest,
  }, { dnsCredential: credential() });
  assert.equal(create.state, 'present');
  assert.equal(fx.records()[0].content, DKIM);
  assert.equal(fx.records()[0].proxied, false);

  const current = await fx.manager.inspectRecord(inspectInput(), { dnsCredential: credential() });
  const removed = await fx.manager.applyRecord({
    ...inspectInput(current.desired),
    action: 'delete',
    expectedSnapshotDigest: current.snapshotDigest,
  }, { dnsCredential: credential() });
  assert.equal(removed.state, 'absent');
  assert.equal(fx.records().length, 0);
  assert.equal(fx.calls.some((entry) => entry.method === 'POST'), true);
  assert.equal(fx.calls.some((entry) => entry.method === 'DELETE'), true);
});

test('Cloudflare TXT adapter rejects proxying, control characters and oversized content before provider access', async () => {
  const fx = fixture();
  for (const value of [
    record({ proxied: true, ttl: 1 }),
    record({ content: 'bad\nvalue' }),
    record({ content: 'x'.repeat(4097) }),
  ]) {
    await assert.rejects(
      fx.manager.inspectRecord(inspectInput(value), { dnsCredential: credential() }),
      (error) => error instanceof CloudflareDnsManagerError,
    );
  }
  assert.deepEqual(fx.calls, []);
});
