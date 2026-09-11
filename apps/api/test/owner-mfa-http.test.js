import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { AuthError } from '../src/auth-error.js';

async function fixture(t, { development = false, origin = 'https://panel.example.test' } = {}) {
  let enrolled = false;
  let currentToken = 'before';
  let active = true;
  let calls = 0;
  const cookieName = development && origin.startsWith('http:') ? 'yunpanel_session' : '__Host-yunpanel_session';
  const session = () => ({ id: currentToken, user: { id: 'owner', username: 'admin', role: 'owner' }, csrfToken: currentToken, expiresAt: Date.now() + 60_000, idleExpiresAt: Date.now() + 60_000 });
  const store = {
    configured: () => true,
    getSession: (token) => active && token === currentToken ? session() : null,
    login: async () => ({ token: currentToken, session: session() }),
    listSessions: () => [{ id: currentToken, current: true }],
    revokeSession: () => { active = false; },
    mfa: {
      enabled: () => enrolled,
      status: () => ({ enabled: enrolled, keyConfigured: true, recoveryCodesRemaining: enrolled ? 10 : 0 }),
      beginEnrollment: async () => ({ secret: 'TEST-ENROLLMENT', expiresAt: Date.now() + 60_000 }),
      confirmEnrollment: (_token, code) => {
        if (code !== '012345') throw new AuthError('mfa_invalid_code', 'Invalid', 401);
        enrolled = true; currentToken = 'after';
        return { token: currentToken, session: session(), recoveryCodes: Array(10).fill('test-code') };
      },
      cancelLogin: () => {},
    },
  };
  const listener = createAuthenticatedApi({ store, publicOrigin: origin, development, createHandler: () => (request, response) => {
    calls++;
    const agent = request.url.includes('/commands/next');
    response.writeHead(agent ? 401 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { id: request.auth?.user.id ?? null } }));
  } });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const request = (url, { authenticated = true, method = 'GET', body, headers = {} } = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method,
    headers: { origin, ...(authenticated ? { cookie: `${cookieName}=${currentToken}`, 'x-csrf-token': currentToken } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { request, store, calls: () => calls, enroll: () => { enrolled = true; }, recover: () => { enrolled = false; }, setActive: (value) => { active = value; } };
}

test('production password login returns enrollment state without granting management', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/api/auth/login', { method: 'POST', body: {}, authenticated: false });
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.deepEqual(body.security, { ownerMfaRequired: true, enrollmentRequired: true, managementAllowed: false });
  assert.ok(body.csrfToken);
  assert.equal(body.token, undefined);
});

test('every management path rejects an unenrolled Owner before the core handler', async (t) => {
  const app = await fixture(t);
  for (const url of ['/api/servers', '/api/panel/servers', '/api/panel/applications/x/environment', '/api/jobs', '/api/jobs/x/logs/deploy', '/api/panel/domains', '/api/terminal']) {
    const response = await app.request(url);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'mfa_enrollment_required');
  }
  const response = await app.request('/api/panel/domains', { method: 'POST', body: { security: { managementAllowed: true } } });
  assert.equal(response.status, 403);
  assert.equal(app.calls(), 0);
});

test('session, security status and own MFA setup remain accessible while locked', async (t) => {
  const app = await fixture(t);
  for (const url of ['/api/auth/session', '/api/auth/security', '/api/auth/sessions', '/api/auth/mfa']) assert.equal((await app.request(url)).status, 200);
  const response = await app.request('/api/auth/keep-alive', { method: 'POST' });
  assert.equal((await response.json()).data.security.enrollmentRequired, true);
  assert.equal((await app.request('/api/auth/mfa/enroll', { method: 'POST', body: { password: 'fixture' } })).status, 200);
  assert.equal(app.calls(), 0);
});

test('confirm enrollment rotates session and unlocks management without another permission grant', async (t) => {
  const app = await fixture(t);
  const bad = await app.request('/api/auth/mfa/confirm', { method: 'POST', body: { code: 'invalid' } });
  assert.equal(bad.status, 401);
  assert.equal((await app.request('/api/servers')).status, 403);
  const success = await app.request('/api/auth/mfa/confirm', { method: 'POST', body: { code: '012345' } });
  assert.equal(success.status, 200);
  const { session, recoveryCodes } = (await success.json()).data;
  assert.equal(session.security.managementAllowed, true);
  assert.equal(session.security.enrollmentRequired, false);
  assert.equal(recoveryCodes.length, 10);
  assert.equal((await app.request('/api/servers')).status, 200);
  const stale = await app.request('/api/servers', { headers: { cookie: '__Host-yunpanel_session=before' } });
  assert.equal(stale.status, 401);
  assert.equal(stale.headers.get('set-cookie'), null);
});

test('local factor reset immediately locks management again even with a retained test session', async (t) => {
  const app = await fixture(t);
  app.enroll();
  assert.equal((await app.request('/api/servers')).status, 200);
  app.recover();
  assert.equal((await app.request('/api/servers')).status, 403);
  assert.equal((await (await app.request('/api/auth/security')).json()).data.enrollmentRequired, true);
});

test('failure reading MFA state denies management rather than trusting client claims', async (t) => {
  const app = await fixture(t);
  app.store.mfa.enabled = () => { throw new Error('database unavailable'); };
  const response = await app.request('/api/panel/servers', { headers: { 'x-mfa-enabled': 'true' } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'auth_unavailable');
  assert.equal(app.calls(), 0);
  // Session termination does not depend on loading factor state.
  assert.equal((await app.request('/api/auth/logout', { method: 'POST' })).status, 204);
});

test('Origin and CSRF checks still run for locked self-service mutations', async (t) => {
  const app = await fixture(t);
  const path = '/api/auth/mfa/confirm';
  for (const headers of [{ origin: 'https://outside.test' }, { 'x-csrf-token': 'wrong' }]) {
    assert.equal((await app.request(path, { method: 'POST', body: { code: '012345' }, headers })).status, 403);
  }
  assert.equal((await app.request('/api/servers')).status, 403);
});

test('anonymous clients do not see account security state', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/api/auth/security', { authenticated: false });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).data, undefined);
  assert.deepEqual(await (await app.request('/api/health', { authenticated: false })).json(), { status: 'ok' });
});

test('development exemption applies only to explicit loopback HTTP, not HTTPS', async (t) => {
  const local = await fixture(t, { development: true, origin: 'http://127.0.0.1:5173' });
  assert.equal((await local.request('/api/servers')).status, 200);
  const https = await fixture(t, { development: true });
  assert.equal((await https.request('/api/servers')).status, 403);
});

test('agent channel keeps its own guard and cannot use Owner cookies to bypass policy', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/servers/local/commands/next')).status, 403);
  assert.equal(app.calls(), 0);
  const response = await app.request('/api/servers/local/commands/next', { authenticated: false, headers: { origin: '' } });
  assert.equal(response.status, 401);
});
