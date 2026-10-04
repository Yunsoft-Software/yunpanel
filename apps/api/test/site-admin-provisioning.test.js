import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { provisionSiteAdmin } from '../src/site-admin-provisioning.js';
import {
  extractActorTenant,
  assertWebsiteBelongsToTenant,
  assertEntityTenantBoundary,
  sanitizeTenantCollection,
  createTenantBoundaryMiddleware,
} from '../src/tenant-boundary.js';

const websiteId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const serverId = '44444444-4444-4444-8444-444444444444';
const input = () => ({ operationId, serverId, siteAdmin: { email: ' Admin@Example.test ', password: 'fixture-password-only' } });
const result = () => ({ created: true, resumed: false, operationId, website: { id: websiteId, serverId }, primaryDomain: { websiteId } });
const user = () => ({ id: userId, username: 'admin@example.test', role: 'site_manager', active: true, websiteIds: [websiteId] });
function options(extra = {}) { return { input: input(), result: result(), actorId: 'owner-id', userAdminStore: { createSiteManager: async () => user() }, ...extra }; }
const attention = (code) => ({ status: 'attention', websiteId, code });

test('awaits account completion and passes the actual username/actorId store contract', async () => {
  let resolve; let called; let done = false;
  const promise = provisionSiteAdmin(options({ userAdminStore: { createSiteManager: (value) => {
    called = value; return new Promise((complete) => { resolve = complete; });
  } } })).then((value) => { done = true; return value; });
  await new Promise(setImmediate); assert.equal(done, false);
  assert.deepEqual(called, { username: 'admin@example.test', password: 'fixture-password-only', websiteId, actorId: 'owner-id' });
  resolve(user());
  assert.deepEqual(await promise, { status: 'created', websiteId, code: null });
});

test('unrequested account never accesses the user store', async () => {
  assert.deepEqual(await provisionSiteAdmin(options({ input: { operationId, serverId }, userAdminStore: {
    createSiteManager: () => { throw new Error('must not run'); },
  } })), { status: 'not_requested', websiteId, code: null });
});

for (const patch of [{ created: false }, { resumed: true }, { created: undefined }]) {
  test(`replayed or unverified creation never recreates, resets or reassigns an account: ${JSON.stringify(patch)}`, async () => {
    let calls = 0;
    const actual = await provisionSiteAdmin(options({ result: { ...result(), ...patch }, userAdminStore: { createSiteManager: () => { calls++; } } }));
    assert.deepEqual(actual, attention('site_admin_replay_requires_review'));
    assert.equal(calls, 0);
  });
}

for (const [errorCode, code] of [
  ['username_taken', 'site_admin_conflict'], ['operation_user_conflict', 'site_admin_conflict'],
  ['invalid_password', 'site_admin_input_invalid'], ['auth_busy', 'site_admin_busy'],
  ['website_not_found', 'site_admin_website_deleted'], ['forbidden', 'site_admin_actor_forbidden'],
  ['auth_store_locked', 'site_admin_locked'], ['store_locked', 'site_admin_locked'],
  ['SQLITE_IOERR', 'site_admin_result_unverified'], ['__proto__', 'site_admin_result_unverified'],
]) {
  test(`async rejection ${errorCode} is awaited and projected without raw error or credentials`, async () => {
    const value = await provisionSiteAdmin(options({ userAdminStore: { createSiteManager: async () => {
      throw Object.assign(new Error('fixture-password-only / private failure'), { code: errorCode });
    } } }));
    assert.deepEqual(value, attention(code));
    assert.equal(JSON.stringify(value).includes('private'), false);
  });
}

test('synchronous store throws are also contained without claiming account success', async () => {
  const value = await provisionSiteAdmin(options({ userAdminStore: { createSiteManager: () => { throw new Error('private'); } } }));
  assert.deepEqual(value, attention('site_admin_result_unverified'));
});

for (const bad of [null, {}, { ...user(), role: 'owner' }, { ...user(), active: false },
  { ...user(), websiteIds: [serverId] }, { ...user(), websiteIds: [websiteId, serverId] },
  { ...user(), username: 'someone-else@example.test' }, { ...user(), id: '' }]) {
  test(`unverified account projection cannot become successful: ${JSON.stringify(bad)}`, async () => {
    assert.deepEqual(await provisionSiteAdmin(options({ userAdminStore: { createSiteManager: async () => bad } })), attention('site_admin_result_unverified'));
  });
}

test('missing dependency and actor stay visible, never falling back to a system principal', async () => {
  assert.deepEqual(await provisionSiteAdmin(options({ userAdminStore: null })), attention('site_admin_unavailable'));
  assert.deepEqual(await provisionSiteAdmin(options({ actorId: undefined })), attention('site_admin_actor_unavailable'));
});

test('malformed account input and wrong site binding cannot invoke a write', async () => {
  let calls = 0;
  const store = { createSiteManager: () => { calls++; } };
  for (const siteAdmin of [{}, [], { email: 'bad/name', password: 'fixture' }, { email: 'admin@example.test' }]) {
    const value = await provisionSiteAdmin(options({ input: { ...input(), siteAdmin }, userAdminStore: store }));
    assert.equal(value.status, 'attention');
  }
  for (const patch of [{ operationId: userId }, { website: { id: websiteId, serverId: userId } }, { primaryDomain: { websiteId: serverId } }]) {
    const value = await provisionSiteAdmin(options({ result: { ...result(), ...patch }, userAdminStore: store }));
    assert.equal(value.status, 'attention');
  }
  assert.equal(calls, 0);
});

test('successful public outcome contains only bounded status and site identity', async () => {
  const value = await provisionSiteAdmin(options({ userAdminStore: { createSiteManager: async () => ({ ...user(), passwordHash: 'private-hash', password: 'private-password' }) } }));
  assert.deepEqual(Object.keys(value), ['status', 'websiteId', 'code']);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(JSON.stringify(value).includes('private'), false);
});

function createRealStoreFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-site-admin-test-'));
  const filePath = path.join(root, 'private', 'auth.sqlite');
  const store = createAuthStore({ filePath });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, filePath, root };
}

test('Gerçek kullanıcı deposunda hesap yaratılmasını bekle; normalize kullanıcı adı, actorId audit\'i, site_manager rolü, aktiflik ve yalnız beklenen Website bağı doğrulansın. Yeni hesapla gerçek giriş ve Site A→Site B erişim reddi denensin.', async (t) => {
  const { store, filePath } = createRealStoreFixture(t);

  // Setup owner
  const { token: setupToken } = store.issueSetupToken();
  const ownerUser = await store.completeSetup({
    setupToken,
    username: 'OwnerAdmin',
    password: 'OwnerPassword123!',
  });
  assert.equal(ownerUser.username, 'owneradmin');

  const siteAWebsiteId = '11111111-aaaa-4111-8111-aaaaaaaaaaaa';
  const siteBWebsiteId = '22222222-bbbb-4222-8222-bbbbbbbbbbbb';
  const serverId = '33333333-cccc-4333-8333-cccccccccccc';
  const siteAOpId = '44444444-aaaa-4444-8444-aaaaaaaaaaaa';
  const siteBOpId = '55555555-bbbb-4555-8555-bbbbbbbbbbbb';
  const siteAPassword = 'SiteManagerPassA123!';
  const siteBPassword = 'SiteManagerPassB123!';

  // Input with unnormalized email (spaces and uppercase)
  const inputA = {
    operationId: siteAOpId,
    serverId,
    siteAdmin: {
      email: '  Admin.SiteA@Example.COM  ',
      password: siteAPassword,
    },
  };
  const resultA = {
    created: true,
    resumed: false,
    operationId: siteAOpId,
    website: { id: siteAWebsiteId, serverId },
    primaryDomain: { websiteId: siteAWebsiteId },
  };

  // 1. Wait for account creation in real user store (store.users)
  const provisionResultA = await provisionSiteAdmin({
    input: inputA,
    result: resultA,
    userAdminStore: store.users,
    actorId: ownerUser.id,
  });

  assert.deepEqual(provisionResultA, { status: 'created', websiteId: siteAWebsiteId, code: null });

  // 2. Direct database verification in SQLite
  const db = new DatabaseSync(filePath);
  let userARow;
  try {
    userARow = db.prepare('SELECT * FROM users WHERE username = ?').get('admin.sitea@example.com');
    assert.ok(userARow, 'User must be persisted in SQLite users table');
    assert.equal(userARow.username, 'admin.sitea@example.com', 'Username must be normalized (lowercased and trimmed)');
    assert.equal(userARow.role, 'site_manager', 'Role must be site_manager');
    assert.equal(userARow.active, 1, 'Account must be active');
    assert.match(userARow.password_hash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/, 'Password hash must be Argon2id');

    // Only expected website binding
    const websiteRows = db.prepare('SELECT website_id FROM auth_user_websites WHERE user_id = ?').all(userARow.id);
    assert.equal(websiteRows.length, 1, 'Site manager must have exactly 1 website binding');
    assert.equal(websiteRows[0].website_id, siteAWebsiteId, 'Website binding must match only expected Website A ID');

    // ActorId audit trace in auth_events
    const eventRows = db.prepare('SELECT * FROM auth_events WHERE actor_id = ? AND action = ?').all(ownerUser.id, 'user.created');
    assert.ok(eventRows.length >= 1, 'auth_events must record user.created with owner actorId');

    // ActorId audit trace in audit store
    const auditLogs = store.audit.list({ actorId: ownerUser.id, action: 'user.created' });
    const userCreatedAudit = auditLogs.events.find((e) => e.resourceId === userARow.id);
    assert.ok(userCreatedAudit, 'Audit log must record user creation');
    assert.equal(userCreatedAudit.actorId, ownerUser.id, 'actorId audit must match the creator');
    assert.equal(userCreatedAudit.action, 'user.created');
    assert.equal(userCreatedAudit.resourceType, 'user');
    assert.equal(userCreatedAudit.outcome, 'succeeded');
  } finally {
    db.close();
  }

  // 3. Real login with new site manager credentials
  const loginA = await store.login({
    username: '  Admin.SiteA@example.com  ',
    password: siteAPassword,
  });
  assert.ok(loginA.token, 'Login must yield a valid session token');
  assert.ok(loginA.session, 'Login must yield session');
  assert.equal(loginA.session.user.id, userARow.id);
  assert.equal(loginA.session.user.username, 'admin.sitea@example.com');
  assert.equal(loginA.session.user.role, 'site_manager');
  assert.deepEqual(loginA.session.user.websiteIds, [siteAWebsiteId]);

  // Login audit trace verification
  const loginAuditLogs = store.audit.list({ actorId: loginA.session.user.id, action: 'login.succeeded' });
  assert.ok(loginAuditLogs.events.length >= 1, 'Audit log must record login.succeeded with site manager actorId');
  assert.equal(loginAuditLogs.events[0].actorId, loginA.session.user.id);
  assert.equal(loginAuditLogs.events[0].outcome, 'succeeded');

  // Negative login test with wrong password
  await assert.rejects(
    store.login({ username: 'admin.sitea@example.com', password: 'WrongPassword!' }),
    { code: 'invalid_credentials', status: 401 },
  );

  // 4. Provision Site B manager
  const provisionResultB = await provisionSiteAdmin({
    input: {
      operationId: siteBOpId,
      serverId,
      siteAdmin: { email: '  Admin.SiteB@Example.COM  ', password: siteBPassword },
    },
    result: {
      created: true,
      resumed: false,
      operationId: siteBOpId,
      website: { id: siteBWebsiteId, serverId },
      primaryDomain: { websiteId: siteBWebsiteId },
    },
    userAdminStore: store.users,
    actorId: ownerUser.id,
  });
  assert.deepEqual(provisionResultB, { status: 'created', websiteId: siteBWebsiteId, code: null });

  const loginB = await store.login({ username: 'admin.siteb@example.com', password: siteBPassword });
  assert.ok(loginB.session);
  assert.deepEqual(loginB.session.user.websiteIds, [siteBWebsiteId]);

  // 5. Tenant Boundary & Cross-Tenant Fail-Closed Isolation (Site A -> Site B)
  const actorA = extractActorTenant(loginA.session);
  const actorB = extractActorTenant(loginB.session);
  assert.equal(actorA.isLegacySiteManager, true);
  assert.equal(actorB.isLegacySiteManager, true);
  assert.deepEqual(actorA.websiteIds, [siteAWebsiteId]);
  assert.deepEqual(actorB.websiteIds, [siteBWebsiteId]);

  // Direct tenant assertion: Site A manager accessing Site A is allowed; accessing Site B is denied (403)
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: actorA, website: { id: siteAWebsiteId } }));
  assert.throws(
    () => assertWebsiteBelongsToTenant({ actor: actorA, website: { id: siteBWebsiteId } }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // Site B manager accessing Site B is allowed; accessing Site A is denied (403)
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: actorB, website: { id: siteBWebsiteId } }));
  assert.throws(
    () => assertWebsiteBelongsToTenant({ actor: actorB, website: { id: siteAWebsiteId } }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // Entity tenant boundary across resource types
  for (const entityType of ['website', 'domain', 'database', 'maildomain', 'mailbox', 'job']) {
    assert.doesNotThrow(() => assertEntityTenantBoundary({ actor: actorA, entityType, websiteId: siteAWebsiteId }));
    assert.throws(
      () => assertEntityTenantBoundary({ actor: actorA, entityType, websiteId: siteBWebsiteId }),
      (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
    );
  }

  // Tenant collection sanitization: only Site A returned for Actor A, no Site B metadata leakage
  const allWebsites = [
    { id: siteAWebsiteId, websiteId: siteAWebsiteId, entityType: 'website', name: 'Site A', secretKey: 'site-a-secret' },
    { id: siteBWebsiteId, websiteId: siteBWebsiteId, entityType: 'website', name: 'Site B', secretKey: 'site-b-secret' },
    { id: 'foreign-id', websiteId: 'foreign-id', entityType: 'website', name: 'Foreign', secretKey: 'foreign-secret' },
  ];
  const sanitizedForA = sanitizeTenantCollection(allWebsites, actorA);
  assert.deepEqual(sanitizedForA, [{ id: siteAWebsiteId, websiteId: siteAWebsiteId, entityType: 'website', name: 'Site A', secretKey: 'site-a-secret' }]);
  assert.equal(JSON.stringify(sanitizedForA).includes(siteBWebsiteId), false);

  const sanitizedForB = sanitizeTenantCollection(allWebsites, actorB);
  assert.deepEqual(sanitizedForB, [{ id: siteBWebsiteId, websiteId: siteBWebsiteId, entityType: 'website', name: 'Site B', secretKey: 'site-b-secret' }]);
  assert.equal(JSON.stringify(sanitizedForB).includes(siteAWebsiteId), false);

  // 6. HTTP Middleware Enforcement
  const websiteMap = {
    [siteAWebsiteId]: { id: siteAWebsiteId, serverId },
    [siteBWebsiteId]: { id: siteBWebsiteId, serverId },
  };
  const middleware = createTenantBoundaryMiddleware({
    websiteLookup: async (id) => websiteMap[id] ?? null,
  });

  const runHttp = async (actor, url, { method = 'GET', body = null } = {}) => {
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    let called = false;
    let statusCode = 200;
    let responseBody = null;
    const headers = {};
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader(k, v) { headers[k] = v; },
      json(b) { responseBody = b; return this; },
    };
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody, headers };
  };

  const assertDeniedNoLeak = (res, leakedTokens = []) => {
    assert.equal(res.called, false);
    assert.ok(res.statusCode === 403 || res.statusCode === 404);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    const bodyStr = JSON.stringify(res.responseBody ?? {});
    for (const token of leakedTokens) {
      assert.equal(bodyStr.includes(token), false, `Response leaked: ${token}`);
    }
  };

  // Site A allowed on Site A endpoints
  assert.equal((await runHttp(actorA, `/api/websites/${siteAWebsiteId}`)).called, true);
  assert.equal((await runHttp(actorA, `/api/servers/${serverId}/websites/${siteAWebsiteId}`)).called, true);
  assert.equal((await runHttp(actorA, '/api/terminal/capabilities', { method: 'POST', body: { scope: 'site', websiteId: siteAWebsiteId } })).called, true);
  assert.equal((await runHttp(actorA, '/api/domains', { method: 'POST', body: { websiteId: siteAWebsiteId } })).called, true);

  // Site A DENIED on Site B endpoints (403 fail-closed, no data leakage)
  const leakTokens = [siteBWebsiteId, 'Site B', 'admin.siteb@example.com'];
  assertDeniedNoLeak(await runHttp(actorA, `/api/websites/${siteBWebsiteId}`), leakTokens);
  assertDeniedNoLeak(await runHttp(actorA, `/api/servers/${serverId}/websites/${siteBWebsiteId}`), leakTokens);
  assertDeniedNoLeak(await runHttp(actorA, '/api/terminal/capabilities', { method: 'POST', body: { scope: 'site', websiteId: siteBWebsiteId } }), leakTokens);
  assertDeniedNoLeak(await runHttp(actorA, '/api/domains', { method: 'POST', body: { websiteId: siteBWebsiteId } }), leakTokens);

  // Privileged endpoints: denied for site manager
  assertDeniedNoLeak(await runHttp(actorA, '/api/terminal/capabilities', { method: 'POST', body: { scope: 'server', serverId } }));
  assertDeniedNoLeak(await runHttp(actorA, '/api/audit'));
  assertDeniedNoLeak(await runHttp(actorA, '/api/customers'));
  assertDeniedNoLeak(await runHttp(actorA, '/api/users'));
  assertDeniedNoLeak(await runHttp(actorA, '/api/settings'));
  assertDeniedNoLeak(await runHttp(actorA, '/api/backups'));

  // 7. Real HTTP Stack test with createAuthenticatedApi
  const app = express();
  app.use(createTenantBoundaryMiddleware({
    websiteLookup: async (id) => websiteMap[id] ?? null,
  }));
  app.get('/api/websites/:websiteId', (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json({ data: { websiteId: req.params.websiteId } });
  });
  app.use((err, req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    res.status(err.status ?? 500).json({ error: { code: err.code ?? 'error', message: err.message } });
  });

  const apiHandler = createAuthenticatedApi({
    store,
    publicOrigin: 'http://127.0.0.1',
    development: true,
    ownerMfaRequired: false,
    createHandler: () => app,
  });

  const server = http.createServer(apiHandler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const port = server.address().port;

  // Site A manager requests own site: 200 OK
  const ownRes = await fetch(`http://127.0.0.1:${port}/api/websites/${siteAWebsiteId}`, {
    headers: { cookie: `yunpanel_session=${loginA.token}` },
  });
  assert.equal(ownRes.status, 200);
  const ownData = await ownRes.json();
  assert.equal(ownData.data?.websiteId, siteAWebsiteId);

  // Site A manager requests Site B: 403 Forbidden fail-closed
  const foreignRes = await fetch(`http://127.0.0.1:${port}/api/websites/${siteBWebsiteId}`, {
    headers: { cookie: `yunpanel_session=${loginA.token}` },
  });
  assert.equal(foreignRes.status, 403);
  assert.equal(foreignRes.headers.get('cache-control'), 'no-store');
  const foreignData = await foreignRes.json();
  assert.equal(foreignData.error?.code, 'tenant_boundary_forbidden');
  assert.equal(JSON.stringify(foreignData).includes(siteBWebsiteId), false);

  // 8. Inactive account enforcement
  const dbAdmin = new DatabaseSync(filePath);
  try {
    dbAdmin.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userARow.id);
  } finally {
    dbAdmin.close();
  }

  // Login fails
  await assert.rejects(
    store.login({ username: 'admin.sitea@example.com', password: siteAPassword }),
    { code: 'invalid_credentials', status: 401 },
  );

  // Session token revoked immediately
  assert.equal(store.getSession(loginA.token), null);

  // HTTP request with revoked token fails 401
  const revokedRes = await fetch(`http://127.0.0.1:${port}/api/websites/${siteAWebsiteId}`, {
    headers: { cookie: `yunpanel_session=${loginA.token}` },
  });
  assert.equal(revokedRes.status, 401);
});
