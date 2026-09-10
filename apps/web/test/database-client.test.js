import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDatabase,
  deleteDatabase,
  getDatabases,
  inspectDatabases,
} from '../src/api.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test('database API client uses same-origin panel routes and exact mutation confirmations', async (t) => {
  setSession({ csrfToken: 'csrf-database' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(url.endsWith('/databases') && options.method === 'GET'
      ? { engine: null, version: null, databases: null, snapshot: null }
      : { id: 'job-1', status: 'queued' });
  });

  await getDatabases('server/one');
  await inspectDatabases('server/one');
  await createDatabase('server/one', 'app_main');
  await deleteDatabase('server/one', 'app_main');

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/panel/servers/server%2Fone/databases', 'GET'],
    ['/api/panel/servers/server%2Fone/databases/inspect', 'POST'],
    ['/api/panel/servers/server%2Fone/databases', 'POST'],
    ['/api/panel/servers/server%2Fone/databases/app_main', 'DELETE'],
  ]);
  assert.deepEqual(JSON.parse(calls[2].options.body), { name: 'app_main', confirmation: 'create:app_main' });
  assert.deepEqual(JSON.parse(calls[3].options.body), { confirmation: 'delete:app_main' });
  for (const call of calls.slice(1)) assert.equal(call.options.headers['x-csrf-token'], 'csrf-database');
  setSession(null);
});

test('database API client rejects missing identities before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return ok({}); });
  assert.throws(() => getDatabases(''), /serverId is required/);
  assert.throws(() => createDatabase('server-1', ''), /database name is required/);
  assert.throws(() => deleteDatabase('server-1', ''), /database name is required/);
  assert.equal(calls, 0);
});
