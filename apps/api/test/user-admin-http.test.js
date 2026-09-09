import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { fixture } from './helpers/user-admin-fixture.js';

// Actual HTTP boundary + real SQLite user store; session/password adapters are controlled.
async function serverFixture(t, hashPassword) {
  const f = fixture(t, hashPassword);
  let legacyCalls = 0;
  const auth = { users: f.store, mfa: f.options.mfa, getSession: f.getSession, configured: () => true };
  const listener = createAuthenticatedApi({
    store: auth, publicOrigin: 'https://panel.example',
    createHandler: () => (_req, res) => { legacyCalls += 1; res.writeHead(200); res.end('{"data":{}}'); },
  });
  const server = http.createServer(listener);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  async function call(path = '/api/users', { method = 'GET', token = f.token, origin = 'https://panel.example', csrf = 'test-csrf', body, raw, headers = {} } = {}) {
    const h = { ...headers };
    if (token !== null) h.cookie = `__Host-yunpanel_session=${token}`;
    if (origin !== null) h.origin = origin;
    if (csrf !== null) h['x-csrf-token'] = csrf;
    if (body !== undefined || raw !== undefined) h['content-type'] ??= 'application/json';
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  }
  return { ...f, call, legacyCalls: () => legacyCalls };
}
const account = { username: 'second', password: 'test-only-password', role: 'owner' };

test('both management prefixes require a session and reject public bootstrap bearer', async (t) => {
  const f = await serverFixture(t);
  for (const path of ['/api/users', '/api/panel/users']) {
    const result = await f.call(path, { token: null, headers: { authorization: 'Bearer bootstrap-does-not-work' } });
    assert.equal(result.status, 401); assert.equal(result.body.error.code, 'unauthorized');
  }
  assert.equal(f.legacyCalls(), 0);
});

test('Read Only and unenrolled Owners cannot read or mutate account management', async (t) => {
  const f = await serverFixture(t); f.seed('reader', 'read_only');
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const path = ['PATCH', 'DELETE'].includes(method) ? '/api/users/owner' : '/api/users';
    const result = await f.call(path, { token: 'session-reader', method, body: method === 'GET' ? undefined : account });
    assert.equal(result.status, 403); assert.equal(result.body.error.code, 'forbidden');
  }
  f.db.exec("DELETE FROM auth_mfa WHERE user_id = 'owner'");
  const result = await f.call('/api/panel/users');
  assert.equal(result.status, 403); assert.equal(result.body.error.code, 'mfa_enrollment_required');
  assert.equal(f.legacyCalls(), 0);
});

test('Origin and CSRF are required for every mutation', async (t) => {
  const f = await serverFixture(t);
  for (const [options, code] of [[{ origin: 'https://foreign.example' }, 'origin_forbidden'], [{ origin: null }, 'origin_forbidden'], [{ csrf: null }, 'csrf_invalid'], [{ csrf: 'wrong' }, 'csrf_invalid']]) {
    const result = await f.call('/api/users', { method: 'POST', body: account, ...options });
    assert.equal(result.status, 403); assert.equal(result.body.error.code, code);
  }
  assert.equal(f.store.list(f.token, f.policy).total, 1);
});

test('HTTP create, list, edit and delete use revisioned public responses', async (t) => {
  const f = await serverFixture(t);
  const created = await f.call('/api/panel/users', { method: 'POST', body: account });
  assert.equal(created.status, 201);
  const id = created.body.data.user.id;
  assert.equal(created.body.data.user.revision, 1);
  assert.equal(created.body.data.sessionRevoked, false);
  assert.equal(JSON.stringify(created.body).includes(account.password), false);
  const listed = await f.call('/api/users?limit=1&offset=1');
  assert.equal(listed.status, 200); assert.equal(listed.body.data.total, 2);
  assert.equal(listed.body.data.users[0].id, id);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  const edited = await f.call(`/api/users/${id}`, { method: 'PATCH', body: { revision: 1, active: false } });
  assert.equal(edited.status, 200); assert.equal(edited.body.data.user.revision, 2);
  const stale = await f.call(`/api/users/${id}`, { method: 'DELETE', body: { revision: 1 } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'user_revision_conflict');
  const deleted = await f.call(`/api/users/${id}`, { method: 'DELETE', body: { revision: 2 } });
  assert.equal(deleted.status, 200); assert.equal(deleted.body.data.deleted, true);
  assert.equal(f.legacyCalls(), 0);
});

test('last Owner remains protected through HTTP', async (t) => {
  const f = await serverFixture(t);
  for (const [method, body] of [['DELETE', { revision: 1 }], ['PATCH', { revision: 1, active: false }], ['PATCH', { revision: 1, role: 'read_only' }]]) {
    const result = await f.call('/api/users/owner', { method, body });
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'last_owner');
  }
});

test('self edit revokes the session without clearing a potentially newer cookie', async (t) => {
  const f = await serverFixture(t);
  const result = await f.call('/api/users/owner', { method: 'PATCH', body: { revision: 1, username: 'renamed-owner' } });
  assert.equal(result.status, 200); assert.equal(result.body.data.sessionRevoked, true);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal((await f.call('/api/users')).status, 401);
});

test('no self-service route or malformed account route reaches user administration', async (t) => {
  const f = await serverFixture(t);
  for (const path of ['/api/auth/users', '/api/users/', '/api/users/a%2Fb', '/api/users/owner/extra']) {
    assert.equal((await f.call(path)).status, 404);
  }
  const unsupported = await f.call('/api/users/owner');
  assert.equal(unsupported.status, 405); assert.equal(unsupported.headers.get('allow'), 'PATCH, DELETE');
  assert.equal(f.legacyCalls(), 0);
});

test('invalid pagination, malformed/oversize JSON and credential-field injection fail', async (t) => {
  const f = await serverFixture(t);
  for (const query of ['limit=-1', 'limit=101', 'offset=abc', 'limit=1&limit=2', 'limit=1e2', 'password=anything']) {
    assert.equal((await f.call(`/api/users?${query}`)).status, 400);
  }
  assert.equal((await f.call('/api/users', { method: 'POST', raw: '{broken' })).status, 400);
  assert.equal((await f.call('/api/users', { method: 'POST', raw: 'x'.repeat(17 * 1024) })).status, 413);
  assert.equal((await f.call('/api/users', { method: 'POST', body: { ...account, password_hash: 'injected' } })).status, 400);
  assert.equal((await f.call('/api/users', { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
});

test('Owner policy is checked again after asynchronous account creation hashing', async (t) => {
  let entered; let finish;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await serverFixture(t, () => new Promise((resolve) => { finish = resolve; entered(); }));
  const pending = f.call('/api/users', { method: 'POST', body: account });
  await started;
  f.db.exec("DELETE FROM auth_mfa WHERE user_id = 'owner'");
  finish('test-only-encoded-password');
  const result = await pending;
  assert.equal(result.status, 403); assert.equal(result.body.error.code, 'mfa_enrollment_required');
  assert.equal(f.db.prepare("SELECT 1 FROM users WHERE username = 'second'").get(), undefined);
});
