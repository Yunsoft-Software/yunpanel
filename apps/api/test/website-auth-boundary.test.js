import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const origin = 'https://panel.example.test';
const csrfToken = 'website-boundary-csrf';

function fakeStore(role) {
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
    audit: {
      record() { return {}; },
      list() { return { events: [], total: 0, offset: 0, limit: 50 }; },
    },
  };
}

async function createListener(t, { role, registry, websiteRegistry }) {
  const listener = createAuthenticatedApi({
    store: fakeStore(role),
    publicOrigin: origin,
    createHandler: () => createApp({ registry, websiteRegistry, environment: 'production' }),
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (pathname, { method = 'GET', body = null } = {}) => fetch(`${base}${pathname}`, {
    method,
    headers: {
      cookie: '__Host-yunpanel_session=valid-session',
      ...(body == null ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': csrfToken }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

async function resources() {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'website-boundary' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'website-boundary-host' });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  });
  await websiteRegistry.init();
  return { registry, websiteRegistry, serverId: enrolled.server.id };
}

test('Owner creates a real Website resource through authenticated API composition', async (t) => {
  const state = await resources();
  const request = await createListener(t, { role: 'owner', ...state });
  const response = await request('/api/websites', {
    method: 'POST',
    body: { serverId: state.serverId, name: 'Proxy Site', runtimeType: 'proxy' },
  });
  assert.equal(response.status, 201);
  const website = (await response.json()).data;
  assert.equal(website.serverId, state.serverId);
  assert.equal(website.runtimeType, 'proxy');
  assert.equal(website.applicationId, null);
  assert.equal(Object.hasOwn(website, 'hostname'), false);
});

test('Read Only may list and read Websites but cannot create one', async (t) => {
  const state = await resources();
  const seeded = await state.websiteRegistry.createWebsite({ serverId: state.serverId, name: 'Existing', runtimeType: 'proxy' });
  const request = await createListener(t, { role: 'read_only', ...state });

  const list = await request('/api/websites');
  assert.equal(list.status, 200);
  assert.equal((await list.json()).data[0].id, seeded.id);
  assert.equal((await request(`/api/websites/${seeded.id}`)).status, 200);

  const denied = await request('/api/websites', {
    method: 'POST',
    body: { serverId: state.serverId, name: 'Denied', runtimeType: 'proxy' },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'forbidden');
  assert.equal((await state.websiteRegistry.listWebsites()).length, 1);
});
