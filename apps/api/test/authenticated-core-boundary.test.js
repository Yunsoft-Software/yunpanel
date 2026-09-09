import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createServerRegistry } from '../src/server-registry.js';

const origin = 'https://panel.example.test';
const csrfToken = 'boundary-csrf';

function fakeStore(role = 'owner') {
  const session = {
    id: '12345678-1234-1234-1234-123456789012',
    user: { id: `${role}-id`, username: role, role },
    csrfToken,
    expiresAt: Date.now() + 60_000,
    idleExpiresAt: Date.now() + 60_000,
  };
  return {
    configured: () => true,
    mfa: { enabled: () => role === 'owner' },
    getSession: (token) => token === 'valid-session' ? session : null,
    listSessions: () => [],
  };
}

async function fixture(t, role) {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'boundary' });
  await registry.enrollServer({ token: enrollment.token, hostname: 'boundary-host' });
  const listener = createAuthenticatedApi({
    store: fakeStore(role),
    publicOrigin: origin,
    createHandler: () => createApp({ registry, environment: 'production' }),
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return (path, { authenticated = true, headers = {} } = {}) => fetch(`${baseUrl}${path}`, {
    headers: {
      ...(authenticated ? { cookie: '__Host-yunpanel_session=valid-session' } : {}),
      ...headers,
    },
  });
}

test('verified Owner session reaches the real core without an internal bearer credential', async (t) => {
  const request = await fixture(t, 'owner');
  const response = await request('/api/servers', { headers: { authorization: 'Bearer attacker-value' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].hostname, 'boundary-host');
});

test('anonymous bearer cannot enter the real core management surface', async (t) => {
  const request = await fixture(t, 'owner');
  const response = await request('/api/servers', {
    authenticated: false,
    headers: { authorization: 'Bearer development-admin-token' },
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'unauthorized');
});

test('Read Only reaches exact inventory reads but not jobs through the real core', async (t) => {
  const request = await fixture(t, 'read_only');
  assert.equal((await request('/api/servers')).status, 200);
  const denied = await request('/api/jobs');
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'forbidden');
});
