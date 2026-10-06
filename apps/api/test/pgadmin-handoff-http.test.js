import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import {
  mountPgAdminHandoffRoutes,
} from '../src/pgadmin-handoff-http.js';
import {
  PgAdminHandoffError,
} from '../src/pgadmin-handoff-service.js';

const serverId = randomUUID();
const websiteId = randomUUID();
const credentialId = randomUUID();
const capability = 'A'.repeat(43);
const SESSION_DIGEST = 'd'.repeat(64);

function auth(role = 'owner', { websiteIds: customWebsiteIds } = {}) {
  if (role === 'owner') {
    return {
      id: 'owner-session',
      user: { id: 'owner-user', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
  }
  if (role === 'site_manager' || role === 'reseller' || role === 'customer') {
    return {
      id: `${role}-session`,
      user: { id: `${role}-user`, role, websiteIds: customWebsiteIds ?? [websiteId] },
      access: { mode: 'site_management', permissions: ['website:manage'] },
      security: { managementAllowed: true },
    };
  }
  return {
    id: 'readonly-session',
    user: { id: 'readonly-user', role: 'read_only' },
    access: { mode: 'read_only', permissions: [] },
    security: { managementAllowed: false },
  };
}

async function listen(t, { role = 'owner', serverExists = true, websiteIds } = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = auth(role, { websiteIds });
    request.authSessionDigest = SESSION_DIGEST;
    next();
  });
  mountPgAdminHandoffRoutes(app, {
    registry: {
      async getServer(id) {
        calls.push(['server', id]);
        return serverExists && id === serverId ? { id } : null;
      },
    },
    pgAdminHandoffService: {
      async issue(input) {
        calls.push(['issue', structuredClone(input)]);
        return {
          capability,
          expiresAt: 50_000,
          protocol: 'yunpanel-pgadmin-signon-v1',
          target: {
            serverId,
            websiteId,
            databaseCredentialId: credentialId,
            databaseName: 'site_main',
          },
        };
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof PgAdminHandoffError;
    return response.status(known ? error.status : 500).json({
      error: {
        code: known ? error.code : 'internal_error',
        message: known ? error.message : 'Unexpected error',
      },
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
  };
}

test('pgAdmin handoff route issues a single-use capability for authorized owner session', async (t) => {
  const current = await listen(t, { role: 'owner' });
  const response = await fetch(`${current.base}/api/servers/${serverId}/websites/${websiteId}/pgadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  const payload = await response.json();
  assert.equal(payload.data.capability, capability);
  assert.equal(payload.data.protocol, 'yunpanel-pgadmin-signon-v1');
  assert.deepEqual(current.calls[1], [
    'issue',
    {
      sessionId: 'owner-session',
      userId: 'owner-user',
      sessionDigest: SESSION_DIGEST,
      serverId,
      websiteId,
      credentialId,
    },
  ]);
});

test('pgAdmin handoff route allows site_manager on assigned websiteId', async (t) => {
  const current = await listen(t, { role: 'site_manager', websiteIds: [websiteId] });
  const response = await fetch(`${current.base}/api/servers/${serverId}/websites/${websiteId}/pgadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId }),
  });
  assert.equal(response.status, 201);
});

test('pgAdmin handoff route rejects site_manager on unassigned websiteId', async (t) => {
  const current = await listen(t, { role: 'site_manager', websiteIds: ['different-website'] });
  const response = await fetch(`${current.base}/api/servers/${serverId}/websites/${websiteId}/pgadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId }),
  });
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.error.code, 'pgadmin_handoff_authorized_required');
});

test('pgAdmin handoff route rejects extra request body fields', async (t) => {
  const current = await listen(t, { role: 'owner' });
  const response = await fetch(`${current.base}/api/servers/${serverId}/websites/${websiteId}/pgadmin-handoffs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentialId, extra: 'bad' }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, 'pgadmin_handoff_request_invalid');
});

test('pgAdmin signon-access and gateway-access routes validate session mode', async (t) => {
  const current = await listen(t, { role: 'owner' });
  const signonRes = await fetch(`${current.base}/api/pgadmin-signon-access`);
  assert.equal(signonRes.status, 204);

  const gatewayRes = await fetch(`${current.base}/api/pgadmin-gateway-access`);
  assert.equal(gatewayRes.status, 204);
});
