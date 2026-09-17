import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnssecKeyPropagationInspector,
  DnssecKeyPropagationInspectorError,
  dnssecKeyPropagationInspectorInternals,
} from '../src/dnssec-key-propagation-inspector.js';

const key = '257 3 13 AAAANEWKEYVALUE==';

function answer({ type, status = 'NOERROR', aa = true, serial = 2026091702, keys = [key], ttl = 300 } = {}) {
  const rows = type === 'SOA'
    ? [`example.com. 300 IN SOA ns1.example.com. hostmaster.example.com. ${serial} 3600 900 1209600 300`]
    : keys.map((record) => `example.com. ${ttl} IN DNSKEY ${record}`);
  return [
    `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 1234`,
    `;; flags: qr ${aa ? 'aa ' : ''}rd; QUERY: 1, ANSWER: ${rows.length}, AUTHORITY: 0, ADDITIONAL: 0`,
    '',
    ...rows,
    '',
  ].join('\n');
}

function runner(overrides = {}) {
  const calls = [];
  return {
    calls,
    runDig: async (target, domain, type) => {
      calls.push([target, domain, type]);
      const value = overrides[`${target}:${type}`];
      if (value instanceof Error) throw value;
      return { stdout: value ?? answer({ type }) };
    },
  };
}

test('DNSSEC propagation requires the exact publication serial and key on primary and every secondary', async () => {
  const runtime = runner();
  const inspector = createDnssecKeyPropagationInspector({
    runDig: runtime.runDig,
    now: () => Date.parse('2026-09-17T10:10:00.000Z'),
  });
  const result = await inspector.inspect({
    zoneName: 'Example.COM.',
    expectedSerial: 2026091702,
    expectedDnskey: key,
    publishedAt: '2026-09-17T10:00:00.000Z',
    primaryTarget: '203.0.113.20',
    secondaryTargets: ['203.0.113.21'],
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.ready, true);
  assert.equal(result.dnskeyTtl, 300);
  assert.equal(result.eligibleAfter, '2026-09-17T10:05:00.000Z');
  assert.deepEqual(result.targets.map((entry) => [entry.role, entry.status]), [
    ['primary', 'synced'],
    ['secondary', 'synced'],
  ]);
  assert.equal(runtime.calls.length, 4);
});

test('DNSSEC propagation waits a full observed DNSKEY TTL after the journaled publication boundary', async () => {
  const inspector = createDnssecKeyPropagationInspector({
    runDig: runner().runDig,
    now: () => Date.parse('2026-09-17T10:04:59.000Z'),
  });
  const result = await inspector.inspect({
    zoneName: 'example.com',
    expectedSerial: 2026091702,
    expectedDnskey: key,
    publishedAt: '2026-09-17T10:00:00.000Z',
    primaryTarget: '203.0.113.20',
    secondaryTargets: [],
  });

  assert.equal(result.status, 'waiting_ttl');
  assert.equal(result.ready, false);
  assert.equal(result.eligibleAfter, '2026-09-17T10:05:00.000Z');
});

test('DNSSEC propagation with no secondary is ready only after primary evidence and labels redundancy disabled', async () => {
  const inspector = createDnssecKeyPropagationInspector({
    runDig: runner().runDig,
    now: () => Date.parse('2026-09-17T10:05:00.000Z'),
  });
  const result = await inspector.inspect({
    zoneName: 'example.com',
    expectedSerial: 2026091702,
    expectedDnskey: key,
    publishedAt: '2026-09-17T10:00:00.000Z',
    primaryTarget: '203.0.113.20',
    secondaryTargets: [],
  });

  assert.equal(result.status, 'disabled');
  assert.equal(result.ready, true);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].role, 'primary');
});

test('DNSSEC propagation fails closed for serial drift, missing key and unverifiable authority', async () => {
  const runtime = runner({
    '203.0.113.20:SOA': answer({ type: 'SOA', serial: 2026091703 }),
    '203.0.113.21:DNSKEY': answer({ type: 'DNSKEY', keys: [] }),
    '203.0.113.22:DNSKEY': answer({ type: 'DNSKEY', aa: false }),
  });
  const inspector = createDnssecKeyPropagationInspector({ runDig: runtime.runDig });
  const result = await inspector.inspect({
    zoneName: 'example.com',
    expectedSerial: 2026091702,
    expectedDnskey: key,
    publishedAt: '2026-09-17T10:00:00.000Z',
    primaryTarget: '203.0.113.20',
    secondaryTargets: ['203.0.113.21', '203.0.113.22'],
  });

  assert.equal(result.status, 'unverifiable');
  assert.equal(result.ready, false);
  assert.equal(result.dnskeyTtl, null);
  assert.deepEqual(result.targets.map((entry) => entry.status), ['serial_drift', 'key_missing', 'unverifiable']);
  assert.equal(result.targets[2].errorCode, 'DNS_NOT_AUTHORITATIVE');
});

test('DNSSEC propagation rejects malformed input and reports missing dig without leaking process errors', async () => {
  const inspector = createDnssecKeyPropagationInspector();
  await assert.rejects(
    inspector.inspect({
      zoneName: 'example.com',
      expectedSerial: 1,
      expectedDnskey: 'invalid',
      publishedAt: '2026-09-17T10:00:00.000Z',
      primaryTarget: '203.0.113.20',
      secondaryTargets: [],
    }),
    (error) => error instanceof DnssecKeyPropagationInspectorError
      && error.code === 'dnssec_propagation_key_invalid',
  );

  const missing = createDnssecKeyPropagationInspector({
    runDig: async () => { throw Object.assign(new Error('private process detail'), { code: 'ENOENT' }); },
  });
  await assert.rejects(
    missing.inspect({
      zoneName: 'example.com',
      expectedSerial: 1,
      expectedDnskey: key,
      publishedAt: '2026-09-17T10:00:00.000Z',
      primaryTarget: '203.0.113.20',
      secondaryTargets: [],
    }),
    (error) => error instanceof DnssecKeyPropagationInspectorError
      && error.code === 'dnssec_propagation_dig_missing'
      && !error.message.includes('private'),
  );
  assert.equal(dnssecKeyPropagationInspectorInternals.safeErrorCode({ code: 'hostile code!' }), 'DIG_FAILED');
});
