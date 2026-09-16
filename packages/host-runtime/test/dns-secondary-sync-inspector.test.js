import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnsSecondarySyncInspector,
  DnsSecondarySyncInspectorError,
} from '../src/dns-secondary-sync-inspector.js';

function dig({ status = 'NOERROR', aa = true, serial = 2026091602, owner = 'example.com.' } = {}) {
  return [
    `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 1234`,
    `;; flags: qr ${aa ? 'aa ' : ''}rd; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0`,
    '',
    serial === null ? '' : `${owner} 300 IN SOA ns1.example.com. hostmaster.example.com. ${serial} 3600 900 1209600 300`,
    '',
  ].join('\n');
}

test('secondary DNS inspector reports all targets synced only at the exact primary serial', async () => {
  const calls = [];
  const inspector = createDnsSecondarySyncInspector({
    runDig: async (target, domain) => {
      calls.push([target, domain]);
      return { stdout: dig() };
    },
    now: () => Date.parse('2026-09-16T02:00:00.000Z'),
  });
  const result = await inspector.inspect({
    zoneName: 'Example.COM.',
    expectedSerial: 2026091602,
    targets: ['203.0.113.20', '2001:db8::20'],
  });
  assert.equal(result.status, 'synced');
  assert.equal(result.ready, true);
  assert.equal(result.checkedAt, '2026-09-16T02:00:00.000Z');
  assert.deepEqual(result.targets.map((entry) => entry.status), ['synced', 'synced']);
  assert.deepEqual(calls, [['2001:db8::20', 'example.com'], ['203.0.113.20', 'example.com']]);
});

test('secondary DNS inspector distinguishes stale and ahead serial drift', async () => {
  const inspector = createDnsSecondarySyncInspector({
    runDig: async (target) => ({ stdout: dig({ serial: target.endsWith('.20') ? 2026091601 : 2026091603 }) }),
  });
  const result = await inspector.inspect({
    zoneName: 'example.com',
    expectedSerial: 2026091602,
    targets: ['203.0.113.20', '203.0.113.21'],
  });
  assert.equal(result.status, 'drift');
  assert.equal(result.ready, false);
  assert.deepEqual(result.targets.map((entry) => [entry.target, entry.status]), [
    ['203.0.113.20', 'stale'],
    ['203.0.113.21', 'ahead'],
  ]);
});

test('secondary DNS inspector fails closed on timeout, non-authoritative reply and missing dig', async () => {
  const timeout = createDnsSecondarySyncInspector({
    runDig: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
  });
  const timeoutResult = await timeout.inspect({ zoneName: 'example.com', expectedSerial: 1, targets: ['203.0.113.20'] });
  assert.equal(timeoutResult.status, 'unverifiable');
  assert.equal(timeoutResult.targets[0].errorCode, 'ETIMEDOUT');

  const nonAa = createDnsSecondarySyncInspector({ runDig: async () => ({ stdout: dig({ aa: false, serial: 1 }) }) });
  const nonAaResult = await nonAa.inspect({ zoneName: 'example.com', expectedSerial: 1, targets: ['203.0.113.20'] });
  assert.equal(nonAaResult.targets[0].errorCode, 'DNS_NOT_AUTHORITATIVE');

  const missing = createDnsSecondarySyncInspector({
    runDig: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  await assert.rejects(
    missing.inspect({ zoneName: 'example.com', expectedSerial: 1, targets: ['203.0.113.20'] }),
    (error) => error instanceof DnsSecondarySyncInspectorError && error.code === 'dns_secondary_dig_missing',
  );
});

test('secondary DNS inspector treats an empty target list as explicitly disabled', async () => {
  const inspector = createDnsSecondarySyncInspector();
  const result = await inspector.inspect({ zoneName: 'example.com', expectedSerial: 5, targets: [] });
  assert.equal(result.status, 'disabled');
  assert.equal(result.ready, true);
  assert.deepEqual(result.targets, []);
});
