import assert from 'node:assert/strict';
import test from 'node:test';
import {
  controlManagedService,
  getManagedServices,
  inspectManagedServices,
  installManagedService,
} from '../src/api.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test('managed service API client uses same-origin panel routes and CSRF-protected mutations', async (t) => {
  setSession({ csrfToken: 'csrf-services' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(url.endsWith('/services') ? { services: [], snapshot: null } : { id: 'job-1', status: 'queued' });
  });

  assert.deepEqual(await getManagedServices('server/one'), { services: [], snapshot: null });
  await inspectManagedServices('server/one');
  await installManagedService('server/one', 'mariadb');
  await controlManagedService('server/one', 'nginx', 'restart');

  assert.deepEqual(calls.map((call) => call.url), [
    '/api/panel/servers/server%2Fone/services',
    '/api/panel/servers/server%2Fone/services/inspect',
    '/api/panel/servers/server%2Fone/services/mariadb/install',
    '/api/panel/servers/server%2Fone/services/nginx/control',
  ]);
  assert.equal(calls[0].options.method, 'GET');
  for (const call of calls.slice(1)) assert.equal(call.options.headers['x-csrf-token'], 'csrf-services');
  assert.deepEqual(JSON.parse(calls[2].options.body), { confirmation: 'install:mariadb' });
  assert.deepEqual(JSON.parse(calls[3].options.body), { action: 'restart', confirmation: 'control:nginx:restart' });
  setSession(null);
});

test('managed service API client rejects missing identities and unsupported actions before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return ok({}); });
  assert.throws(() => getManagedServices(''), /serverId is required/);
  assert.throws(() => installManagedService('server-1', ''), /serviceId is required/);
  assert.throws(() => controlManagedService('server-1', 'nginx', 'enable'), /Unsupported managed service action/);
  assert.equal(calls, 0);
});
