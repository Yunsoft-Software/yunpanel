import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';

const origin = 'https://databases.example.test';
const csrfToken = 'database-csrf';

function fakeStore(role = 'owner') {
  const session = {
    id: '12345678-1234-4234-8234-123456789012',
    user: { id: `${role}-id`, username: role, role },
    csrfToken,
    expiresAt: Date.now() + 60_000,
    idleExpiresAt: Date.now() + 60_000,
  };
  return {
    configured: () => true,
    mfa: { enabled: () => role === 'owner' },
    audit: { record() {} },
    getSession: (token) => token === 'valid-session' ? session : null,
    listSessions: () => [],
  };
}

async function fixture(t, role = 'owner') {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'database-http' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'database-host' });
  const jobRegistry = createJobRegistry();
  const listener = createAuthenticatedApi({
    store: fakeStore(role),
    publicOrigin: origin,
    createHandler: () => createApp({ registry, jobRegistry, environment: 'production' }),
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body } = {}) {
    const headers = { cookie: '__Host-yunpanel_session=valid-session' };
    if (method !== 'GET' && method !== 'HEAD') {
      headers.origin = origin;
      headers['sec-fetch-site'] = 'same-origin';
      headers['x-csrf-token'] = csrfToken;
      headers['content-type'] = 'application/json';
    }
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return { request, registry, jobRegistry, serverId: enrolled.server.id };
}

async function succeedNextDatabaseJob(jobRegistry, serverId, result) {
  const claimed = await jobRegistry.claimNext(serverId);
  assert.ok(claimed);
  return jobRegistry.complete({ serverId, jobId: claimed.job.id, status: 'succeeded', result });
}

test('Owner can queue database inspection and empty inventory is explicit before first snapshot', async (t) => {
  const { request, jobRegistry, serverId } = await fixture(t);
  const initial = await request(`/api/servers/${serverId}/databases`);
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).data, { engine: null, version: null, databases: null, snapshot: null });

  const response = await request(`/api/servers/${serverId}/databases/inspect`, { method: 'POST', body: {} });
  assert.equal(response.status, 202);
  const job = (await response.json()).data;
  assert.equal(job.operation, OPERATIONS.DATABASE_INSPECT);
  assert.equal(job.resourceType, 'database');
  assert.equal(job.resourceId, serverId);
  assert.equal((await jobRegistry.listJobs({ serverId })).length, 1);
});

test('database create and delete require exact confirmation and validated names', async (t) => {
  const { request, jobRegistry, serverId } = await fixture(t);
  const denied = await request(`/api/servers/${serverId}/databases`, {
    method: 'POST', body: { name: 'app_main', confirmation: 'yes' },
  });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.code, 'database_confirmation_required');

  const reserved = await request(`/api/servers/${serverId}/databases`, {
    method: 'POST', body: { name: 'mysql', confirmation: 'create:mysql' },
  });
  assert.equal(reserved.status, 400);
  assert.equal((await reserved.json()).error.code, 'invalid_database_name');

  const created = await request(`/api/servers/${serverId}/databases`, {
    method: 'POST', body: { name: 'app_main', confirmation: 'create:app_main' },
  });
  assert.equal(created.status, 202);
  assert.equal((await created.json()).data.operation, OPERATIONS.DATABASE_CREATE);
  await jobRegistry.cancel((await jobRegistry.listJobs({ serverId }))[0].id);

  const deleteDenied = await request(`/api/servers/${serverId}/databases/app_main`, {
    method: 'DELETE', body: { confirmation: 'delete:other' },
  });
  assert.equal(deleteDenied.status, 400);
  assert.equal((await deleteDenied.json()).error.code, 'database_confirmation_required');
});

test('database mutations are serialized per server', async (t) => {
  const { request, serverId } = await fixture(t);
  const inspect = await request(`/api/servers/${serverId}/databases/inspect`, { method: 'POST', body: {} });
  assert.equal(inspect.status, 202);
  const create = await request(`/api/servers/${serverId}/databases`, {
    method: 'POST', body: { name: 'app_main', confirmation: 'create:app_main' },
  });
  assert.equal(create.status, 409);
  assert.equal((await create.json()).error.code, 'database_job_conflict');
});

test('database snapshot merges successful create/delete results after the latest full inspection', async (t) => {
  const { request, jobRegistry, serverId } = await fixture(t);
  await request(`/api/servers/${serverId}/databases/inspect`, { method: 'POST', body: {} });
  await succeedNextDatabaseJob(jobRegistry, serverId, {
    engine: 'mariadb', version: '10.11.13-MariaDB', databases: [{ name: 'old_db', sizeBytes: 100 }],
  });

  await request(`/api/servers/${serverId}/databases`, {
    method: 'POST', body: { name: 'new_db', confirmation: 'create:new_db' },
  });
  await succeedNextDatabaseJob(jobRegistry, serverId, {
    engine: 'mariadb', version: '10.11.13-MariaDB', database: { name: 'new_db', sizeBytes: 0 }, created: true,
  });

  await request(`/api/servers/${serverId}/databases/old_db`, {
    method: 'DELETE', body: { confirmation: 'delete:old_db' },
  });
  const deleted = await succeedNextDatabaseJob(jobRegistry, serverId, {
    engine: 'mariadb', version: '10.11.13-MariaDB', database: { name: 'old_db', sizeBytes: 100 }, deleted: true,
  });

  const response = await request(`/api/servers/${serverId}/databases`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.databases, [{ name: 'new_db', sizeBytes: 0 }]);
  assert.equal(body.data.engine, 'mariadb');
  assert.equal(body.data.snapshot.jobId, deleted.id);
});

test('Read Only cannot enter nested database management routes', async (t) => {
  const { request, serverId } = await fixture(t, 'read_only');
  const response = await request(`/api/servers/${serverId}/databases`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'forbidden');
});
