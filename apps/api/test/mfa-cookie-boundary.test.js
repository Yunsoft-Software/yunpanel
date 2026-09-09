import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { AuthError } from '../src/auth-error.js';

const origin = 'https://panel.example.test';
const cookie = '__Host-yunpanel_session=current';
const session = { id: 'id', user: { id: 'owner', username: 'admin', role: 'owner' }, csrfToken: 'csrf', expiresAt: 9000, idleExpiresAt: 5000 };
const proofHeaders = { origin, 'content-type': 'application/json' };
const authHeaders = { ...proofHeaders, cookie, 'x-csrf-token': 'csrf' };

async function fixture(t) {
  let active = true, challenge = true, calls = 0;
  const store = {
    configured: () => true,
    getSession: (token) => active && token === 'current' ? session : null,
    revokeSession: () => { active = false; },
    login: async () => ({ mfaRequired: true, challengeToken: 'challenge-secret', expiresAt: 9000 }),
    mfa: {
      cancelLogin: () => { challenge = false; },
      completeLogin(token, proof) {
        if (!challenge || token !== 'challenge-secret') throw new AuthError('mfa_challenge_expired', 'Expired', 401);
        if (proof.code !== '012345') throw new AuthError('mfa_invalid_code', 'Invalid code', 401);
        challenge = false;
        return { token: 'current', session };
      },
      confirmEnrollment: () => ({ token: 'rotated', session: { ...session, id: 'rotated' }, recoveryCodes: Array.from({ length: 10 }, () => 'test-recovery') }),
    },
  };
  const server = http.createServer(createAuthenticatedApi({ store, publicOrigin: origin, createHandler: () => (_request, response) => { calls += 1; response.end('{}'); } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { calls: () => calls, request: (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options) };
}

test('stale unauthorized request does not erase a newer session cookie', async (t) => {
  const app = await fixture(t);
  for (const path of ['/api/auth/session', '/api/panel/domains']) {
    const response = await app.request(path, { headers: { cookie: '__Host-yunpanel_session=obsolete' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal((await app.request('/api/panel/domains', { headers: { cookie } })).status, 200);
});

test('explicit authenticated logout still expires both cookies', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/api/auth/logout', { method: 'POST', headers: authHeaders });
  assert.equal(response.status, 204);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((entry) => entry.includes('Max-Age=0')));
  assert.equal((await app.request('/api/panel/domains', { headers: { cookie } })).status, 401);
});

test('password-only MFA challenge cannot access management and its token stays out of JSON', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/api/auth/login', { method: 'POST', headers: proofHeaders, body: '{}' });
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.deepEqual(payload.data, { mfaRequired: true, expiresAt: 9000 });
  assert.equal(JSON.stringify(payload).includes('challenge-secret'), false);
  assert.match(response.headers.getSetCookie()[1], /HttpOnly; SameSite=Strict; Secure; Max-Age=300/);
  assert.equal((await app.request('/api/panel/domains', { headers: { cookie: '__Host-yunpanel_mfa=challenge-secret' } })).status, 401);
  assert.equal(app.calls(), 0);
});

test('wrong MFA proof does not set a session, successful proof rotates cookies', async (t) => {
  const app = await fixture(t);
  const headers = { ...proofHeaders, cookie: '__Host-yunpanel_mfa=challenge-secret' };
  const bad = await app.request('/api/auth/mfa/verify', { method: 'POST', headers, body: '{"code":"111111"}' });
  assert.equal(bad.status, 401); assert.equal(bad.headers.get('set-cookie'), null);
  const good = await app.request('/api/auth/mfa/verify', { method: 'POST', headers, body: '{"code":"012345","method":"totp"}' });
  assert.equal(good.status, 200); assert.equal((await good.json()).data.user.username, 'admin');
  assert.match(good.headers.getSetCookie()[0], /__Host-yunpanel_session=current/);
  assert.match(good.headers.getSetCookie()[1], /Max-Age=0/);
  assert.equal((await app.request('/api/auth/mfa/verify', { method: 'POST', headers, body: '{"code":"012345"}' })).status, 401);
});

test('enrollment confirmation still requires session Origin and CSRF', async (t) => {
  const app = await fixture(t);
  const path = '/api/auth/mfa/confirm';
  assert.equal((await app.request(path, { method: 'POST', headers: proofHeaders, body: '{}' })).status, 401);
  assert.equal((await app.request(path, { method: 'POST', headers: { ...authHeaders, origin: 'https://other.test' }, body: '{}' })).status, 403);
  assert.equal((await app.request(path, { method: 'POST', headers: { ...authHeaders, 'x-csrf-token': 'wrong' }, body: '{}' })).status, 403);
  const good = await app.request(path, { method: 'POST', headers: authHeaders, body: '{"code":"012345"}' });
  assert.equal(good.status, 200);
  const payload = (await good.json()).data;
  assert.equal(payload.session.id, 'rotated'); assert.equal(payload.recoveryCodes.length, 10); assert.equal(payload.token, undefined);
  assert.match(good.headers.getSetCookie()[0], /session=rotated/);
});

test('MFA cancel rejects cross-origin requests and invalidates the pending challenge', async (t) => {
  const app = await fixture(t);
  const headers = { ...proofHeaders, cookie: '__Host-yunpanel_mfa=challenge-secret' };
  assert.equal((await app.request('/api/auth/mfa/cancel', { method: 'POST', headers: { ...headers, origin: 'https://other.test' } })).status, 403);
  const cancel = await app.request('/api/auth/mfa/cancel', { method: 'POST', headers });
  assert.equal(cancel.status, 204);
  assert.match(cancel.headers.getSetCookie()[0], /Max-Age=0/);
  assert.equal((await app.request('/api/auth/mfa/verify', { method: 'POST', headers, body: '{"code":"012345"}' })).status, 401);
});
