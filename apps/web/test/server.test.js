import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPanelServer } from '../server.js';

const proxyToken = 'p'.repeat(43);

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return server.address().port;
}
async function close(server) {
  await new Promise((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); server.closeAllConnections(); });
}
async function fixture(t, listener) {
  const upstream = http.createServer(listener);
  const upstreamPort = await listen(upstream);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-web-'));
  await writeFile(path.join(directory, 'index.html'), '<title>YunPanel</title>');
  const panel = createPanelServer({
    allowedClientIps: '203.0.113.8',
    apiPort: upstreamPort,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    webRoot: directory,
  });
  const panelPort = await listen(panel);
  t.after(async () => { await close(panel); await close(upstream); await rm(directory, { recursive: true, force: true }); });
  return { request: (pathname, options = {}) => fetch(`http://127.0.0.1:${panelPort}${pathname}`, { ...options, headers: { 'x-real-ip': '203.0.113.8', ...options.headers } }) };
}

test('panel gateway keeps the IP restriction but never injects admin authorization', async (t) => {
  const requests = [];
  const app = await fixture(t, (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      clientIp: request.headers['x-yunpanel-client-ip'],
      proxyToken: request.headers['x-yunpanel-proxy-token'],
    });
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}');
  });
  assert.equal((await app.request('/', { headers: { 'x-real-ip': '192.0.2.9' } })).status, 403);
  const page = await app.request('/settings');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /YunPanel/);
  assert.equal((await app.request('/api/panel/servers?active=true', { headers: {
    authorization: 'Bearer rejected-browser-value',
    cookie: '__Host-yunpanel_session=test-cookie',
    'x-yunpanel-client-ip': '192.0.2.55',
    'x-yunpanel-proxy-token': 'attacker-value',
  } })).status, 200);
  assert.deepEqual(requests[0], {
    method: 'GET',
    url: '/api/servers?active=true',
    authorization: undefined,
    cookie: '__Host-yunpanel_session=test-cookie',
    clientIp: '203.0.113.8',
    proxyToken,
  });
});

test('gateway rejects spoofed or ambiguous forwarding chains before proxying', async (t) => {
  let requests = 0;
  const app = await fixture(t, (_request, response) => { requests += 1; response.end('{}'); });
  for (const headers of [
    { forwarded: 'for=203.0.113.8' },
    { 'x-forwarded-for': '203.0.113.8, 192.0.2.1' },
    { 'x-forwarded-for': '192.0.2.1' },
    { 'x-real-ip': 'not-an-ip' },
  ]) assert.equal((await app.request('/api/auth/session', { headers })).status, 403);
  assert.equal(requests, 0);
});

test('panel gateway rejects cross-origin and missing-origin mutations', async (t) => {
  let requests = 0;
  const app = await fixture(t, (_request, response) => { requests += 1; response.end('{}'); });
  for (const origin of [undefined, 'https://attacker.example']) {
    const response = await app.request('/api/panel/domains/domain-id/stage', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal(requests, 0);
});

test('auth proxy preserves cookies, CSRF headers and Set-Cookie responses', async (t) => {
  const requests = [];
  const app = await fixture(t, (request, response) => {
    requests.push(request);
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': '__Host-yunpanel_session=fixture; Path=/; Secure; HttpOnly; SameSite=Strict' });
    response.end('{"data":{}}');
  });
  const response = await app.request('/api/auth/session', { headers: { cookie: '__Host-yunpanel_session=fixture', 'x-csrf-token': 'fixture-csrf' } });
  assert.equal(response.status, 200);
  assert.equal(requests[0].url, '/api/auth/session');
  assert.equal(requests[0].headers.cookie, '__Host-yunpanel_session=fixture');
  assert.equal(requests[0].headers['x-csrf-token'], 'fixture-csrf');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
});

test('browser proxy does not expose agent transport or raw API routes', async (t) => {
  let requests = 0;
  const app = await fixture(t, (_request, response) => { requests += 1; response.end('{}'); });
  for (const pathname of ['/api/panel/servers/local/commands/next', '/api/panel/servers/enroll', '/api/panel/servers/local/applications/app/environment', '/api/servers', '/api/dev/servers']) {
    assert.equal((await app.request(pathname)).status, 404);
  }
  assert.equal(requests, 0);
});

test('IP-approved browser still needs login through the complete gateway/API chain', async (t) => {
  const { createAuthStore } = await import('../../api/src/auth-store.js');
  const { createAuthenticatedApi } = await import('../../api/src/auth-http.js');
  const { randomBytes } = await import('node:crypto');
  const { createRequire } = await import('node:module');
  const { TOTP } = createRequire(new URL('../../api/package.json', import.meta.url))('otpauth');
  const now = 1_700_000_010_000;
  const store = createAuthStore({ filePath: ':memory:', masterKey: randomBytes(32), now: () => now });
  t.after(() => store.close());
  const { token: setupToken } = store.issueSetupToken();
  const password = randomBytes(32).toString('base64url');
  await store.completeSetup({ setupToken, username: 'owner', password });
  const listener = createAuthenticatedApi({ store, proxyToken, publicOrigin: 'https://panel.example.com', createHandler: () => (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); } });
  const app = await fixture(t, listener);
  assert.equal((await app.request('/api/panel/servers')).status, 401);
  const headers = { origin: 'https://panel.example.com', 'content-type': 'application/json' };
  const login = await app.request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: 'owner', password }) });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  let session = (await login.json()).data;
  assert.equal(session.security.enrollmentRequired, true);
  assert.equal((await app.request('/api/panel/servers', { headers: { cookie } })).status, 403);
  const ownHeaders = { ...headers, cookie, 'x-csrf-token': session.csrfToken };
  const enrollment = await app.request('/api/auth/mfa/enroll', { method: 'POST', headers: ownHeaders, body: JSON.stringify({ password }) });
  assert.equal(enrollment.status, 200);
  const { secret } = (await enrollment.json()).data;
  const confirm = await app.request('/api/auth/mfa/confirm', { method: 'POST', headers: ownHeaders, body: JSON.stringify({ code: new TOTP({ secret }).generate({ timestamp: now }) }) });
  assert.equal(confirm.status, 200);
  cookie = confirm.headers.getSetCookie()[0].split(';')[0];
  session = (await confirm.json()).data.session;
  assert.equal(session.security.managementAllowed, true);
  assert.equal((await app.request('/api/panel/servers', { headers: { cookie } })).status, 200);
  assert.equal((await app.request('/api/auth/logout', { method: 'POST', headers: { ...headers, cookie, 'x-csrf-token': session.csrfToken } })).status, 204);
  assert.equal((await app.request('/api/panel/servers', { headers: { cookie } })).status, 401);
});
