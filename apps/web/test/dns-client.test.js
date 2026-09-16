import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDnsReapply,
  applyDnssec,
  deleteManualDnsRecord,
  dnsClientInternals,
  getDnsZone,
  getDnsReapplyOperation,
  getDnssecOperation,
  previewDnsReapply,
  previewDnssec,
  saveManualDnsRecord,
} from '../src/workspace/dns-client.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });
const domainId = 'domain/one';

test('Domain DNS client uses scoped panel routes and exact mutation payloads', async (t) => {
  setSession({ csrfToken: 'csrf-dns' });
  t.after(() => setSession(null));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok({ id: 'op-1', status: 'succeeded' });
  });

  const record = { owner: '@', type: 'A', ttl: 300, values: ['203.0.113.10'], expectedSerial: 2026091601 };
  const deletion = { owner: '@', type: 'A', expectedSerial: 2026091602 };
  const reapply = { previewDigest: 'a'.repeat(64), confirmation: 'reapply-confirmation' };
  const dnssec = { targetEnabled: true, previewDigest: 'b'.repeat(64), confirmation: 'enable-confirmation' };

  await getDnsZone(domainId);
  await saveManualDnsRecord(domainId, record);
  await deleteManualDnsRecord(domainId, deletion);
  await previewDnsReapply(domainId);
  await applyDnsReapply(domainId, reapply);
  await previewDnssec(domainId, true);
  await applyDnssec(domainId, dnssec);
  await getDnsReapplyOperation(domainId, 'operation/1');
  await getDnssecOperation(domainId, 'operation/2');

  assert.deepEqual(calls.map((entry) => [entry.url, entry.options.method]), [
    ['/api/panel/domains/domain%2Fone/dns/zone', 'GET'],
    ['/api/panel/domains/domain%2Fone/dns/records', 'POST'],
    ['/api/panel/domains/domain%2Fone/dns/records/delete', 'POST'],
    ['/api/panel/domains/domain%2Fone/dns/reapply-preview', 'POST'],
    ['/api/panel/domains/domain%2Fone/dns/reapply', 'POST'],
    ['/api/panel/domains/domain%2Fone/dns/dnssec/preview', 'POST'],
    ['/api/panel/domains/domain%2Fone/dns/dnssec/apply', 'POST'],
    ['/api/panel/domains/domain%2Fone/dns/reapply-operations/operation%2F1', 'GET'],
    ['/api/panel/domains/domain%2Fone/dns/dnssec/operations/operation%2F2', 'GET'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), record);
  assert.deepEqual(JSON.parse(calls[2].options.body), deletion);
  assert.deepEqual(JSON.parse(calls[3].options.body), {});
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    previewDigest: reapply.previewDigest,
    confirmation: reapply.confirmation,
  });
  assert.deepEqual(JSON.parse(calls[5].options.body), { enabled: true });
  assert.deepEqual(JSON.parse(calls[6].options.body), {
    enabled: true,
    previewDigest: dnssec.previewDigest,
    confirmation: dnssec.confirmation,
  });
  for (const call of calls.filter((entry) => entry.options.method !== 'GET')) {
    assert.equal(call.options.headers['x-csrf-token'], 'csrf-dns');
  }
});

test('Domain DNS client rejects missing identities and unsupported operation kinds before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return ok({}); });
  assert.throws(() => getDnsZone(''), /domainId is required/);
  assert.throws(() => getDnsReapplyOperation('domain-1', ''), /operationId is required/);
  assert.throws(() => dnsClientInternals.operationPath('domain-1', 'other', 'operation-1'), /Unsupported DNS operation kind/);
  assert.equal(calls, 0);
});
