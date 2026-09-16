import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPowerDnsDnssecManager,
  PowerDnsDnssecManagerError,
  powerDnsDnssecManagerInternals,
} from '../src/powerdns-dnssec-manager.js';

const apiKey = 'a'.repeat(43);

function response(status, payload = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  };
}

function key() {
  return {
    type: 'Cryptokey',
    id: 7,
    keytype: 'csk',
    active: true,
    published: true,
    dnskey: '257 3 13 AAAATESTDNSKEY',
    ds: ['12345 13 2 aabbccdd'],
    cds: ['12345 13 2 AABBCCDD'],
    privatekey: 'Private-key-format: v1.2\nSECRET',
    algorithm: 'ECDSAP256SHA256',
    bits: 256,
  };
}

function fixture({ dnssec = false, failMutationAfterApply = false } = {}) {
  const calls = [];
  let enabled = dnssec;
  let keys = enabled ? [key()] : [];
  const zoneManager = {
    getZone: async () => ({
      zoneName: 'example.com',
      id: 'example.com.',
      kind: 'Native',
      dnssec: enabled,
      serial: 2026091601,
      rrsets: [],
    }),
  };
  const fetchFn = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const path = decodeURIComponent(new URL(url).pathname);
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET' && path.endsWith('/zones/example.com./cryptokeys')) {
      return response(200, structuredClone(keys));
    }
    if (method === 'PUT' && path.endsWith('/zones/example.com.')) {
      const body = JSON.parse(options.body);
      enabled = body.dnssec === true;
      keys = enabled ? [key()] : [];
      if (failMutationAfterApply) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      return response(204);
    }
    if (method === 'PUT' && path.endsWith('/zones/example.com./rectify')) return response(200, 'Rectified');
    return response(500, { error: 'unexpected request' });
  };
  return {
    calls,
    manager: createPowerDnsDnssecManager({ fetchFn, zoneManager }),
    state: () => ({ enabled, keys: structuredClone(keys) }),
  };
}

test('normalizes DS records and never exposes PowerDNS private key material', async () => {
  const normalized = powerDnsDnssecManagerInternals.normalizeDs('12345 13 2 aabbccdd');
  assert.equal(normalized, '12345 13 2 AABBCCDD');

  const { manager } = fixture({ dnssec: true });
  const state = await manager.inspect({ zoneName: 'example.com', apiKey });
  assert.equal(state.ready, true);
  assert.deepEqual(state.ds, ['12345 13 2 AABBCCDD']);
  assert.equal(state.keys[0].keyType, 'csk');
  assert.equal(JSON.stringify(state).includes('SECRET'), false);
  assert.equal(Object.hasOwn(state.keys[0], 'privatekey'), false);
});

test('enables DNSSEC, rectifies the zone and verifies generated DS output', async () => {
  const { calls, manager, state } = fixture();
  const result = await manager.enable({ zoneName: 'example.com', apiKey });

  assert.equal(result.changed, true);
  assert.equal(result.dnssec, true);
  assert.equal(result.ready, true);
  assert.deepEqual(result.ds, ['12345 13 2 AABBCCDD']);
  assert.equal(state().enabled, true);
  assert.equal(calls.some((entry) => entry.method === 'PUT' && entry.path.endsWith('/zones/example.com.')
    && entry.body?.dnssec === true && entry.body?.api_rectify === true), true);
  assert.equal(calls.some((entry) => entry.method === 'PUT' && entry.path.endsWith('/zones/example.com./rectify')), true);
});

test('DNSSEC enable is idempotent when the zone is already signed and has DS material', async () => {
  const { calls, manager } = fixture({ dnssec: true });
  const result = await manager.enable({ zoneName: 'example.com', apiKey });

  assert.equal(result.changed, false);
  assert.equal(result.ready, true);
  assert.equal(calls.some((entry) => entry.method === 'PUT'), false);
});

test('disables DNSSEC and verifies the authoritative zone is no longer signed', async () => {
  const { calls, manager, state } = fixture({ dnssec: true });
  const result = await manager.disable({ zoneName: 'example.com', apiKey });

  assert.equal(result.changed, true);
  assert.equal(result.dnssec, false);
  assert.equal(result.ready, false);
  assert.equal(state().enabled, false);
  assert.equal(calls.some((entry) => entry.method === 'PUT' && entry.body?.dnssec === false), true);
});

test('reconciles an uncertain enable mutation by inspecting the provider post-condition', async () => {
  const { calls, manager } = fixture({ failMutationAfterApply: true });
  const result = await manager.enable({ zoneName: 'example.com', apiKey });

  assert.equal(result.dnssec, true);
  assert.equal(result.ready, true);
  assert.equal(calls.filter((entry) => entry.method === 'PUT' && entry.path.endsWith('/zones/example.com.')).length, 1);
});

test('rejects invalid DS state instead of publishing malformed registrar material', () => {
  assert.throws(
    () => powerDnsDnssecManagerInternals.normalizeDs('99999 13 2 AABB'),
    (error) => error instanceof PowerDnsDnssecManagerError && error.code === 'powerdns_dnssec_key_state_invalid',
  );
});
