import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import {
  mountElFinderHandoffRoutes,
} from '../src/elfinder-handoff-http.js';
import {
  ElFinderHandoffError,
} from '../src/elfinder-handoff-service.js';

const serverId = randomUUID();
const websiteId = randomUUID();
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
  mountElFinderHandoffRoutes(app, {
    registry: {
      async getServer(id) {
        calls.push(['server', id]);
        return serverExists && id === serverId ? { id } : null;
      },
    },
    elFinderHandoffService: {
      async issue(input) {
        calls.push(['issue', structuredClone(input)]);
        return {
          capability,
          expiresAt: 50_000,
          protocol: 'yunpanel-elfinder-handoff-v1',
          audience: 'elfinder',
          target: { serverId, websiteId },
        };
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof ElFinderHandoffError;
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

test('Owner receives only a no-store Website-scoped elFinder capability', async (t) => {
  const { base, calls } = await listen(t);
  const response = await fetch(
    `${base}/api/servers/${serverId}/websites/${websiteId}/elfinder-handoffs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  const body = await response.json();
  assert.equal(body.data.capability, capability);
  assert.equal(body.data.protocol, 'yunpanel-elfinder-handoff-v1');
  assert.equal(body.data.audience, 'elfinder');
  assert.deepEqual(body.data.target, { serverId, websiteId });
  assert.equal(JSON.stringify(body).includes('/var/lib/yunpanel/data/'), false);
  assert.equal(JSON.stringify(body).includes('yunapp-'), false);
  assert.deepEqual(calls, [
    ['server', serverId],
    ['issue', {
      sessionId: 'owner-session',
      userId: 'owner-user',
      serverId,
      websiteId,
    }],
  ]);
});

test('Read Only cannot mint elFinder handoffs', async (t) => {
  const { base, calls } = await listen(t, { role: 'read_only' });
  const response = await fetch(
    `${base}/api/servers/${serverId}/websites/${websiteId}/elfinder-handoffs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});

test('elFinder handoff issuance rejects caller-selected root fields and query parameters before issue', async (t) => {
  {
    const { base, calls } = await listen(t);
    const response = await fetch(
      `${base}/api/servers/${serverId}/websites/${websiteId}/elfinder-handoffs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: '/etc', unixUser: 'root' }),
      },
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'elfinder_handoff_request_invalid');
    assert.equal(calls.some(([name]) => name === 'issue'), false);
  }

  {
    const { base, calls } = await listen(t);
    const response = await fetch(
      `${base}/api/servers/${serverId}/websites/${websiteId}/elfinder-handoffs?root=other`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'elfinder_handoff_query_invalid');
    assert.equal(calls.some(([name]) => name === 'issue'), false);
  }
});

test('elFinder handoff issuance rejects an unknown local server before issue', async (t) => {
  const { base, calls } = await listen(t, { serverExists: false });
  const response = await fetch(
    `${base}/api/servers/${serverId}/websites/${websiteId}/elfinder-handoffs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'server_not_found');
  assert.equal(calls.some(([name]) => name === 'issue'), false);
});
