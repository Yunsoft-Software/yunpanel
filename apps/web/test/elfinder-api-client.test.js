import assert from 'node:assert/strict';
import test from 'node:test';
import { createElFinderHandoff } from '../src/api.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test('elFinder handoff API uses exact same-origin Owner route with empty mutation body', async (t) => {
  setSession({ csrfToken: 'csrf-elfinder' });
  const calls = [];
  const handoff = {
    capability: 'E'.repeat(43),
    expiresAt: 50_000,
    protocol: 'yunpanel-elfinder-handoff-v1',
    audience: 'elfinder',
    target: {
      serverId: 'server/one',
      websiteId: 'website/one',
    },
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(handoff);
  });

  const result = await createElFinderHandoff('server/one', 'website/one');

  assert.deepEqual(result, handoff);
  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/panel/servers/server%2Fone/websites/website%2Fone/elfinder-handoffs', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.equal(calls[0].options.headers['x-csrf-token'], 'csrf-elfinder');
  assert.doesNotMatch(calls[0].options.body, /root|path|unixUser|applicationId|capability/i);
  setSession(null);
});

test('elFinder handoff API rejects missing identities before fetch', () => {
  assert.throws(() => createElFinderHandoff('', 'website-1'), /serverId is required/);
  assert.throws(() => createElFinderHandoff('server-1', ''), /websiteId is required/);
});
