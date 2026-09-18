import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import {
  mountPhpMyAdminHandoffRoutes,
} from '../src/phpmyadmin-handoff-http.js';
import {
  PhpMyAdminHandoffError,
} from '../src/phpmyadmin-handoff-service.js';

const serverId = randomUUID();
const websiteId = randomUUID();
const credentialId = randomUUID();
const capability = 'A'.repeat(43);

function auth(role = 'owner') {
  return role === 'owner'
    ? {
      id: 'owner-session',
      user: { id: 'owner-user', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    }
    : {
      id: 'readonly-session',
      user: { id: 'readonly-user', role: 'read_only' },
      access: { mode: 'read_only', permissions: [] },
      security: { managementAllowed: false },
    };
}

async function listen(t, { role = 'owner', serverExists = true } = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = auth(role);
    next();
  });
  mountPhpMyAdminHandoffRoutes(app, {
    registry: {
      async getServer(id) {
        calls.push(['server', id]);
        return serverExists && id === serverId ? { id } : null;
      },
    },
    phpMyAdminHandoffService: {
      async issue(input) {
        calls.push(['issue', structuredClone(input)]);
        return {
          capability,
          expiresAt: 50_000,
          protocol: 'yunpanel-phpmyadmin-signon-v1',
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
    const known = error instanceof PhpMyAdminHandoffError;
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
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('Owner receives only a no-store short-lived phpMyAdmin capability for the requested Website credential', async (t) => {
  const { base, calls } = await listen(t);
  const response = await fetch(
    `${base}/api/servers/${serverId}/websites/${websiteId}/phpmyadmin-handoffs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId }),
    },
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  const body = await response.json();
  assert.equal(body.data.capability, capability);
  assert.equal(body.data.protocol, 'yunpanel-phpmyadmin-signon-v1');
  assert.equal(JSON.stringify(body).includes('password'), false);
  assert.deepEqual(calls, [
    ['server', serverId],
    ['issue', {
      sessionId: 'owner-session',
      userId: 'owner-user',
      serverId,
      websiteId,
      credentialId,
    }],
  ]);
});

test('Read Only cannot mint phpMyAdmin handoffs', async (t) => {
  const { base, calls } = await listen(t, { role: 'read_only' });
  const response = await fetch(
    `${base}/api/servers/${serverId}/websites/${websiteId}/phpmyadmin-handoffs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId }),
    },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'forbidden');
  assert.deepEqual(calls, []);
});

test('handoff issuance rejects extra body fields and unknown local server before minting a capability', async (t) => {
  const exact = await listen(t);
  const extra = await fetch(
    `${exact.base}/api/servers/${serverId}/websites/${websiteId}/phpmyadmin-handoffs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId, password: 'forbidden' }),
    },
  );
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error.code, 'phpmyadmin_handoff_request_invalid');
  assert.equal(exact.calls.some(([name]) => name === 'issue'), false);

  const missing = await listen(t, { serverExists: false });
  const unknown = await fetch(
    `${missing.base}/api/servers/${serverId}/websites/${websiteId}/phpmyadmin-handoffs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId }),
    },
  );
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'server_not_found');
  assert.equal(missing.calls.some(([name]) => name === 'issue'), false);
});


test('phpMyAdmin gateway access requires an authenticated Owner session', async (t) => {
  const owner = await listen(t);
  const allowed = await fetch(`${owner.base}/api/phpmyadmin-gateway-access`);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.equal(allowed.headers.get('pragma'), 'no-cache');

  const readOnly = await listen(t, { role: 'read_only' });
  const denied = await fetch(`${readOnly.base}/api/phpmyadmin-gateway-access`);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'forbidden');
  assert.deepEqual(readOnly.calls, []);
});

test('phpMyAdmin gateway access rejects query-bearing probes', async (t) => {
  const { base } = await listen(t);
  const response = await fetch(`${base}/api/phpmyadmin-gateway-access?next=/`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'phpmyadmin_handoff_query_invalid');
});
