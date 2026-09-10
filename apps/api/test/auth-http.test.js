import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createAuthenticatedApi } from '../src/auth-http.js';

const origin = 'https://panel.example.test';
const cookie = '__Host-yunpanel_session=valid-session';
const csrfToken = 'test-csrf-value';
const proxyToken = 'p'.repeat(43);
function fakeStore() {
  let active = true;
  const session = { id: '12345678-1234-1234-1234-123456789012', user: { id: 'owner-id', username: 'admin', role: 'owner' }, csrfToken };
  return {
    configured: () => true,
    mfa: { enabled: () => true },
    getSession: (token) => active && token === 'valid-session' ? session : null,
    login: async () => ({ token: 'valid-session', session }),
    completeSetup: async () => session.user,
    listSessions: () => [{ id: session.id, current: true }],
    revokeSession: () => { active = false; },
    revokeAll: () => { active = false; },
    changePassword: async () => { active = false; },
    audit: { record() {}, list() { return { events: [], total: 0, offset: 0, limit: 50 }; } },
  };
}
async function fixture(t, options = {}) {
  let calls = 0;
  const listener = createAuthenticatedApi({
    store: options.store ?? fakeStore(), publicOrigin: origin,
    proxyToken: options.proxyToken,
    trustedProxyIps: options.trustedProxyIps,
    createHandler: () => (request, response) => {
      calls += 1;
      const agent = /heartbeat|commands/.test(request.url);
      const authorized = agent
        ? request.headers.authorization === 'Bearer transport-token'
        : Boolean(request.auth?.user);
      response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: {
        path: request.url,
        actor: request.auth?.user.id ?? null,
        authorization: request.headers.authorization ?? null,
      } }));
    },
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return {
    calls: () => calls,
    request: (pathname, { method = 'GET', headers = {}, body } = {}) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
  };
}
const mutationHeaders = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken };

test('all management paths reject anonymous and bootstrap-bearer requests before the handler', async (t) => {
  const app = await fixture(t);
  for (const pathname of ['/api/servers', '/api/panel/applications', '/api/applications/one/environment', '/api/jobs']) {
    assert.equal((await app.request(pathname, { headers: { authorization: 'Bearer obsolete-bootstrap-value' } })).status, 401);
  }
  assert.equal(app.calls(), 0);
});

test('authenticated owner reaches handlers through request.auth without injected credentials', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/api/panel/applications', { headers: { cookie, authorization: 'Bearer attacker-supplied' } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.path, '/api/applications');
  assert.equal(payload.data.actor, 'owner-id');
  assert.equal(payload.data.authorization, 'Bearer attacker-supplied');
});

test('mutation requires both exact origin and the session CSRF token', async (t) => {
  const app = await fixture(t);
  for (const headers of [
    { cookie },
    { ...mutationHeaders, origin: 'https://other.example.test' },
    { ...mutationHeaders, 'x-csrf-token': 'incorrect' },
    { ...mutationHeaders, 'sec-fetch-site': 'cross-site' },
  ]) assert.equal((await app.request('/api/applications', { method: 'POST', headers, body: {} })).status, 403);
  assert.equal(app.calls(), 0);
  assert.equal((await app.request('/api/applications', { method: 'POST', headers: mutationHeaders, body: {} })).status, 200);
});

test('login sets a host-only secure HttpOnly cookie without exposing it in JSON', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/api/auth/login', { method: 'POST', headers: mutationHeaders, body: {} });
  assert.equal(response.status, 200);
  const value = response.headers.get('set-cookie');
  assert.match(value, /^__Host-yunpanel_session=/);
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(value.includes(attribute));
  assert.ok(!value.includes('Domain='));
  const payload = await response.json();
  assert.equal(payload.data.token, undefined);
  assert.equal(payload.data.csrfToken, csrfToken);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('login refuses cross-origin, missing-origin and wrong-content-type requests', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/auth/login', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await app.request('/api/auth/login', { method: 'POST', headers: { origin }, body: '{}' })).status, 415);
  assert.equal((await app.request('/api/auth/login')).status, 405);
});

test('login rate limiting receives only authenticated single-hop client IP metadata', async (t) => {
  const store = fakeStore();
  const peers = [];
  store.login = async ({ peer }) => { peers.push(peer); return { token: 'valid-session', session: store.getSession('valid-session') }; };
  const app = await fixture(t, { store, proxyToken });
  const headers = {
    ...mutationHeaders,
    'x-yunpanel-client-ip': '203.0.113.8',
    'x-yunpanel-proxy-token': proxyToken,
  };
  assert.equal((await app.request('/api/auth/login', { method: 'POST', headers, body: {} })).status, 200);
  assert.deepEqual(peers, ['203.0.113.8']);

  for (const spoofed of [
    { ...mutationHeaders, 'x-forwarded-for': '203.0.113.8' },
    { ...mutationHeaders, 'x-real-ip': '203.0.113.8' },
    { ...headers, 'x-yunpanel-proxy-token': 'x'.repeat(43) },
    { ...headers, 'x-yunpanel-client-ip': '203.0.113.8, 192.0.2.1' },
  ]) assert.equal((await app.request('/api/auth/login', { method: 'POST', headers: spoofed, body: {} })).status, 400);
  assert.deepEqual(peers, ['203.0.113.8']);
});

test('auth body parser rejects malformed, non-object and oversized JSON', async (t) => {
  const app = await fixture(t);
  for (const body of ['{', 'null', '[]']) {
    assert.equal((await app.request('/api/auth/login', { method: 'POST', headers: mutationHeaders, body })).status, 400);
  }
  assert.equal((await app.request('/api/auth/login', { method: 'POST', headers: mutationHeaders, body: { value: 'a'.repeat(20_000) } })).status, 413);
});

test('session listing and logout use the same backend-verified session', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/auth/session', { headers: { cookie } })).status, 200);
  assert.equal((await app.request('/api/auth/sessions', { headers: { cookie } })).status, 200);
  const logout = await app.request('/api/auth/logout', { method: 'POST', headers: mutationHeaders });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await app.request('/api/servers', { headers: { cookie } })).status, 401);
});

test('read-only role reaches only its explicitly declared inventory surface', async (t) => {
  const store = fakeStore();
  const getSession = store.getSession;
  store.getSession = (token) => { const session = getSession(token); return session && { ...session, user: { ...session.user, role: 'read_only' } }; };
  const app = await fixture(t, { store });
  assert.equal((await app.request('/api/servers', { headers: { cookie } })).status, 200);
  assert.equal((await app.request('/api/jobs', { headers: { cookie } })).status, 403);
  assert.equal((await app.request('/api/auth/session', { headers: { cookie } })).status, 200);
  assert.equal(app.calls(), 1);
});

test('legacy agent routes retain their own credentials, not owner injection', async (t) => {
  const app = await fixture(t);
  const pathname = '/api/servers/local/commands/next';
  assert.equal((await app.request(pathname)).status, 401);
  assert.equal((await app.request(pathname, { headers: { authorization: 'Bearer transport-token' } })).status, 200);
  assert.equal((await app.request(pathname, { headers: { origin, authorization: 'Bearer transport-token' } })).status, 403);
  assert.equal((await app.request(pathname, { headers: { cookie } })).status, 403);
});

test('production development endpoints stay closed and public health contains no inventory', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/dev/servers', { headers: { cookie } })).status, 404);
  assert.deepEqual(await (await app.request('/api/health')).json(), { status: 'ok' });
  assert.equal(app.calls(), 0);
});

test('duplicate session cookies are rejected', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/auth/session', { headers: { cookie: `${cookie}; ${cookie}` } })).status, 400);
});

test('insecure or noncanonical production origins cannot start the API', () => {
  for (const publicOrigin of ['http://panel.example.test', 'https://panel.example.test/', 'https://panel.example.test/path']) {
    assert.throws(() => createAuthenticatedApi({ store: fakeStore(), createHandler: () => () => {}, publicOrigin }), /origin/);
  }
  assert.doesNotThrow(() => createAuthenticatedApi({ store: fakeStore(), createHandler: () => () => {}, publicOrigin: 'http://127.0.0.1:5173', development: true }));
});

test('real store setup/login/session/logout flow works over HTTP', async (t) => {
  const { createAuthStore } = await import('../src/auth-store.js');
  const { randomBytes } = await import('node:crypto');
  const { TOTP } = await import('otpauth');
  const now = 1_700_000_010_000;
  const store = createAuthStore({ filePath: ':memory:', masterKey: randomBytes(32), now: () => now });
  t.after(() => store.close());
  const app = await fixture(t, { store });
  const before = await app.request('/api/auth/session');
  assert.equal(before.status, 401);
  assert.equal((await before.json()).setupRequired, true);
  const { token: setupToken } = store.issueSetupToken();
  const password = randomBytes(32).toString('base64url');
  const headers = { origin, 'content-type': 'application/json' };
  assert.equal((await app.request('/api/auth/setup', { method: 'POST', headers, body: { setupToken, username: 'test-owner', password } })).status, 201);
  const login = await app.request('/api/auth/login', { method: 'POST', headers, body: { username: 'test-owner', password } });
  assert.equal(login.status, 200);
  let browserCookie = login.headers.get('set-cookie').split(';')[0];
  const sessionResponse = await app.request('/api/auth/session', { headers: { cookie: browserCookie } });
  assert.equal(sessionResponse.status, 200);
  const session = (await sessionResponse.json()).data;
  assert.equal(session.security.enrollmentRequired, true);
  assert.equal(session.access.mode, 'self_service');
  assert.equal((await app.request('/api/servers', { headers: { cookie: browserCookie } })).status, 403);

  const pending = await app.request('/api/auth/mfa/enroll', {
    method: 'POST',
    headers: { ...headers, cookie: browserCookie, 'x-csrf-token': session.csrfToken },
    body: { password },
  });
  assert.equal(pending.status, 200);
  const enrollment = (await pending.json()).data;
  const code = new TOTP({ secret: enrollment.secret }).generate({ timestamp: now });
  const confirm = await app.request('/api/auth/mfa/confirm', {
    method: 'POST',
    headers: { ...headers, cookie: browserCookie, 'x-csrf-token': session.csrfToken },
    body: { code },
  });
  assert.equal(confirm.status, 200);
  const confirmed = (await confirm.json()).data;
  browserCookie = confirm.headers.get('set-cookie').split(';')[0];
  assert.equal(confirmed.session.access.mode, 'management');
  assert.ok(confirmed.recoveryCodes.length > 0);

  const logout = await app.request('/api/auth/logout', {
    method: 'POST',
    headers: { ...headers, cookie: browserCookie, 'x-csrf-token': confirmed.session.csrfToken },
  });
  assert.equal(logout.status, 204);
  assert.equal((await app.request('/api/auth/session', { headers: { cookie: browserCookie } })).status, 401);
});
