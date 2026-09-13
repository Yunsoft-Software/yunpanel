import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import { DatabaseHttpError, mountDatabaseRoutes } from '../src/database-http.js';

const serverId = randomUUID();
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function listen(t, bindingResult) {
  const enqueued = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = owner; next(); });
  mountDatabaseRoutes(app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    jobRegistry: {
      async listJobs() { return []; },
      async enqueue(input) { enqueued.push(input); return { id: randomUUID(), status: 'queued' }; },
    },
    databaseBindingRegistry: {
      async getByDatabase() {
        if (bindingResult instanceof Error) throw bindingResult;
        return bindingResult;
      },
    },
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof DatabaseHttpError;
    return response.status(known ? error.status : 500).json({
      error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Unexpected error' },
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, enqueued };
}

test('bound database cannot queue DROP until ownership is explicitly removed', async (t) => {
  const { base, enqueued } = await listen(t, {
    id: randomUUID(),
    serverId,
    databaseName: 'app_db',
    websiteId: randomUUID(),
  });
  const response = await fetch(`${base}/api/servers/${serverId}/databases/app_db`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: 'delete:app_db' }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'database_binding_exists');
  assert.deepEqual(enqueued, []);
});

test('database DROP fails closed when ownership state cannot be verified', async (t) => {
  const { base, enqueued } = await listen(t, new Error('store unavailable'));
  const response = await fetch(`${base}/api/servers/${serverId}/databases/app_db`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: 'delete:app_db' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'database_binding_state_unavailable');
  assert.deepEqual(enqueued, []);
});
