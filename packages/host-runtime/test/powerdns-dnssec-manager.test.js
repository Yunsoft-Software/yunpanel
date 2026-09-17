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

function key({
  id = 7,
  keytype = 'csk',
  active = true,
  published = true,
  algorithm = 'ECDSAP256SHA256',
  bits = 256,
} = {}) {
  const keyTag = id === 7 ? 12345 : 22345;
  return {
    type: 'Cryptokey',
    id,
    keytype,
    active,
    published,
    dnskey: `257 3 13 AAAATESTDNSKEY${id}`,
    ds: [`${keyTag} 13 2 aabbccdd`],
    cds: [`${keyTag} 13 2 AABBCCDD`],
    privatekey: 'Private-key-format: v1.2\nSECRET',
    algorithm,
    bits,
  };
}

function fixture({ dnssec = false, failMutationAfterApply = false, failKeyMutationAfterApply = null } = {}) {
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
    if (method === 'POST' && path.endsWith('/zones/example.com./cryptokeys')) {
      const body = JSON.parse(options.body);
      keys.push(key({
        id: 8,
        keytype: body.keytype,
        active: body.active,
        published: body.published,
        algorithm: body.algorithm,
        bits: body.bits,
      }));
      if (failKeyMutationAfterApply === 'create') throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      return response(201, structuredClone(keys.at(-1)));
    }
    if (method === 'PUT' && path.endsWith('/zones/example.com./cryptokeys/8')) {
      const body = JSON.parse(options.body);
      keys = keys.map((entry) => (entry.id === 8 ? { ...entry, active: body.active, published: body.published } : entry));
      if (failKeyMutationAfterApply === 'update') throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      return response(204);
    }
    if (method === 'DELETE' && path.endsWith('/zones/example.com./cryptokeys/7')) {
      keys = keys.filter((entry) => entry.id !== 7);
      if (failKeyMutationAfterApply === 'delete') throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      return response(204);
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
  assert.match(state.keySetDigest, /^[a-f0-9]{64}$/);
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

test('creates a revision-bound rollover key without accepting or returning private material', async () => {
  const { calls, manager } = fixture({ dnssec: true });
  const baseline = await manager.inspect({ zoneName: 'example.com', apiKey });
  const result = await manager.createRolloverKey({
    zoneName: 'example.com',
    apiKey,
    expectedKeySetDigest: baseline.keySetDigest,
    expectedKeyIds: baseline.keys.map((entry) => entry.id),
    keyType: 'csk',
    algorithm: 'ECDSAP256SHA256',
    bits: 256,
    active: false,
    published: false,
  });

  assert.equal(result.changed, true);
  assert.equal(result.createdKey.id, 8);
  assert.equal(result.createdKey.active, false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  const createCall = calls.find((entry) => entry.method === 'POST' && entry.path.endsWith('/cryptokeys'));
  assert.deepEqual(createCall.body, {
    keytype: 'CSK',
    active: false,
    published: false,
    algorithm: 'ECDSAP256SHA256',
    bits: 256,
  });
  assert.equal(Object.hasOwn(createCall.body, 'content'), false);
  assert.equal(Object.hasOwn(createCall.body, 'privatekey'), false);
});

test('reconciles an uncertain rollover key creation without generating a duplicate key', async () => {
  const { calls, manager } = fixture({ dnssec: true, failKeyMutationAfterApply: 'create' });
  const baseline = await manager.inspect({ zoneName: 'example.com', apiKey });
  const input = {
    zoneName: 'example.com',
    apiKey,
    expectedKeySetDigest: baseline.keySetDigest,
    expectedKeyIds: [7],
    keyType: 'csk',
    algorithm: 'ECDSAP256SHA256',
    bits: 256,
    active: false,
    published: false,
  };

  const first = await manager.createRolloverKey(input);
  const retried = await manager.createRolloverKey(input);

  assert.equal(first.changed, true);
  assert.equal(retried.changed, false);
  assert.equal(retried.createdKey.id, 8);
  assert.equal(calls.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/cryptokeys')).length, 1);
});

test('rejects rollover key creation when the inspected key set changed after preview', async () => {
  const { calls, manager } = fixture({ dnssec: true });
  await assert.rejects(
    manager.createRolloverKey({
      zoneName: 'example.com',
      apiKey,
      expectedKeySetDigest: '0'.repeat(64),
      expectedKeyIds: [7],
      keyType: 'csk',
      algorithm: 'ECDSAP256SHA256',
      bits: 256,
      active: false,
      published: false,
    }),
    (error) => error instanceof PowerDnsDnssecManagerError && error.code === 'powerdns_dnssec_key_set_changed',
  );
  assert.equal(calls.some((entry) => entry.method === 'POST'), false);
});

test('updates rollover key publication state against exact before and after digests', async () => {
  const { calls, manager } = fixture({ dnssec: true, failKeyMutationAfterApply: 'update' });
  const baseline = await manager.inspect({ zoneName: 'example.com', apiKey });
  const created = await manager.createRolloverKey({
    zoneName: 'example.com', apiKey,
    expectedKeySetDigest: baseline.keySetDigest,
    expectedKeyIds: [7],
    keyType: 'csk', algorithm: 'ECDSAP256SHA256', bits: 256,
    active: false, published: false,
  });
  const statePreview = await manager.previewRolloverKeyState({
    zoneName: 'example.com', apiKey, keyId: 8, active: true, published: true,
  });
  const targetDigest = statePreview.targetKeySetDigest;
  assert.equal(statePreview.keySetDigest, created.keySetDigest);
  assert.equal(statePreview.targetKey.active, true);
  assert.equal(calls.some((entry) => entry.path.endsWith('/cryptokeys/8')), false);
  const input = {
    zoneName: 'example.com', apiKey, keyId: 8,
    expectedKeySetDigest: created.keySetDigest,
    expectedTargetKeySetDigest: targetDigest,
    expectedActive: false, expectedPublished: false,
    active: true, published: true,
  };
  const result = await manager.setRolloverKeyState(input);
  const retried = await manager.setRolloverKeyState(input);

  assert.equal(result.changed, true);
  assert.equal(retried.changed, false);
  assert.equal(result.updatedKey.active, true);
  assert.equal(result.updatedKey.published, true);
  assert.equal(result.keySetDigest, targetDigest);
  assert.equal(calls.some((entry) => entry.method === 'PUT' && entry.path.endsWith('/cryptokeys/8')
    && entry.body?.active === true && entry.body?.published === true), true);
  assert.equal(calls.filter((entry) => entry.method === 'PUT' && entry.path.endsWith('/cryptokeys/8')).length, 1);
});

test('deletes only an exact old key while another active published key preserves signing continuity', async () => {
  const { calls, manager } = fixture({ dnssec: true, failKeyMutationAfterApply: 'delete' });
  const baseline = await manager.inspect({ zoneName: 'example.com', apiKey });
  const created = await manager.createRolloverKey({
    zoneName: 'example.com', apiKey,
    expectedKeySetDigest: baseline.keySetDigest,
    expectedKeyIds: [7],
    keyType: 'csk', algorithm: 'ECDSAP256SHA256', bits: 256,
    active: true, published: true,
  });
  const deletionPreview = await manager.previewRolloverKeyDeletion({
    zoneName: 'example.com', apiKey, keyId: 7,
  });
  const remainingDigest = deletionPreview.remainingKeySetDigest;
  assert.equal(deletionPreview.keySetDigest, created.keySetDigest);
  assert.equal(deletionPreview.deletedKey.id, 7);
  assert.equal(calls.some((entry) => entry.method === 'DELETE'), false);
  const input = {
    zoneName: 'example.com', apiKey, keyId: 7,
    expectedKeySetDigest: created.keySetDigest,
    expectedRemainingKeySetDigest: remainingDigest,
  };
  const result = await manager.deleteRolloverKey(input);
  const retried = await manager.deleteRolloverKey(input);

  assert.equal(result.changed, true);
  assert.equal(retried.changed, false);
  assert.deepEqual(result.keys.map((entry) => entry.id), [8]);
  assert.equal(result.keySetDigest, remainingDigest);
  assert.equal(calls.filter((entry) => entry.method === 'DELETE' && entry.path.endsWith('/cryptokeys/7')).length, 1);
});

test('refuses to delete the only active published DNSSEC key', async () => {
  const { calls, manager } = fixture({ dnssec: true });
  const baseline = await manager.inspect({ zoneName: 'example.com', apiKey });
  const emptyDigest = powerDnsDnssecManagerInternals.keySetDigest([]);
  await assert.rejects(
    manager.previewRolloverKeyDeletion({ zoneName: 'example.com', apiKey, keyId: 7 }),
    (error) => error instanceof PowerDnsDnssecManagerError && error.code === 'powerdns_dnssec_key_delete_unsafe',
  );
  await assert.rejects(
    manager.deleteRolloverKey({
      zoneName: 'example.com', apiKey, keyId: 7,
      expectedKeySetDigest: baseline.keySetDigest,
      expectedRemainingKeySetDigest: emptyDigest,
    }),
    (error) => error instanceof PowerDnsDnssecManagerError && error.code === 'powerdns_dnssec_key_delete_unsafe',
  );
  assert.equal(calls.some((entry) => entry.method === 'DELETE'), false);
});
