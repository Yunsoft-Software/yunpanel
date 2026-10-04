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
import { mountSiteCreateRoutes } from '../src/site-create-http.js';
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

test('Hash sırasında yetki iptali/Website silme, iki süreç yarışı ve hesap sonrası provisioning registry yazma hatalarını test et. Atomik yetki/kilit ve kalıcı sonuç kaydı', async (t) => {
  const { store, filePath } = createRealStoreFixture(t);

  // Setup owner
  const { token: setupToken } = store.issueSetupToken();
  const ownerUser = await store.completeSetup({
    setupToken,
    username: 'SecurityOwner',
    password: 'OwnerPassword123!',
  });
  const ownerLogin = await store.login({
    username: 'SecurityOwner',
    password: 'OwnerPassword123!',
  });
  const rawToken = ownerLogin.token;

  const targetWebsiteId = '11111111-2222-4333-8444-555555555555';
  const serverId = '66666666-7777-4888-8999-000000000000';
  let websiteExists = true;
  let onNextHash = null;
  const dynamicWebsiteLookup = async (id) => {
    if (id !== targetWebsiteId || !websiteExists) return null;
    if (onNextHash) {
      const cb = onNextHash;
      onNextHash = null;
      setImmediate(cb);
    }
    return { id, serverId };
  };

  // -------------------------------------------------------------------------
  // 1. Hash hesaplama sırasında yetki iptali (fail-closed, yetkisiz kayıt yok)
  // -------------------------------------------------------------------------
  {
    // A) rawToken ile oturum iptali (session revoked during password hashing)
    const revokeOpId = '77777777-1111-4111-8111-111111111111';
    const revokeInput = {
      operationId: revokeOpId,
      serverId,
      siteAdmin: { email: 'revoked-session@example.test', password: 'ValidPassword123!' },
    };
    const revokeResult = {
      created: true,
      resumed: false,
      operationId: revokeOpId,
      website: { id: targetWebsiteId, serverId },
      primaryDomain: { websiteId: targetWebsiteId },
    };

    const tempSession = (await store.login({ username: 'SecurityOwner', password: 'OwnerPassword123!' })).token;
    onNextHash = () => {
      store.revokeSession(tempSession);
    };

    const outcomeA = await provisionSiteAdmin({
      input: revokeInput,
      result: revokeResult,
      userAdminStore: store.users,
      actorId: ownerUser.id,
      rawToken: tempSession,
      requireManagement: (s) => s,
      websiteLookup: dynamicWebsiteLookup,
    });

    assert.deepEqual(outcomeA, { status: 'attention', websiteId: targetWebsiteId, code: 'site_admin_actor_forbidden' });

    const db = new DatabaseSync(filePath);
    try {
      const row = db.prepare('SELECT * FROM users WHERE username = ?').get('revoked-session@example.test');
      assert.equal(row, undefined, 'No user record must be created when session is revoked during hash');
      const opRow = db.prepare('SELECT * FROM auth_operation_users WHERE operation_id = ?').get(revokeOpId);
      assert.equal(opRow, undefined, 'No auth_operation_users entry must exist');
    } finally {
      db.close();
    }

    // B) actorId ile kullanıcı deaktive edilmesi (actor deactivated during password hashing)
    const deactOpId = '77777777-2222-4222-8222-222222222222';
    const deactInput = {
      operationId: deactOpId,
      serverId,
      siteAdmin: { email: 'deact-actor@example.test', password: 'ValidPassword123!' },
    };
    const deactResult = {
      created: true,
      resumed: false,
      operationId: deactOpId,
      website: { id: targetWebsiteId, serverId },
      primaryDomain: { websiteId: targetWebsiteId },
    };

    onNextHash = () => {
      const dbDeact = new DatabaseSync(filePath);
      dbDeact.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ownerUser.id);
      dbDeact.close();
    };

    const outcomeB = await provisionSiteAdmin({
      input: deactInput,
      result: deactResult,
      userAdminStore: store.users,
      actorId: ownerUser.id,
      websiteLookup: dynamicWebsiteLookup,
    });

    assert.deepEqual(outcomeB, { status: 'attention', websiteId: targetWebsiteId, code: 'site_admin_actor_forbidden' });

    const dbCheckB = new DatabaseSync(filePath);
    try {
      const row = dbCheckB.prepare('SELECT * FROM users WHERE username = ?').get('deact-actor@example.test');
      assert.equal(row, undefined, 'No user record must be created when actor is deactivated during hash');
    } finally {
      dbCheckB.prepare('UPDATE users SET active = 1 WHERE id = ?').run(ownerUser.id);
      dbCheckB.close();
    }
  }

  // -------------------------------------------------------------------------
  // 2. Hash hesaplama sırasında Website silme (fail-closed, yetkisiz kayıt yok)
  // -------------------------------------------------------------------------
  {
    const deleteOpId = '88888888-1111-4111-8111-111111111111';
    const deleteInput = {
      operationId: deleteOpId,
      serverId,
      siteAdmin: { email: 'deleted-site@example.test', password: 'ValidPassword123!' },
    };
    const deleteResult = {
      created: true,
      resumed: false,
      operationId: deleteOpId,
      website: { id: targetWebsiteId, serverId },
      primaryDomain: { websiteId: targetWebsiteId },
    };

    websiteExists = true;
    onNextHash = () => {
      websiteExists = false;
    };

    const outcomeDelete = await provisionSiteAdmin({
      input: deleteInput,
      result: deleteResult,
      userAdminStore: store.users,
      actorId: ownerUser.id,
      websiteLookup: dynamicWebsiteLookup,
    });

    assert.deepEqual(outcomeDelete, { status: 'attention', websiteId: targetWebsiteId, code: 'site_admin_website_deleted' });

    const db = new DatabaseSync(filePath);
    try {
      const row = db.prepare('SELECT * FROM users WHERE username = ?').get('deleted-site@example.test');
      assert.equal(row, undefined, 'No user record must be created when website is removed during hash');
      const binding = db.prepare('SELECT * FROM auth_user_websites WHERE website_id = ?').all(targetWebsiteId);
      assert.equal(binding.length, 0, 'No website binding must be created');
      const opRow = db.prepare('SELECT * FROM auth_operation_users WHERE operation_id = ?').get(deleteOpId);
      assert.equal(opRow, undefined, 'No auth_operation_users entry must exist');
    } finally {
      db.close();
      websiteExists = true;
    }
  }

  // -------------------------------------------------------------------------
  // 3. İki eşzamanlı süreç yarışı (Race condition: atomik yetki ve kilit)
  // -------------------------------------------------------------------------
  {
    // A) Aynı kullanıcı adı için iki eşzamanlı süreç yarışı
    const raceUsername = 'concurrent-race@example.test';
    const site1 = '11111111-aaaa-4111-8111-111111111111';
    const site2 = '22222222-bbbb-4222-8222-222222222222';
    const raceOp1 = 'aaaaaaaa-1111-4111-8111-111111111111';
    const raceOp2 = 'bbbbbbbb-2222-4222-8222-222222222222';

    const [call1, call2] = await Promise.allSettled([
      store.users.createSiteManager({
        username: raceUsername,
        password: 'ValidPassword123!',
        websiteId: site1,
        actorId: ownerUser.id,
        operationId: raceOp1,
      }),
      store.users.createSiteManager({
        username: raceUsername,
        password: 'ValidPassword123!',
        websiteId: site2,
        actorId: ownerUser.id,
        operationId: raceOp2,
      }),
    ]);

    const fulfilled = [call1, call2].filter((c) => c.status === 'fulfilled');
    const rejected = [call1, call2].filter((c) => c.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'Exactly one concurrent call must succeed');
    assert.equal(rejected.length, 1, 'Exactly one concurrent call must be rejected');
    assert.equal(rejected[0].reason?.code, 'username_taken');
    assert.equal(rejected[0].reason?.status, 409);

    const db = new DatabaseSync(filePath);
    try {
      const userCount = db.prepare('SELECT count(*) as count FROM users WHERE username = ?').get(raceUsername);
      assert.equal(userCount.count, 1, 'Database must contain exactly 1 user with race username');
    } finally {
      db.close();
    }

    // B) Aynı operationId için iki eşzamanlı süreç yarışı (idempotent race)
    const idempotentOpId = 'cccccccc-3333-4333-8333-333333333333';
    const idemUsername = 'idempotent-race@example.test';
    const idemSiteId = '33333333-cccc-4333-8333-333333333333';

    const [idem1, idem2] = await Promise.all([
      store.users.createSiteManager({
        username: idemUsername,
        password: 'ValidPassword123!',
        websiteId: idemSiteId,
        actorId: ownerUser.id,
        operationId: idempotentOpId,
      }),
      store.users.createSiteManager({
        username: idemUsername,
        password: 'ValidPassword123!',
        websiteId: idemSiteId,
        actorId: ownerUser.id,
        operationId: idempotentOpId,
      }),
    ]);

    assert.equal(idem1.id, idem2.id, 'Both concurrent calls with same operationId must return the exact same user');
    assert.equal(idem1.username, idemUsername);

    const dbIdem = new DatabaseSync(filePath);
    try {
      const opCount = dbIdem.prepare('SELECT count(*) as count FROM auth_operation_users WHERE operation_id = ?').get(idempotentOpId);
      assert.equal(opCount.count, 1, 'Exactly 1 operation user row must be stored');
      const userCount = dbIdem.prepare('SELECT count(*) as count FROM users WHERE username = ?').get(idemUsername);
      assert.equal(userCount.count, 1, 'Exactly 1 user must exist');
    } finally {
      dbIdem.close();
    }
  }

  // -------------------------------------------------------------------------
  // 4. Hesap sonrası provisioning registry yazma hatalarında atomik kilit ve kalıcı sonuç kaydı
  // -------------------------------------------------------------------------
  {
    const provSiteId = '44444444-dddd-4444-8444-444444444444';
    const provOpId = 'dddddddd-4444-4444-8444-444444444444';
    const provUsername = 'prov-fail-admin@example.test';
    const provPassword = 'ValidPassword123!';

    const input = {
      operationId: provOpId,
      serverId,
      siteAdmin: { email: provUsername, password: provPassword },
    };

    let siteCreated = false;
    const mockCreateSite = async () => {
      if (!siteCreated) {
        siteCreated = true;
        return {
          operationId: provOpId,
          created: true,
          resumed: false,
          website: { id: provSiteId, serverId },
          primaryDomain: { websiteId: provSiteId },
        };
      }
      return {
        operationId: provOpId,
        created: false,
        resumed: true,
        website: { id: provSiteId, serverId },
        primaryDomain: { websiteId: provSiteId },
      };
    };

    let provisioningAttempt = 0;
    const failingProvisioningRegistry = {
      create: async (plan) => {
        provisioningAttempt++;
        if (provisioningAttempt === 1) {
          const err = new Error('Provisioning registry database write failed');
          err.code = 'provisioning_registration_failed';
          err.status = 503;
          throw err;
        }
        return { ...plan, persisted: true, ready: true };
      },
    };

    const routes = new Map();
    mountSiteCreateRoutes({
      post: (path, ...handlers) => routes.set(path, handlers),
    }, {
      localServerId: serverId,
      userAdminStore: store.users,
      createSite: mockCreateSite,
      provisioningPlanner: async () => ({
        operationId: provOpId,
        websiteId: provSiteId,
        fixture: true,
      }),
      previewSiteCreate: async () => ({
        operationId: provOpId,
        ids: { websiteId: provSiteId },
        hostname: { primaryDomain: 'prov-fail.example.test' },
        previewDigest: 'b'.repeat(64),
        confirmation: `create-site:${provOpId}:${'b'.repeat(64)}`,
        plan: { website: { id: provSiteId, serverId } },
        steps: { websiteReady: true },
        blockers: [],
      }),
      websiteProvisioningRegistry: failingProvisioningRegistry,
    });

    const handler = routes.get('/api/sites')[1];
    const invokeRoute = async (body) => {
      const res = {
        statusCode: 200,
        status(n) { this.statusCode = n; return this; },
        json(val) { this.body = val; return this; },
      };
      const req = {
        body,
        auth: {
          user: { id: ownerUser.id, username: ownerUser.username, role: 'owner' },
          access: { mode: 'management', permissions: ['*'] },
          security: { managementAllowed: true },
        },
      };
      await handler(req, res, (err) => { res.error = err; });
      return res;
    };

    const requestBody = {
      input,
      previewDigest: 'b'.repeat(64),
      confirmation: `create-site:${provOpId}:${'b'.repeat(64)}`,
    };

    // First attempt: Account is created, but provisioning registry write fails
    const firstRes = await invokeRoute(requestBody);
    assert.equal(firstRes.statusCode, 201, 'Site creation returns 201');
    assert.equal(firstRes.body.data.created, true);
    assert.equal(firstRes.body.data.website.id, provSiteId);
    assert.deepEqual(firstRes.body.data.siteAdmin, {
      status: 'created',
      websiteId: provSiteId,
      code: null,
    });
    assert.equal(firstRes.body.data.provisioningError?.code, 'provisioning_registration_failed');
    assert.equal(firstRes.body.data.provisioningError?.status, 503);

    // Verify atomic lock & durable result in SQLite: account was durably saved
    const dbProv = new DatabaseSync(filePath);
    let createdUserRow;
    try {
      createdUserRow = dbProv.prepare('SELECT * FROM users WHERE username = ?').get(provUsername);
      assert.ok(createdUserRow, 'Site admin user must be durably saved in SQLite');
      assert.equal(createdUserRow.role, 'site_manager');
      assert.equal(createdUserRow.active, 1);

      const opRow = dbProv.prepare('SELECT * FROM auth_operation_users WHERE operation_id = ?').get(provOpId);
      assert.ok(opRow, 'auth_operation_users must record the operationId mapping');
      assert.equal(opRow.operation_id, provOpId);
      assert.equal(opRow.user_id, createdUserRow.id);
      assert.equal(opRow.website_id, provSiteId);
    } finally {
      dbProv.close();
    }

    // Operation user reconciliation functions verify durable state
    const opUser = store.users.getOperationUser(provOpId);
    assert.ok(opUser);
    assert.equal(opUser.userId, createdUserRow.id);
    assert.equal(opUser.websiteId, provSiteId);
    assert.equal(opUser.user.username, provUsername);

    const reconciledUser = store.users.reconcileOperationUser(provOpId, provSiteId);
    assert.ok(reconciledUser);
    assert.equal(reconciledUser.id, createdUserRow.id);

    // Second attempt (replay / retry):
    // Provisioning registry succeeds this time, and siteAdmin result is safely handled via replay protection
    const replayRes = await invokeRoute(requestBody);
    assert.equal(replayRes.statusCode, 200, 'Replay returns 200 OK');
    assert.equal(replayRes.body.data.created, false);
    assert.equal(replayRes.body.data.siteAdmin.status, 'attention');
    assert.equal(replayRes.body.data.siteAdmin.code, 'site_admin_replay_requires_review');
    assert.equal(replayRes.body.data.provisioning.persisted, true);
    assert.equal(replayRes.body.data.provisioning.ready, true);

    // SQLite verification: user was NOT recreated, password_hash not touched, no duplicate rows
    const dbReplay = new DatabaseSync(filePath);
    try {
      const userAfter = dbReplay.prepare('SELECT * FROM users WHERE username = ?').get(provUsername);
      assert.equal(userAfter.id, createdUserRow.id);
      assert.equal(userAfter.password_hash, createdUserRow.password_hash, 'Password hash must be preserved unchanged');

      const opCount = dbReplay.prepare('SELECT count(*) as count FROM auth_operation_users WHERE operation_id = ?').get(provOpId);
      assert.equal(opCount.count, 1, 'auth_operation_users must have exactly 1 row');
    } finally {
      dbReplay.close();
    }
  }
});
