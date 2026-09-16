import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnsParentDsInspector,
  DnsParentDsInspectorError,
  dnsParentDsInspectorInternals,
} from '../src/dns-parent-ds-inspector.js';

function dig(status, answers = []) {
  return [
    `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 1234`,
    ';; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1',
    '',
    ...answers,
    '',
  ].join('\n');
}

test('parent DS inspector returns canonical published DS records', async () => {
  const inspector = createDnsParentDsInspector({
    runDig: async () => ({
      stdout: dig('NOERROR', [
        'example.com. 3600 IN DS 12345 13 2 aabbccdd',
        'example.com. 3600 IN DS 12345 13 2 AABBCCDD',
      ]),
    }),
    now: () => Date.parse('2026-09-16T00:30:00.000Z'),
  });
  const result = await inspector.inspect({ domain: 'Example.COM.' });

  assert.equal(result.domain, 'example.com');
  assert.equal(result.status, 'present');
  assert.deepEqual(result.records, ['12345 13 2 AABBCCDD']);
  assert.equal(result.errorCode, null);
  assert.equal(result.checkedAt, '2026-09-16T00:30:00.000Z');
});

test('parent DS inspector distinguishes an authoritative no-DS answer from lookup failure', async () => {
  const absent = createDnsParentDsInspector({ runDig: async () => ({ stdout: dig('NOERROR') }) });
  const absentResult = await absent.inspect({ domain: 'example.com' });
  assert.equal(absentResult.status, 'absent');
  assert.deepEqual(absentResult.records, []);

  const servfail = createDnsParentDsInspector({ runDig: async () => ({ stdout: dig('SERVFAIL') }) });
  const servfailResult = await servfail.inspect({ domain: 'example.com' });
  assert.equal(servfailResult.status, 'unverifiable');
  assert.equal(servfailResult.errorCode, 'DNS_SERVFAIL');
});

test('parent DS inspector fails closed on dig timeout and missing binary', async () => {
  const timeout = createDnsParentDsInspector({
    runDig: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
  });
  const timeoutResult = await timeout.inspect({ domain: 'example.com' });
  assert.equal(timeoutResult.status, 'unverifiable');
  assert.equal(timeoutResult.errorCode, 'ETIMEDOUT');

  const missing = createDnsParentDsInspector({
    runDig: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  await assert.rejects(
    missing.inspect({ domain: 'example.com' }),
    (error) => error instanceof DnsParentDsInspectorError && error.code === 'dns_parent_ds_dig_missing',
  );
});

test('parent DS parser ignores unrelated and malformed answer rows', () => {
  const stdout = dig('NOERROR', [
    'other.example. 300 IN DS 12345 13 2 AABBCCDD',
    'example.com. 300 IN A 203.0.113.10',
    'example.com. 300 IN DS 99999 13 2 AABB',
    'example.com. 300 IN DS 12345 13 2 AABB',
  ]);
  assert.deepEqual(
    dnsParentDsInspectorInternals.parseDsAnswers(stdout, 'example.com'),
    ['12345 13 2 AABB'],
  );
});
