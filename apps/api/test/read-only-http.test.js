import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createAuthenticatedApi } from '../src/auth-http.js';

const origin = 'https://panel.example.test';
const csrfToken = 'test-csrf-value';
const cookie = '__Host-yunpanel_session=valid-session';
function fakeStore() {
  const session = {
    id: '12345678-1234-1234-1234-123456789012',
    user: { id: 'reader', username: 'reader', role: 'read_only' },
    csrfToken,
    expiresAt: Date.now() + 60_000,
    idleExpiresAt: Date.now() + 60_000,
  };
  return {
    configured: () => true,
    mfa: { enabled: () => false },
    getSession: (token) => token === 'valid-session' ? session : null,
    listSessions: () => [],
  };
}

async function fixture(t) {
  let calls = 0;
  const listener = createAuthenticatedApi({
    store: fakeStore(),
    publicOrigin: origin,
    createHandler: () => (request, response) => {
      calls += 1;
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.auth.user.role, 'read_only');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { path: request.url, access: request.auth.access } }));
    },
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return {
    calls: () => calls,
    request: (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options),
  };
}

test('read-only inventory reads cross the core boundary with explicit capabilities', async (t) => {
  const app = await fixture(t);
  for (const path of [
    '/api/servers', '/api/servers/s1', '/api/applications/a1', '/api/domains/d1', '/api/certificates/c1',
    '/api/dns-zones', '/api/dns-zones/z1', '/api/mail-domains', '/api/mail-domains/m1',
  ]) {
    const response = await app.request(path, { headers: { cookie } });
    assert.equal(response.status, 200, path);
    assert.equal((await response.json()).data.access.mode, 'read_only');
  }
  assert.equal(app.calls(), 9);
});

test('read-only sensitive reads and mutations fail before the core handler', async (t) => {
  const app = await fixture(t);
  for (const path of ['/api/jobs', '/api/users', '/api/applications/a1/environment', '/api/applications/a1/status', '/api/servers/s1/system/packages/inspect', '/api/servers/s1/node-runtimes']) {
    assert.equal((await app.request(path, { headers: { cookie } })).status, 403, path);
  }
  for (const path of [
    '/api/domains', '/api/domains/domain-1/reparent-preview', '/api/domains/domain-1/reparent',
    '/api/applications/application-1/configuration-preview', '/api/applications/application-1/configuration',
    '/api/applications/application-1/process',
    '/api/servers/server-1/node-runtimes/inspect', '/api/servers/server-1/node-runtimes/24/install',
  ]) {
    assert.equal((await app.request(path, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: '{}',
    })).status, 403, path);
  }
  assert.equal(app.calls(), 0);
});

test('read-only auth session publishes its scoped permissions', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/api/auth/session', { headers: { cookie } });
  assert.equal(response.status, 200);
  const session = (await response.json()).data;
  assert.deepEqual(session.access, {
    mode: 'read_only',
    permissions: [
      'servers.read', 'websites.read', 'applications.read', 'domains.read', 'certificates.read',
      'dns_zones.read', 'mail_domains.read',
    ],
  });
  assert.equal(app.calls(), 0);
});
