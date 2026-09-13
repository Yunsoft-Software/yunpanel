import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DatabaseCredentialHttpError,
  mountDatabaseCredentialRoutes,
} from '../src/database-credential-http.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const bindingId = '22345678-1234-4234-8234-123456789012';
const credentialId = '32345678-1234-4234-8234-123456789012';
const deleteJobId = 'database-credential-delete-job-0001';
const username = 'ydb_0123456789abcdef01234567';
const digest = 'a'.repeat(64);

function createFakeApp() {
  const routes = new Map();
  const register = (method) => (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1));
  return {
    routes,
    get: register('GET'),
    post: register('POST'),
    patch: register('PATCH'),
    delete: register('DELETE'),
  };
}

async function invoke(app, method, route, { params = {}, query = {}, body = undefined } = {}) {
  const handler = app.routes.get(`${method} ${route}`);
  assert.equal(typeof handler, 'function');
  let status = 200;
  let payload;
  let forwarded = null;
  const response = {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  };
  await handler({ params, query, body }, response, (error) => { forwarded = error; });
  if (forwarded) throw forwarded;
  return { status, payload };
}

function fixture() {
  const calls = [];
  const binding = {
    id: bindingId,
    serverId,
    databaseName: 'app_main',
    websiteId: '42345678-1234-4234-8234-123456789012',
    applicationId: '52345678-1234-4234-8234-123456789012',
    unixUser: 'yunapp-0123456789ab',
    revision: 2,
  };
  const credential = {
    id: credentialId,
    databaseBindingId: bindingId,
    serverId,
    databaseName: 'app_main',
    websiteId: binding.websiteId,
    applicationId: binding.applicationId,
    siteUnixUser: binding.unixUser,
    username,
    host: 'localhost',
    privileges: ['SELECT', 'INSERT'],
    revision: 3,
    passwordUpdatedAt: '2026-09-13T03:00:00.000Z',
  };
  const app = createFakeApp();
  const databaseCredentialRegistry = {
    async createCredential(input) { calls.push(['create', input]); return credential; },
    async getCredential(id) { return id === credentialId ? credential : null; },
    async getForBinding(id) { return id === bindingId ? null : null; },
    async setPrivileges(id, input) { calls.push(['grants', id, input]); return { ...credential, revision: 4, privileges: input.privileges }; },
    async rotatePassword(id, input) { calls.push(['rotate', id, input]); return { ...credential, revision: 4 }; },
    async deleteCredential(id, input) { calls.push(['finalize', id, input]); return { id, deleted: true }; },
  };
  mountDatabaseCredentialRoutes(app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    databaseBindingRegistry: { async getBinding(id) { return id === bindingId ? binding : null; } },
    databaseCredentialRegistry,
    databaseCredentialApplyService: {
      async previewApply(id) { calls.push(['previewApply', id]); return { desiredStateSha256: digest }; },
      async queueApply(input) { calls.push(['queueApply', input]); return { desiredStateSha256: digest, job: { id: 'apply-job' } }; },
      async previewDelete(id) { calls.push(['previewDelete', id]); return { desiredStateSha256: digest }; },
      async queueDelete(input) { calls.push(['queueDelete', input]); return { desiredStateSha256: digest, job: { id: deleteJobId } }; },
    },
    jobRegistry: {
      async getJob(id) {
        if (id !== deleteJobId) return null;
        return {
          id,
          serverId,
          status: 'succeeded',
          operation: 'database.credential.delete',
          resourceType: 'database',
          resourceId: 'app_main',
          result: {
            databaseCredentialId: credentialId,
            databaseBindingId: bindingId,
            credentialRevision: 3,
            bindingRevision: 2,
            deleted: true,
            sideEffects: true,
          },
        };
      },
    },
    ensureDatabaseIdle: async () => { calls.push(['idle']); },
  });
  return { app, calls, binding, credential };
}

test('credential create preview exposes deterministic identity without secret material', async () => {
  const { app } = fixture();
  const response = await invoke(
    app,
    'GET',
    '/api/servers/:serverId/database-bindings/:bindingId/credential-create-preview',
    { params: { serverId, bindingId } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.payload.data.databaseName, 'app_main');
  assert.equal(response.payload.data.username, username);
  assert.equal(response.payload.data.host, 'localhost');
  assert.equal(response.payload.data.sideEffects, false);
  assert.equal(Object.hasOwn(response.payload.data, 'password'), false);
  assert.match(response.payload.data.confirmation, /^create-database-credential:/);
});

test('credential desired-state mutations stay control-plane only and require explicit apply', async () => {
  const { app, calls } = fixture();
  const create = await invoke(
    app,
    'POST',
    '/api/servers/:serverId/database-bindings/:bindingId/credential',
    {
      params: { serverId, bindingId },
      body: {
        privileges: ['SELECT', 'INSERT'],
        confirmation: `create-database-credential:${bindingId}:${username}`,
      },
    },
  );
  assert.equal(create.status, 201);
  assert.deepEqual(create.payload.sideEffects, { databaseChanged: false, requiresApply: true });
  assert.equal(Object.hasOwn(create.payload.data, 'password'), false);

  const grants = await invoke(app, 'PATCH', '/api/servers/:serverId/database-credentials/:credentialId/grants', {
    params: { serverId, credentialId },
    body: { expectedRevision: 3, privileges: ['SELECT'], confirmation: `set-database-grants:${credentialId}:3` },
  });
  assert.deepEqual(grants.payload.sideEffects, { databaseChanged: false, requiresApply: true });

  const rotate = await invoke(app, 'POST', '/api/servers/:serverId/database-credentials/:credentialId/password/rotate', {
    params: { serverId, credentialId },
    body: { expectedRevision: 3, confirmation: `rotate-database-password:${credentialId}:3` },
  });
  assert.deepEqual(rotate.payload.sideEffects, { databaseChanged: false, requiresApply: true });
  assert.ok(calls.some(([name]) => name === 'create'));
  assert.ok(calls.some(([name]) => name === 'grants'));
  assert.ok(calls.some(([name]) => name === 'rotate'));
});

test('credential apply accepts only exact revision digest confirmation payload', async () => {
  const { app, calls } = fixture();
  const body = {
    expectedCredentialRevision: 3,
    expectedBindingRevision: 2,
    expectedDesiredStateSha256: digest,
    confirmation: `apply-database-credential:${credentialId}:${digest}`,
  };
  const response = await invoke(app, 'POST', '/api/servers/:serverId/database-credentials/:credentialId/apply', {
    params: { serverId, credentialId }, body,
  });
  assert.equal(response.status, 202);
  assert.ok(calls.some(([name, input]) => name === 'queueApply' && input.expectedDesiredStateSha256 === digest));

  await assert.rejects(
    invoke(app, 'POST', '/api/servers/:serverId/database-credentials/:credentialId/apply', {
      params: { serverId, credentialId }, body: { ...body, extra: true },
    }),
    (error) => error instanceof DatabaseCredentialHttpError && error.code === 'database_credential_apply_input_invalid',
  );
});

test('credential finalization requires matching successful host delete evidence', async () => {
  const { app, calls } = fixture();
  const response = await invoke(app, 'DELETE', '/api/servers/:serverId/database-credentials/:credentialId', {
    params: { serverId, credentialId },
    body: {
      expectedRevision: 3,
      deleteJobId,
      confirmation: `finalize-database-credential-delete:${credentialId}:3:${deleteJobId}`,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.payload.data.deleted, true);
  assert.equal(response.payload.data.finalizedFromJobId, deleteJobId);
  const finalization = calls.find(([name]) => name === 'finalize');
  assert.ok(finalization);
  assert.equal(finalization[1], credentialId);
  assert.deepEqual(finalization[2], {
    expectedRevision: 3,
    confirmation: `delete-database-credential:${credentialId}:3`,
  });
});
