import assert from 'node:assert/strict';
import test from 'node:test';
import { getDnsSecondaryStatus } from '../src/workspace/dns-client.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test('Secondary DNS client uses the domain-scoped read-only panel route', async (t) => {
  setSession({ csrfToken: 'csrf-secondary-dns' });
  t.after(() => setSession(null));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok({ status: 'synced', ready: true });
  });

  await getDnsSecondaryStatus('domain/one');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/panel/domains/domain%2Fone/dns/secondary');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers['x-csrf-token'], undefined);
});

test('Secondary DNS client rejects missing domain scope before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return ok({});
  });

  assert.throws(() => getDnsSecondaryStatus(''), /domainId is required/);
  assert.equal(calls, 0);
});
