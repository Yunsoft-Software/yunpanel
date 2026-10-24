import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createAuditStore } from '../src/audit-store.js';
import { once } from 'node:events';
import express from 'express';
import { createDatabaseBindingRegistry } from '../src/database-binding-registry.js';
import { createDatabaseCredentialRegistry } from '../src/database-credential-registry.js';
import { createDatabaseCredentialApplyService } from '../src/database-credential-apply-service.js';
import { createJobRegistry } from '../src/job-registry.js';
import { mountDatabaseSetupRoutes } from '../src/database-setup-http.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const applicationId = '32345678-1234-4234-8234-123456789012';
const base = `/api/servers/${serverId}/websites/${websiteId}/databases`;
async function fixture(t, { existing = [], role = 'owner', allowed = true } = {}) {
  const website = { id: websiteId, serverId, applicationId, unixUser: 'yunapp-abcdef123456', runtimeType: 'php', revision: 1 };
  const registry = { getServer: async (id) => id === serverId ? { id } : null };
  const websiteRegistry = { getWebsite: async (id) => id === websiteId ? website : null };
  const bindings = createDatabaseBindingRegistry({ serverExists: async () => true, getWebsite: websiteRegistry.getWebsite,
    getApplication: async (id) => ({ id, serverId, type: 'php' }) });
  await bindings.init();
  const credentials = createDatabaseCredentialRegistry({ masterKey: Buffer.alloc(32, 11), getDatabaseBinding: bindings.getBinding });
  await credentials.init();
  const jobs = createJobRegistry(); await jobs.init();
  const apply = createDatabaseCredentialApplyService({ databaseBindingRegistry: bindings, databaseCredentialRegistry: credentials, jobRegistry: jobs });
  const audit = []; const auditDb = new DatabaseSync(':memory:'); const nativeAudit = createAuditStore({ db: auditDb }); t.after(() => auditDb.close()); let live = true;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.auth = { id: 'test-session', user: { id: 'test-user', role, websiteIds: allowed ? [websiteId] : [] },
    access: { mode: role === 'owner' ? 'management' : 'site_management', permissions: ['*'] }, security: { managementAllowed: true } }; next(); });
  mountDatabaseSetupRoutes(app, { registry, websiteRegistry, databaseBindingRegistry: bindings, databaseCredentialRegistry: credentials,
    databaseCredentialApplyService: apply, databaseInventoryProvider: async () => ({ databases: existing.map((name) => ({ name })) }),
    siteMutationLock: { withApplicationLock: async (_id, action) => action() },
    auditStore: { record: async (entry) => { const saved = nativeAudit.record(entry); audit.push(saved); } }, authorizeActor: async () => live ? { valid: true } : null });
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: { code: error.code } }));
  const server = http.createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const post = (suffix, body) => fetch(`http://127.0.0.1:${server.address().port}${base}${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { post, bindings, credentials, jobs, audit, revoke: () => { live = false; } };
}
const input = (changes = {}) => ({ databaseName: 'example_db', mode: 'create', expectedWebsiteRevision: 1, ...changes });

test('one setup submission binds site, encrypts chosen password and queues a secret-free durable job', async (t) => {
  const f = await fixture(t), password = 'SelectedTestPassword_123!';
  const response = await f.post('', input({ password })); assert.equal(response.status, 202);
  const { data } = await response.json();
  assert.equal(data.binding.websiteId, websiteId); assert.equal(data.credential.passwordConfigured, true);
  assert.equal(JSON.stringify(data).includes(password), false);
  const claimed = await f.jobs.claimNext(serverId);
  const context = { payload: claimed.envelope.payload, authorization: claimed.authorization };
  assert.equal(context.payload.createDatabase, true); assert.equal(context.authorization.sessionId, 'test-session');
  assert.equal(context.authorization.websiteId, websiteId); assert.equal(JSON.stringify(context).includes(password), false);
  assert.equal((await f.credentials.materializeCredential(data.credential.id, { expectedRevision: 1 })).password, password);
});
test('binding existing schema queues grants without creating another schema', async (t) => {
  const f = await fixture(t, { existing: ['example_db'] });
  const response = await f.post('', input({ mode: 'bind' })); assert.equal(response.status, 202);
  const { data } = await response.json(); assert.ok(data.job.id); const claimed = await f.jobs.claimNext(serverId); const context = { payload: claimed.envelope.payload };
  assert.equal(Object.hasOwn(context.payload, 'createDatabase'), false);
});
test('invalid input and stale Website revision create no binding or credential', async (t) => {
  const f = await fixture(t);
  for (const body of [input({ databaseName: 'mysql' }), input({ password: 'short' }), input({ databaseName: 'a;DROP' })]) assert.equal((await f.post('', body)).status, 400);
  assert.equal((await f.post('', input({ expectedWebsiteRevision: 2 }))).status, 409);
  assert.deepEqual(await f.bindings.listBindings(), []); assert.deepEqual(await f.credentials.listCredentials(), []);
});
test('site manager cannot use an unassigned site or claim an existing unbound schema', async (t) => {
  const denied = await fixture(t, { role: 'site_manager', allowed: false });
  assert.equal((await denied.post('', input())).status, 403);
  const own = await fixture(t, { role: 'site_manager', existing: ['example_db'] });
  assert.equal((await own.post('', input({ mode: 'bind' }))).status, 403);
  assert.deepEqual(await own.bindings.listBindings(), []);
});
test('connection password requires explicit access, audit and a current live session', async (t) => {
  const f = await fixture(t), response = await f.post('', input()); const { data } = await response.json();
  const suffix = `/${data.binding.id}/connection`;
  const safe = await f.post(suffix, { revealPassword: false }); assert.equal(safe.headers.get('cache-control'), 'no-store');
  assert.equal((await safe.json()).data.password, null); assert.equal(f.audit.length, 0);
  const revealed = await f.post(suffix, { revealPassword: true }); assert.equal(revealed.status, 200);
  const secret = (await revealed.json()).data.password; assert.equal(typeof secret, 'string');
  assert.equal(f.audit.length, 1); assert.equal(JSON.stringify(f.audit).includes(secret), false);
  f.revoke(); assert.equal((await f.post(suffix, { revealPassword: true })).status, 403);
});
