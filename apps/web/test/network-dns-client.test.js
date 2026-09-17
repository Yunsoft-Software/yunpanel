import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPowerDnsAuthoritative,
  applyServerDnsIdentity,
  getPowerDnsAuthoritative,
  getServerDnsIdentity,
  inspectDnsDelegation,
  previewPowerDnsAuthoritative,
  previewServerDnsIdentity,
  resolvePowerDnsRecovery,
  retryPowerDnsRecovery,
} from '../src/workspace/network-dns-client.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test('Network DNS client uses local-server scoped routes and exact preview confirmations', async (t) => {
  setSession({ csrfToken: 'csrf-network-dns' });
  t.after(() => setSession(null));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return ok({}); });
  const settings = { publicIpv4: '203.0.113.10' };
  const identityPreview = { currentRevision: 2, settings, previewDigest: 'a'.repeat(64), confirmation: 'identity-confirm' };
  const authoritativePreview = { previewDigest: 'b'.repeat(64), confirmation: 'pdns-confirm' };

  await getServerDnsIdentity('server/one');
  await previewServerDnsIdentity('server/one', settings);
  await applyServerDnsIdentity('server/one', identityPreview);
  await getPowerDnsAuthoritative('server/one');
  await previewPowerDnsAuthoritative('server/one');
  await applyPowerDnsAuthoritative('server/one', authoritativePreview);
  await resolvePowerDnsRecovery('server/one', {
    id: 'operation-1',
    updatedAt: '2026-09-17T12:01:00.000Z',
    recovery: { required: true, confirmation: 'recovery-confirm' },
  });
  await retryPowerDnsRecovery('server/one', {
    id: 'operation-1',
    updatedAt: '2026-09-17T12:01:00.000Z',
    recovery: { required: true, retryConfirmation: 'retry-confirm' },
  });
  await inspectDnsDelegation('server/one', 'example.com');

  assert.deepEqual(calls.map((entry) => [entry.url, entry.options.method]), [
    ['/api/panel/servers/server%2Fone/dns/identity', 'GET'],
    ['/api/panel/servers/server%2Fone/dns/identity/preview', 'POST'],
    ['/api/panel/servers/server%2Fone/dns/identity/apply', 'POST'],
    ['/api/panel/servers/server%2Fone/dns/authoritative', 'GET'],
    ['/api/panel/servers/server%2Fone/dns/authoritative/preview', 'POST'],
    ['/api/panel/servers/server%2Fone/dns/authoritative/apply', 'POST'],
    ['/api/panel/servers/server%2Fone/dns/authoritative/recovery/resolve', 'POST'],
    ['/api/panel/servers/server%2Fone/dns/authoritative/recovery/retry', 'POST'],
    ['/api/panel/servers/server%2Fone/dns/delegation?domain=example.com', 'GET'],
  ]);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    expectedRevision: 2, settings, previewDigest: identityPreview.previewDigest, confirmation: identityPreview.confirmation,
  });
  assert.deepEqual(JSON.parse(calls[5].options.body), authoritativePreview);
  assert.deepEqual(JSON.parse(calls[6].options.body), {
    operationId: 'operation-1',
    expectedUpdatedAt: '2026-09-17T12:01:00.000Z',
    confirmation: 'recovery-confirm',
  });
  assert.deepEqual(JSON.parse(calls[7].options.body), {
    operationId: 'operation-1',
    expectedUpdatedAt: '2026-09-17T12:01:00.000Z',
    confirmation: 'retry-confirm',
  });
});

test('Network DNS client rejects missing server or delegation identity before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return ok({}); });
  assert.throws(() => getServerDnsIdentity(''), /serverId is required/);
  assert.throws(() => inspectDnsDelegation('server-1', ''), /Delegation domain is required/);
  assert.equal(calls, 0);
});
