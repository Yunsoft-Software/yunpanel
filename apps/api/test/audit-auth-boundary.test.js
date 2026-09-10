import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createAuthenticatedApi } from '../src/auth-http.js';

const origin = 'https://panel.example.test';
const cookie = '__Host-yunpanel_session=valid-session';

function store(role = 'owner') {
  const session = {
    id: '12345678-1234-1234-1234-123456789012',
    user: { id: 'owner-1', username: 'owner', role },
    csrfToken: 'csrf-token',
    expiresAt: Date.now() + 60_000,
    idleExpiresAt: Date.now() + 60_000,
  };
  return {
    configured: () => true,
    mfa: { enabled: () => true },
    getSession: (token) => token === 'valid-session' ? session : null,
    audit: {
      list(input) {
        return {
          events: [{ id: 1, actorId: 'owner-1', action: 'login.succeeded', resourceType: 'user', resourceId: 'owner-1', outcome: 'succeeded', code: null, createdAt: 1 }],
          total: 1,
          ...input,
        };
      },
    },
  };
}

async function fixture(t, role = 'owner') {
  let coreCalls = 0;
  const listener = createAuthenticatedApi({
    store: store(role),
    publicOrigin: origin,
    createHandler: () => (_request, response) => {
      coreCalls += 1;
      response.writeHead(500).end();
    },
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return {
    coreCalls: () => coreCalls,
    request(pathname, headers = {}) {
      return fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { headers });
    },
  };
}

test('audit history is owner-only and never reaches the core handler', async (t) => {
  const owner = await fixture(t, 'owner');
  const anonymous = await owner.request('/api/audit');
  assert.equal(anonymous.status, 401);
  const response = await owner.request('/api/audit?limit=10&actorId=owner-1', { cookie });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.total, 1);
  assert.equal(payload.data.limit, 10);
  assert.equal(payload.data.actorId, 'owner-1');
  assert.equal(payload.data.events[0].action, 'login.succeeded');
  assert.equal(owner.coreCalls(), 0);
});

test('panel audit alias uses the same owner boundary', async (t) => {
  const owner = await fixture(t, 'owner');
  const response = await owner.request('/api/panel/audit', { cookie });
  assert.equal(response.status, 200);
  assert.equal(owner.coreCalls(), 0);
});

test('read-only sessions cannot read audit history', async (t) => {
  const reader = await fixture(t, 'read_only');
  const response = await reader.request('/api/audit', { cookie });
  assert.equal(response.status, 403);
  assert.equal(reader.coreCalls(), 0);
});
