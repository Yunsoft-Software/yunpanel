import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { LogHttpError, mountLogRoutes } from '../src/log-http.js';
import { ownerManagementContext, readOnlyManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

const SERVER_ID = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const REMOTE_ID = '75f63b5b-e131-4cec-b209-d15fb6848421';

function dependencies(overrides = {}) {
  return {
    registry: {
      getServer: async (id) => id === SERVER_ID
        ? { id, executionMode: 'local' }
        : id === REMOTE_ID ? { id, executionMode: 'legacy_agent' } : null,
    },
    applicationRegistry: { getApplication: async () => null },
    jobRegistry: { getJob: async () => null },
    journalLogReader: { query: async () => ({ entries: [], page: {}, range: {} }) },
    nginxLogReader: { query: async () => ({ entries: [], page: {}, range: {} }) },
    jobLogStore: { query: async () => ({ entries: [], page: {}, range: {} }) },
    mailQueueInspector: { query: async () => ({ entries: [], page: {}, sideEffects: false }) },
    ...overrides,
  };
}

async function serve(t, context, deps) {
  const app = express();
  mountLogRoutes(app, { ...deps, localServerId: SERVER_ID });
  app.use((error, request, response, next) => {
    if (error instanceof LogHttpError) {
      return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    return next(error);
  });
  const server = http.createServer(withPanelContext(app, context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Owner reads normalized local Postfix queue metadata with no-store semantics', async (t) => {
  const calls = [];
  const queue = {
    entries: [{
      queueId: 'ABC123DEF456', queueName: 'deferred', arrivalTime: '2026-09-12T20:00:00.000Z',
      messageSize: 1234, sender: 'sender@example.com', recipients: [{ address: 'target@example.net', delayReason: null }],
    }],
    page: { limit: 25, count: 1, scanned: 1, hasMore: false, malformed: 0 },
    sideEffects: false,
  };
  const base = await serve(t, ownerManagementContext, dependencies({
    mailQueueInspector: { query: async (query) => { calls.push(structuredClone(query)); return queue; } },
  }));
  const response = await fetch(`${base}/api/servers/${SERVER_ID}/mail/queue?limit=25&q=target%40example.net&queue=deferred`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual((await response.json()).data, queue);
  assert.deepEqual(calls, [{ limit: 25, search: 'target@example.net', queueName: 'deferred' }]);
});

test('mail queue remains Owner-only and local-server scoped', async (t) => {
  let reads = 0;
  const deps = dependencies({
    mailQueueInspector: { query: async () => { reads += 1; return { entries: [], page: {}, sideEffects: false }; } },
  });
  const readOnly = await serve(t, readOnlyManagementContext, deps);
  assert.equal((await fetch(`${readOnly}/api/servers/${SERVER_ID}/mail/queue`)).status, 403);
  assert.equal(reads, 0);

  const owner = await serve(t, ownerManagementContext, deps);
  const remote = await fetch(`${owner}/api/servers/${REMOTE_ID}/mail/queue`);
  assert.equal(remote.status, 409);
  assert.equal((await remote.json()).error.code, 'remote_logs_unavailable');
  assert.equal(reads, 0);

  const missing = await fetch(`${owner}/api/servers/00000000-0000-4000-8000-000000000000/mail/queue`);
  assert.equal(missing.status, 404);
  assert.equal(reads, 0);
});

test('mail queue rejects ambiguous or unsafe query input before invoking Postfix inspector', async (t) => {
  let reads = 0;
  const base = await serve(t, ownerManagementContext, dependencies({
    mailQueueInspector: { query: async () => { reads += 1; return { entries: [], page: {}, sideEffects: false }; } },
  }));
  for (const suffix of [
    '?limit=0',
    '?limit=201',
    '?limit=01',
    '?q=unsafe%0Aquery',
    '?queue=..%2Fdeferred',
    '?raw=true',
    '?limit=1&limit=2',
  ]) {
    const response = await fetch(`${base}/api/servers/${SERVER_ID}/mail/queue${suffix}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_mail_queue_query');
  }
  assert.equal(reads, 0);
});
