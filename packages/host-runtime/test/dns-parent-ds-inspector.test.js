import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnsParentDsInspector,
  DnsParentDsInspectorError,
  dnsParentDsInspectorInternals,
} from '../src/dns-parent-ds-inspector.js';

function dig(status, answers = [], { authoritative = false } = {}) {
  return [
    `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 1234`,
    `;; flags: qr${authoritative ? ' aa' : ''} rd ra; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: 0, ADDITIONAL: 1`,
    '',
    ...answers,
    '',
  ].join('\n');
}

function discovery() {
  return dig('NOERROR', [
    'com. 172800 IN NS a.gtld-servers.net.',
    'com. 172800 IN NS b.gtld-servers.net.',
  ]);
}

function runner(observations = {}) {
  const calls = [];
  const runDig = async (args) => {
    calls.push(args);
    const server = args.find((entry) => entry.startsWith('@'))?.slice(1) ?? null;
    if (!server) return { stdout: discovery() };
    const value = observations[server];
    if (value instanceof Error) throw value;
    if (typeof value === 'string') return { stdout: value };
    return { stdout: dig('NOERROR', [], { authoritative: true }) };
  };
  return { calls, runDig };
}

test('parent DS inspector returns canonical DS if any parent authoritative nameserver publishes it', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  const runtime = runner({
    'a.gtld-servers.net': dig('NOERROR', [
      'example.com. 3600 IN DS 12345 13 2 aabbccdd',
      'example.com. 3600 IN DS 12345 13 2 AABBCCDD',
    ], { authoritative: true }),
    'b.gtld-servers.net': timeout,
  });
  const inspector = createDnsParentDsInspector({
    runDig: runtime.runDig,
    now: () => Date.parse('2026-09-16T00:30:00.000Z'),
  });
  const result = await inspector.inspect({ domain: 'Example.COM.' });

  assert.equal(result.version, 2);
  assert.equal(result.domain, 'example.com');
  assert.equal(result.status, 'present');
  assert.deepEqual(result.records, ['12345 13 2 AABBCCDD']);
  assert.deepEqual(result.nameservers, ['a.gtld-servers.net', 'b.gtld-servers.net']);
  assert.equal(result.errorCode, null);
  assert.equal(result.checkedAt, '2026-09-16T00:30:00.000Z');
  assert.equal(runtime.calls.some((args) => args.includes('+norecurse') && args.includes('@a.gtld-servers.net')), true);
});

test('parent DS inspector reports absent only when every discovered parent NS authoritatively reports no DS', async () => {
  const runtime = runner();
  const inspector = createDnsParentDsInspector({ runDig: runtime.runDig });
  const result = await inspector.inspect({ domain: 'example.com' });

  assert.equal(result.status, 'absent');
  assert.deepEqual(result.records, []);
  assert.equal(result.errorCode, null);
  assert.equal(runtime.calls.filter((args) => args.includes('+norecurse')).length, 2);
});

test('parent DS inspector keeps absence unverifiable if any parent NS times out or is non-authoritative', async () => {
  const timeoutRuntime = runner({
    'b.gtld-servers.net': Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
  });
  const timeout = createDnsParentDsInspector({ runDig: timeoutRuntime.runDig });
  const timeoutResult = await timeout.inspect({ domain: 'example.com' });
  assert.equal(timeoutResult.status, 'unverifiable');
  assert.equal(timeoutResult.errorCode, 'PARENT_NS_ETIMEDOUT');

  const nonAuthoritativeRuntime = runner({
    'b.gtld-servers.net': dig('NOERROR'),
  });
  const nonAuthoritative = createDnsParentDsInspector({ runDig: nonAuthoritativeRuntime.runDig });
  const nonAuthoritativeResult = await nonAuthoritative.inspect({ domain: 'example.com' });
  assert.equal(nonAuthoritativeResult.status, 'unverifiable');
  assert.equal(nonAuthoritativeResult.errorCode, 'PARENT_NS_PARENT_NOT_AUTHORITATIVE');
});

test('parent nameserver discovery failure remains unverifiable and missing dig fails closed', async () => {
  const servfail = createDnsParentDsInspector({
    runDig: async () => ({ stdout: dig('SERVFAIL') }),
  });
  const servfailResult = await servfail.inspect({ domain: 'example.com' });
  assert.equal(servfailResult.status, 'unverifiable');
  assert.equal(servfailResult.errorCode, 'DNS_SERVFAIL');

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

test('parent DS parsers ignore unrelated and malformed answer rows', () => {
  const stdout = dig('NOERROR', [
    'other.example. 300 IN DS 12345 13 2 AABBCCDD',
    'example.com. 300 IN A 203.0.113.10',
    'example.com. 300 IN DS 99999 13 2 AABB',
    'example.com. 300 IN DS 12345 13 2 AABB',
  ], { authoritative: true });
  assert.deepEqual(
    dnsParentDsInspectorInternals.parseDsAnswers(stdout, 'example.com'),
    ['12345 13 2 AABB'],
  );
  assert.equal(dnsParentDsInspectorInternals.authoritativeAnswer(stdout), true);
  assert.equal(dnsParentDsInspectorInternals.parentName('foo.example.com'), 'example.com');
});
