import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createApplicationRegistry } from '../src/applications/application-registry.js';
import { createAuthenticatedApi } from '../src/auth/auth-http.js';
import { createAuthStore } from '../src/auth/auth-store.js';
import { mountDatabaseBindingRoutes } from '../src/databases/database-binding-http.js';
import { createDatabaseBindingRegistry } from '../src/databases/database-binding-registry.js';
import { createDatabaseCredentialApplyService } from '../src/databases/database-credential-apply-service.js';
import {
  createDatabaseCredentialRegistry,
  databaseCredentialRegistryInternals,
} from '../src/databases/database-credential-registry.js';
import {
  DatabaseCredentialHttpError,
  mountDatabaseCredentialRoutes,
} from '../src/databases/database-credential-http.js';
import { databaseHttpInternals } from '../src/databases/database-http.js';
import { createJobRegistry } from '../src/jobs/job-registry.js';
import { createServerRegistry } from '../src/runtime/server-registry.js';
import { createSiteMutationLock } from '../src/websites/site-mutation-lock.js';
import { createSiteResourceBoundary } from '../src/http/site-resource-boundary.js';
import { createWebsiteRegistry } from '../src/websites/website-registry.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const bindingId = '22345678-1234-4234-8234-123456789012';
const credentialId = '32345678-1234-4234-8234-123456789012';
const deleteJobId = 'database-credential-delete-job-0001';
const username = databaseCredentialRegistryInternals.usernameFor(bindingId);
const digest = 'a'.repeat(64);

test('authenticated database metadata writes share the Application lock only for the affected site', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-db-metadata-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const servers = createServerRegistry({ filePath: path.join(directory, 'servers.json') });
  const server = await servers.createLocalServer({ hostname: 'database-lock.example.test' });
  const serverExists = async (id) => Boolean(await servers.getServer(id));
  const applications = createApplicationRegistry({ filePath: path.join(directory, 'applications.json'), serverExists });
  const websiteRegistry = createWebsiteRegistry({ filePath: path.join(directory, 'websites.json'), serverExists,
    getApplication: applications.getApplication });
  async function createSite(name) {
    const application = await applications.createPhpApplication({ serverId: server.id, name });
    return websiteRegistry.createWebsite({ serverId: server.id, name, applicationId: application.id, runtimeType: 'php' });
  }
  const source = await createSite('source.database-lock.example.test');
  const target = await createSite('target.database-lock.example.test');
  const databaseBindingRegistry = createDatabaseBindingRegistry({
    filePath: path.join(directory, 'bindings.json'), serverExists,
    getWebsite: websiteRegistry.getWebsite, getApplication: applications.getApplication,
  });
  const credentialFile = path.join(directory, 'credentials.json');
  const databaseCredentialRegistry = createDatabaseCredentialRegistry({
    filePath: credentialFile, masterKey: randomBytes(32).toString('hex'), getDatabaseBinding: databaseBindingRegistry.getBinding,
  });
  const jobRegistry = createJobRegistry({ filePath: path.join(directory, 'jobs.json') });
  const databaseCredentialApplyService = createDatabaseCredentialApplyService({ databaseBindingRegistry, databaseCredentialRegistry, jobRegistry });
  const { withApplicationLock } = createSiteMutationLock({ root: path.join(directory, 'locks') });
  const auth = createAuthStore({ filePath: path.join(directory, 'auth.sqlite'), websiteLookup: websiteRegistry.getWebsite });
  t.after(() => auth.close());
  const ownerPassword = randomBytes(32).toString('base64url');
  await auth.completeSetup({ setupToken: auth.issueSetupToken().token, username: 'admin', password: ownerPassword });
  const authorizeActor = (actor, websiteId) => {
    const session = auth.getSessionById(actor.sessionId);
    return session?.user.id === actor.userId && session.user.role === actor.role
      && (actor.role === 'owner' || session.user.websiteIds.includes(websiteId));
  };
  const app = express();
  app.use(express.json());
  app.use(createSiteResourceBoundary({ websiteRegistry, databaseBindingRegistry, databaseCredentialRegistry, localServerId: server.id }));
  const dependencies = { registry: servers, websiteRegistry, databaseBindingRegistry, databaseCredentialRegistry, jobRegistry,
    ensureDatabaseIdle: databaseHttpInternals.ensureDatabaseIdle, withApplicationLock, authorizeActor };
  mountDatabaseBindingRoutes(app, { ...dependencies, requireDatabaseName: databaseHttpInternals.requireDatabaseName,
    latestDatabaseSnapshot: databaseHttpInternals.latestDatabaseSnapshot });
  mountDatabaseCredentialRoutes(app, { ...dependencies, databaseCredentialApplyService });
  app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({ error: { code: error.code } }));

  const origin = 'https://panel.database-metadata.example.test';
  const listener = createAuthenticatedApi({ store: auth, publicOrigin: origin, ownerMfaRequired: false, createHandler: () => app });
  const httpServer = http.createServer(listener).listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => new Promise((resolve) => { httpServer.close(resolve); httpServer.closeAllConnections(); }));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  async function send(url, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + url, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } });
    return { status: response.status, headers: response.headers, ...(await response.json()) };
  }
  async function client(username, password) {
    const login = await send('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await send('/api/auth/session', { headers: { cookie } });
    assert.equal(session.status, 200);
    return (url, method, body) => send(url, { method, body, headers: { cookie, 'x-csrf-token': session.data.csrfToken } });
  }
  async function manager(website, username) {
    const password = randomBytes(32).toString('base64url');
    await auth.users.createSiteManager({ username, password, websiteId: website.id });
    return client(username, password);
  }
  async function intent(website, name) {
    const binding = await databaseBindingRegistry.bindDatabase({ serverId: server.id, websiteId: website.id, databaseName: name,
      confirmation: `bind-database:${server.id}:${name}:${website.id}` });
    return {
      binding,
      url: `/api/servers/${server.id}/database-bindings/${binding.id}/credential`,
      body: { privileges: ['SELECT'], confirmation: `create-database-credential:${binding.id}:${databaseCredentialRegistryInternals.usernameFor(binding.id)}` },
    };
  }
  const [first, second, unused] = await Promise.all([
    intent(source, 'source_db'), intent(target, 'target_db'), intent(source, 'source_unbound'),
  ]);
  const ownerCall = await client('admin', ownerPassword);
  const firstCall = await manager(source, 'manager_a');
  const secondCall = await manager(target, 'manager_b');
  const unbindUrl = `/api/servers/${server.id}/database-bindings/${unused.binding.id}`;
  const unbind = { expectedRevision: unused.binding.revision, confirmation: `unbind-database:${unused.binding.id}:${unused.binding.revision}` };
  await withApplicationLock(source.applicationId, async () => {
    const blocked = await firstCall(first.url, 'POST', first.body);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.error.code, 'site_mutation_locked');
    assert.equal(await databaseCredentialRegistry.getForBinding(first.binding.id), null);
    assert.equal((await firstCall(second.url, 'POST', second.body)).status, 403);
    assert.equal((await secondCall(second.url, 'POST', second.body)).status, 201);
    assert.equal((await firstCall(first.url, 'GET')).status, 200);
    const unbindBlocked = await ownerCall(unbindUrl, 'DELETE', unbind);
    assert.equal(unbindBlocked.status, 409);
    assert.equal(unbindBlocked.error.code, 'site_mutation_locked');
    assert.equal((await databaseBindingRegistry.getBinding(unused.binding.id)).id, unused.binding.id);
  });
  assert.equal((await firstCall(first.url, 'POST', first.body)).status, 201);
  assert.equal((await ownerCall(unbindUrl, 'DELETE', unbind)).status, 200);
  assert.equal(await databaseBindingRegistry.getBinding(unused.binding.id), null);
  const stored = JSON.parse(await readFile(credentialFile, 'utf8'));
  assert.deepEqual(stored.credentials.map((value) => value.databaseBindingId).sort(), [first.binding.id, second.binding.id].sort());
});

test('the same Owner finalizes a credential delete from a new session while other actors stay conflicted', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-db-credential-delete-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const servers = createServerRegistry({ filePath: path.join(directory, 'servers.json') });
  const server = await servers.createLocalServer({ hostname: 'database-delete.example.test' });
  const serverExists = async (id) => Boolean(await servers.getServer(id));
  const applications = createApplicationRegistry({ filePath: path.join(directory, 'applications.json'), serverExists });
  const websiteRegistry = createWebsiteRegistry({ filePath: path.join(directory, 'websites.json'), serverExists,
    getApplication: applications.getApplication });
  async function createSite(name) {
    const application = await applications.createPhpApplication({ serverId: server.id, name });
    return websiteRegistry.createWebsite({ serverId: server.id, name, applicationId: application.id, runtimeType: 'php' });
  }
  const site = await createSite('site.database-delete.example.test');
  const otherSite = await createSite('other.database-delete.example.test');
  const databaseBindingRegistry = createDatabaseBindingRegistry({
    filePath: path.join(directory, 'bindings.json'), serverExists,
    getWebsite: websiteRegistry.getWebsite, getApplication: applications.getApplication,
  });
  const databaseCredentialRegistry = createDatabaseCredentialRegistry({
    filePath: path.join(directory, 'credentials.json'), masterKey: randomBytes(32).toString('hex'),
    getDatabaseBinding: databaseBindingRegistry.getBinding,
  });
  const jobRegistry = createJobRegistry({ filePath: path.join(directory, 'jobs.json') });
  const databaseCredentialApplyService = createDatabaseCredentialApplyService({ databaseBindingRegistry, databaseCredentialRegistry, jobRegistry });
  const { withApplicationLock } = createSiteMutationLock({ root: path.join(directory, 'locks') });
  const auth = createAuthStore({ filePath: path.join(directory, 'auth.sqlite'), websiteLookup: websiteRegistry.getWebsite });
  t.after(() => auth.close());
  const ownerPassword = randomBytes(32).toString('base64url');
  await auth.completeSetup({ setupToken: auth.issueSetupToken().token, username: 'admin', password: ownerPassword });
  const authorizeActor = (actor, websiteId) => {
    const session = auth.getSessionById(actor.sessionId);
    return session?.user.id === actor.userId && session.user.role === actor.role
      && (actor.role === 'owner' || session.user.websiteIds.includes(websiteId));
  };
  const app = express();
  app.use(express.json());
  app.use(createSiteResourceBoundary({ websiteRegistry, databaseBindingRegistry, databaseCredentialRegistry, localServerId: server.id }));
  mountDatabaseCredentialRoutes(app, { registry: servers, websiteRegistry, databaseBindingRegistry, databaseCredentialRegistry,
    databaseCredentialApplyService, jobRegistry, ensureDatabaseIdle: databaseHttpInternals.ensureDatabaseIdle,
    withApplicationLock, authorizeActor });
  app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({ error: { code: error.code } }));

  const origin = 'https://panel.database-delete.example.test';
  const listener = createAuthenticatedApi({ store: auth, publicOrigin: origin, ownerMfaRequired: false, createHandler: () => app });
  const httpServer = http.createServer(listener).listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => new Promise((resolve) => { httpServer.close(resolve); httpServer.closeAllConnections(); }));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  async function send(url, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + url, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } });
    const text = await response.text();
    return { status: response.status, ...(text ? JSON.parse(text) : {}) };
  }
  async function client(name, password) {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ username: name, password }),
      headers: { Origin: origin, 'Content-Type': 'application/json' } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await send('/api/auth/session', { headers: { cookie } });
    assert.equal(session.status, 200);
    return (url, method = 'GET', body = undefined) => send(url, { method, body,
      headers: { cookie, 'x-csrf-token': session.data.csrfToken } });
  }
  async function manager(website, name) {
    const password = randomBytes(32).toString('base64url');
    await auth.users.createSiteManager({ username: name, password, websiteId: website.id });
    return client(name, password);
  }

  const binding = await databaseBindingRegistry.bindDatabase({ serverId: server.id, websiteId: site.id, databaseName: 'site_db',
    confirmation: `bind-database:${server.id}:site_db:${site.id}` });
  const created = await databaseCredentialRegistry.createCredential({ databaseBindingId: binding.id, privileges: ['SELECT'],
    confirmation: `create-database-credential:${binding.id}:${databaseCredentialRegistryInternals.usernameFor(binding.id)}` });
  const credentialUrl = `/api/servers/${server.id}/database-credentials/${created.id}`;
  async function deleteRequest(call) {
    const preview = await call(`${credentialUrl}/delete-preview`);
    assert.equal(preview.status, 200);
    return {
      preview: preview.data,
      body: {
        expectedCredentialRevision: preview.data.expectedCredentialRevision,
        expectedBindingRevision: preview.data.expectedBindingRevision,
        expectedDesiredStateSha256: preview.data.desiredStateSha256,
        confirmation: preview.data.confirmation,
      },
    };
  }

  // Session A starts the host delete, the job succeeds, and A leaves before finalizing.
  const sessionA = await client('admin', ownerPassword);
  const first = await deleteRequest(sessionA);
  const queued = await sessionA(`${credentialUrl}/delete`, 'POST', first.body);
  assert.equal(queued.status, 202);
  const claimed = await jobRegistry.claimNext(server.id);
  assert.equal(claimed.job.id, queued.data.job.id);
  const succeeded = await jobRegistry.complete({ serverId: server.id, jobId: queued.data.job.id, status: 'succeeded', result: {
    version: 1,
    databaseCredentialId: created.id,
    databaseBindingId: binding.id,
    credentialRevision: first.preview.expectedCredentialRevision,
    bindingRevision: first.preview.expectedBindingRevision,
    databaseName: binding.databaseName,
    username: first.preview.username,
    host: first.preview.host,
    desiredStateSha256: first.preview.desiredStateSha256,
    deleted: true,
    sideEffects: true,
  } });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal((await sessionA('/api/auth/logout', 'POST')).status, 204);

  // Another Owner, a site manager of the same Website and a manager of another Website cannot reuse the job.
  const ownerTwoPassword = randomBytes(32).toString('base64url');
  const sessionB = await client('admin', ownerPassword);
  const ownerTwoCreated = await sessionB('/api/users', 'POST', { username: 'owner_two', password: ownerTwoPassword, role: 'owner' });
  assert.equal(ownerTwoCreated.status, 201);
  const ownerTwo = await client('owner_two', ownerTwoPassword);
  const ownerTwoAttempt = await ownerTwo(`${credentialUrl}/delete`, 'POST', (await deleteRequest(ownerTwo)).body);
  assert.equal(ownerTwoAttempt.status, 409);
  assert.equal(ownerTwoAttempt.error.code, 'job_authorization_conflict');
  const siteManager = await manager(site, 'site_manager_a');
  const siteManagerAttempt = await siteManager(`${credentialUrl}/delete`, 'POST', (await deleteRequest(siteManager)).body);
  assert.equal(siteManagerAttempt.status, 409);
  assert.equal(siteManagerAttempt.error.code, 'job_authorization_conflict');
  const otherManager = await manager(otherSite, 'site_manager_b');
  assert.equal((await otherManager(`${credentialUrl}/delete`, 'POST', first.body)).status, 403);

  // The same Owner in a new session receives the finished job and finalizes it.
  const second = await deleteRequest(sessionB);
  assert.deepEqual(second.body, first.body);
  const resumed = await sessionB(`${credentialUrl}/delete`, 'POST', second.body);
  assert.equal(resumed.status, 202, JSON.stringify(resumed.error ?? null));
  assert.equal(resumed.data.job.id, queued.data.job.id);
  assert.equal(resumed.data.job.status, 'succeeded');
  const finalized = await sessionB(credentialUrl, 'DELETE', {
    expectedRevision: first.preview.expectedCredentialRevision,
    deleteJobId: resumed.data.job.id,
    confirmation: `finalize-database-credential-delete:${created.id}:${first.preview.expectedCredentialRevision}:${resumed.data.job.id}`,
  });
  assert.equal(finalized.status, 200);
  assert.equal(finalized.data.finalizedFromJobId, queued.data.job.id);
  assert.equal(await databaseCredentialRegistry.getCredential(created.id), null);
});

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
