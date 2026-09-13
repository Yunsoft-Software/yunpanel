import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import test from 'node:test';
import {
  DatabaseBindingHttpError,
  mountDatabaseBindingRoutes,
} from '../src/database-binding-http.js';

const serverId = randomUUID();
const bindingId = randomUUID();
const websiteId = randomUUID();
const applicationId = randomUUID();
const owner = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function listen(t, { snapshot = { databases: [{ name: 'app_db', sizeBytes: 0 }] } } = {}) {
  const calls = [];
  const databaseBindingRegistry = {
    async listBindings(filter) { calls.push(['list', structuredClone(filter)]); return []; },
    async bindDatabase(input) {
      calls.push(['bind', structuredClone(input)]);
      return {
        id: bindingId,
        serverId,
        databaseName: input.databaseName,
        websiteId: input.websiteId,
        applicationId: input.applicationId,
        unixUser: 'yunapp-abcdef123456',
        revision: 1,
      };
    },
    async getBinding(id) {
      calls.push(['get', id]);
      return id === bindingId ? { id, serverId, revision: 1 } : null;
    },
    async unbindDatabase(id, input) {
      calls.push(['unbind', id, structuredClone(input)]);
      return { id, databaseName: 'app_db', unbound: true };
    },
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = owner; next(); });
  mountDatabaseBindingRoutes(app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    jobRegistry: { async listJobs() { return []; } },
    databaseBindingRegistry,
    requireDatabaseName: (value) => value,
    ensureDatabaseIdle: async () => {},
    latestDatabaseSnapshot: async () => snapshot,
  });
  app.use((error, _request, response, _next) => {
    const known = error instanceof DatabaseBindingHttpError;
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
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('Owner binds verified database to explicit Website and Application without host mutation', async (t) => {
  const { base, calls } = await listen(t);
  const response = await fetch(`${base}/api/servers/${serverId}/databases/app_db/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      websiteId,
      applicationId,
      confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.unixUser, 'yunapp-abcdef123456');
  assert.deepEqual(body.sideEffects, { databaseChanged: false });
  assert.deepEqual(calls, [['bind', {
    serverId,
    databaseName: 'app_db',
    websiteId,
    applicationId,
    confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
  }]]);
});

test('database bind requires a fresh verified inventory containing the schema', async (t) => {
  for (const [snapshot, expectedStatus, expectedCode] of [
    [null, 409, 'database_inventory_required'],
    [{ databases: [] }, 404, 'database_not_found'],
  ]) {
    const { base, calls } = await listen(t, { snapshot });
    const response = await fetch(`${base}/api/servers/${serverId}/databases/app_db/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        websiteId,
        applicationId,
        confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
      }),
    });
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).error.code, expectedCode);
    assert.equal(calls.some(([name]) => name === 'bind'), false);
  }
});

test('database unbind is server-scoped revisioned control-plane only mutation', async (t) => {
  const { base, calls } = await listen(t);
  const response = await fetch(`${base}/api/servers/${serverId}/database-bindings/${bindingId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: 1,
      confirmation: `unbind-database:${bindingId}:1`,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sideEffects, { databaseChanged: false });
  assert.deepEqual(calls, [
    ['get', bindingId],
    ['unbind', bindingId, { expectedRevision: 1, confirmation: `unbind-database:${bindingId}:1` }],
  ]);
});

test('database binding route rejects extra fields before registry mutation', async (t) => {
  const { base, calls } = await listen(t);
  const response = await fetch(`${base}/api/servers/${serverId}/databases/app_db/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      websiteId,
      applicationId,
      confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
      password: 'forbidden',
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'database_binding_input_invalid');
  assert.deepEqual(calls, []);
});
