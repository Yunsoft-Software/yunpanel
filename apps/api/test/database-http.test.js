import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { databaseHttpInternals } from '../src/database-http.js';
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

async function fixture(t, role = 'owner', {
  databaseInventoryProvider = async () => ({
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    databases: [{ name: 'live_db', sizeBytes: 42 }],
  }),
  databaseHealthProvider = async () => ({
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    connection: {
      protocol: 'socket',
      adminAccount: 'root@localhost',
      loginAccount: 'root@localhost',
      authPlugin: 'unix_socket',
      nativeSocketAuth: true,
    },
    hygiene: {
      anonymousAccountsAbsent: true,
      remoteRootAccountsAbsent: true,
      testSchemaAbsent: true,
    },
    ready: true,
    reason: null,
  }),
} = {}) {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'database-http' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'database-host' });
  const jobRegistry = createJobRegistry();
  const listener = createAuthenticatedApi({
    store: fakeStore(role),
    publicOrigin: origin,
    createHandler: () => createApp({
      registry,
      jobRegistry,
      environment: 'production',
      databaseInventoryProvider,
      databaseHealthProvider,
    }),
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

test('Owner GET reads live inventory while explicit legacy inspection remains a durable job', async (t) => {
  const { request, jobRegistry, serverId } = await fixture(t);
  const initial = await request(`/api/servers/${serverId}/databases`);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await initial.json()).data, {
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    databases: [{ name: 'live_db', sizeBytes: 42 }],
    live: true,
    health: {
      available: true,
      ready: true,
      reason: null,
      connection: {
        protocol: 'socket',
        adminAccount: 'root@localhost',
        loginAccount: 'root@localhost',
        authPlugin: 'unix_socket',
        nativeSocketAuth: true,
      },
      hygiene: {
        anonymousAccountsAbsent: true,
        remoteRootAccountsAbsent: true,
        testSchemaAbsent: true,
      },
    },
  });

  const response = await request(`/api/servers/${serverId}/databases/inspect`, { method: 'POST', body: {} });
  assert.equal(response.status, 202);
  const job = (await response.json()).data;
  assert.equal(job.operation, OPERATIONS.DATABASE_INSPECT);
  assert.equal(job.resourceType, 'database');
  assert.equal(job.resourceId, serverId);
  assert.equal((await jobRegistry.listJobs({ serverId })).length, 1);
});

test('Roundcube schemas are hidden in authenticated inventory and blocked from mutations', async (t) => {
  const { request, jobRegistry, serverId } = await fixture(t, 'owner', {
    databaseInventoryProvider: async () => ({
      engine: 'mariadb', version: '10.11.13-MariaDB', databases: [
        { name: 'live_db', sizeBytes: 42 },
        { name: 'roundcube', sizeBytes: 512 },
        { name: 'RoundcubeMail_archive', sizeBytes: 128 },
      ],
    }),
  });
  const route = `/api/servers/${serverId}/databases`;
  const response = await request(route);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.databases, [{ name: 'live_db', sizeBytes: 42 }]);
  for (const name of ['roundcube', 'RoundcubeMail_archive']) {
    const encoded = encodeURIComponent(name);
    for (const [path, method, body] of [
      [route, 'POST', { name, confirmation: `create:${name}` }],
      [`${route}/${encoded}`, 'DELETE', { confirmation: `delete:${name}` }],
      [`${route}/${encoded}/backup`, 'POST', { confirmation: `backup:${name}` }],
      [`${route}/${encoded}/drop-preview`, 'GET'],
      [`${route}/${encoded}/restore-preview`, 'POST', { backupId: 'unrelated' }],
    ]) {
      const denied = await request(path, { method, body });
      assert.equal(denied.status, 400, `${method} ${path}`);
      assert.equal((await denied.json()).error.code, 'invalid_database_name');
    }
  }
  assert.deepEqual(await jobRegistry.listJobs({ serverId }), []);
});

test('live database GET reports security inspection failure as unavailable without leaking provider errors', async (t) => {
  const { request, serverId } = await fixture(t, 'owner', {
    databaseHealthProvider: async () => { throw new Error('private database detail'); },
  });
  const response = await request(`/api/servers/${serverId}/databases`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.health, {
    available: false,
    ready: false,
    reason: 'database_security_inspection_unavailable',
    connection: null,
    hygiene: null,
  });
  assert.equal(JSON.stringify(body).includes('private database detail'), false);
});

test('database health rejects engine drift and inconsistent ready evidence', async () => {
  const inventory = { engine: 'mariadb', version: '10.11', databases: [] };
  const baseline = {
    engine: 'mysql',
    version: '10.11',
    connection: {
      protocol: 'socket',
      adminAccount: 'root@localhost',
      loginAccount: 'root@localhost',
      authPlugin: 'auth_socket',
      nativeSocketAuth: true,
    },
    hygiene: {
      anonymousAccountsAbsent: true,
      remoteRootAccountsAbsent: true,
      testSchemaAbsent: true,
    },
    ready: true,
    reason: null,
  };
  const drifted = await databaseHttpInternals.attachDatabaseHealth(inventory, async () => baseline, 'server-id');
  assert.equal(drifted.health.available, false);
  const inconsistent = await databaseHttpInternals.attachDatabaseHealth(inventory, async () => ({
    ...baseline,
    engine: 'mariadb',
    ready: false,
  }), 'server-id');
  assert.equal(inconsistent.health.available, false);
});

test('live database GET fails closed on provider failure or malformed inventory', async (t) => {
  for (const provider of [
    async () => { throw new Error('socket path leaked'); },
    async () => ({ engine: 'mariadb', version: '10.11', databases: [{ name: 'mysql', sizeBytes: 0 }] }),
  ]) {
    const { request, serverId } = await fixture(t, 'owner', { databaseInventoryProvider: provider });
    const response = await request(`/api/servers/${serverId}/databases`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'database_inventory_unavailable');
    assert.equal(JSON.stringify(body).includes('socket path leaked'), false);
  }
});

test('live inventory joins Website binding and secret-safe credential metadata', async () => {
  const binding = {
    id: '12345678-1234-4234-8234-123456789012',
    serverId: '22345678-1234-4234-8234-123456789012',
    databaseName: 'live_db',
    websiteId: '32345678-1234-4234-8234-123456789012',
    applicationId: '42345678-1234-4234-8234-123456789012',
    unixUser: 'yunapp-abcdef012345',
    revision: 3,
  };
  const credential = {
    id: '52345678-1234-4234-8234-123456789012',
    databaseBindingId: binding.id,
    serverId: binding.serverId,
    username: 'ydb_abcdef012345abcdef012345',
    host: 'localhost',
    privileges: ['SELECT', 'INSERT'],
    revision: 4,
    passwordUpdatedAt: '2026-09-17T12:00:00.000Z',
    password: 'must-not-leak',
  };
  const result = await databaseHttpInternals.attachDatabaseOwnership({
    engine: 'mariadb',
    version: '10.11',
    live: true,
    databases: [{ name: 'live_db', sizeBytes: 42 }, { name: 'free_db', sizeBytes: 0 }],
  }, {
    serverId: binding.serverId,
    databaseBindingRegistry: { async listBindings() { return [binding]; } },
    databaseCredentialRegistry: { async listCredentials() { return [credential]; } },
  });
  assert.deepEqual(result.databases[0].ownership.credential, {
    id: credential.id,
    username: credential.username,
    host: 'localhost',
    privileges: ['SELECT', 'INSERT'],
    revision: 4,
    passwordUpdatedAt: credential.passwordUpdatedAt,
  });
  assert.equal(result.databases[1].ownership, null);
  assert.equal('password' in result.databases[0].ownership.credential, false);
  assert.deepEqual(result.ownership, {
    bindingCount: 1,
    credentialCount: 1,
    missingDatabaseBindingCount: 0,
  });
});

test('live inventory fails closed when credential ownership cannot be joined exactly', async () => {
  await assert.rejects(
    databaseHttpInternals.attachDatabaseOwnership({ databases: [] }, {
      serverId: '22345678-1234-4234-8234-123456789012',
      databaseBindingRegistry: { async listBindings() { return []; } },
      databaseCredentialRegistry: {
        async listCredentials() {
          return [{
            id: '52345678-1234-4234-8234-123456789012',
            databaseBindingId: '12345678-1234-4234-8234-123456789012',
            serverId: '22345678-1234-4234-8234-123456789012',
            username: 'ydb_abcdef012345abcdef012345',
            host: 'localhost',
            privileges: ['SELECT'],
            revision: 1,
            passwordUpdatedAt: '2026-09-17T12:00:00.000Z',
          }];
        },
      },
    }),
    (error) => error?.code === 'database_ownership_state_unavailable' && error?.status === 503,
  );
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
  const { request, jobRegistry, serverId } = await fixture(t, 'owner', { databaseInventoryProvider: null });
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
