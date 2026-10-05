import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { provisionSiteAdmin } from '../src/site-admin-provisioning.js';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

import { siteAdminResult, siteAdminMessage } from '../../web/src/workspace/site-admin-result.js';
import { createSiteSubmission } from '../../web/src/workspace/site-create-submission.js';

// Run web result and wiring checks alongside API wiring
import '../../web/test/site-admin-result.test.js';
import '../../web/test/site-create-result-wiring.test.js';

const origin = 'https://panel.example.test';
const csrfToken = 'site-admin-wiring-csrf';

const appUrl = new URL('../src/management-app.js', import.meta.url);
const siteCreateHttpUrl = new URL('../src/site-create-http.js', import.meta.url);
const siteAdminProvisioningUrl = new URL('../src/site-admin-provisioning.js', import.meta.url);
const authStoreUrl = new URL('../src/auth-store.js', import.meta.url);
const siteAdminResultUrl = new URL('../../web/src/workspace/site-admin-result.js', import.meta.url);
const siteCreateResultUrl = new URL('../../web/src/workspace/SiteCreateResult.jsx', import.meta.url);
const siteCreateSubmissionUrl = new URL('../../web/src/workspace/site-create-submission.js', import.meta.url);

function fakeStore(role) {
  const session = {
    id: '4afc9025-92fb-4cb7-be1b-0406bdfe70a8',
    user: { id: `${role}-id`, username: role, role },
    csrfToken,
    expiresAt: Date.now() + 60_000,
    idleExpiresAt: Date.now() + 60_000,
  };
  return {
    configured: () => true,
    mfa: { enabled: () => role === 'owner' },
    getSession: (token) => token === 'valid-session' ? session : null,
    listSessions: () => [],
    audit: { record() { return {}; }, list() { return { events: [], total: 0, offset: 0, limit: 50 }; } },
  };
}

function provisioningRuntime() {
  const checksum = 'c'.repeat(64);
  return createWebsiteProvisioningRuntime({
    identityManager: {
      apply: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
      inspect: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
      compensate: async () => ({ satisfied: true }),
      inspectCompensation: async () => ({ satisfied: true }),
    },
    passengerSiteManager: {
      apply: async () => ({ satisfied: false, reason: 'unused' }),
      inspect: async () => ({ satisfied: false, reason: 'unused' }),
    },
    nginxManager: {
      stageDomain: async (spec) => ({ configName: `yunpanel-${spec.primaryDomain}.conf`, checksum, bytes: 420 }),
      inspectStagedDomain: async (spec) => ({
        satisfied: true,
        result: { configName: `yunpanel-${spec.primaryDomain}.conf`, checksum, bytes: 420 },
      }),
      inspectActiveDomain: async ({ primaryDomain }) => ({
        satisfied: true,
        result: { configName: `yunpanel-${primaryDomain}.conf`, checksum, active: true },
      }),
      activateDomain: async ({ primaryDomain }) => ({
        configName: `yunpanel-${primaryDomain}.conf`, checksum, active: true,
      }),
      compensateDomain: async () => ({ satisfied: true }),
      inspectDomainCompensation: async () => ({ satisfied: true }),
    },
  });
}

async function resources() {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'site-admin-wiring-http' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'site-admin-wiring-host' });
  const applicationRegistry = createApplicationRegistry({ serverExists: async (id) => Boolean(await registry.getServer(id)) });
  const dockerWorkloadRegistry = createDockerWorkloadRegistry({ serverExists: async (id) => Boolean(await registry.getServer(id)) });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getApplication: async (id) => applicationRegistry.getApplication(id),
    getDockerWorkload: async (id) => dockerWorkloadRegistry.getWorkload(id),
  });
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
    websiteBindingRequired: () => true,
  });
  const getWebDomain = async (id) => domainRegistry.getDomain(id);
  const dnsHostingRegistry = createDnsHostingRegistry({ getWebDomain });
  const mailDomainRegistry = createMailDomainRegistry({ getWebDomain });
  const websiteProvisioningRuntime = provisioningRuntime();
  await Promise.all([
    applicationRegistry.init(), dockerWorkloadRegistry.init(), websiteRegistry.init(), domainRegistry.init(),
    dnsHostingRegistry.init(), mailDomainRegistry.init(), websiteProvisioningRuntime.init(),
  ]);
  return {
    registry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    websiteProvisioningRuntime,
    serverId: enrolled.server.id,
  };
}

async function listener(t, role, state, userAdminStore = null) {
  const handler = createAuthenticatedApi({
    store: fakeStore(role),
    publicOrigin: origin,
    createHandler: () => createApp({ ...state, userAdminStore, environment: 'production' }),
  });
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (pathname, { authenticated = true, body, method = 'POST', headers = {} } = {}) => fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(authenticated ? { cookie: '__Host-yunpanel_session=valid-session' } : {}),
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-csrf-token': csrfToken,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function baseSiteInput(serverId, extra = {}) {
  return {
    operationId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    serverId,
    name: 'Wiring Result Site',
    primaryDomain: 'wiring-result.example.test',
    parentDomainId: null,
    wwwMode: 'none',
    httpsMode: 'off',
    source: {
      kind: 'new_static',
      repositoryUrl: 'https://github.com/example/site-admin',
      branch: 'main',
      build: { mode: 'none', outputDir: '.' },
      retention: 5,
    },
    ...extra,
  };
}

function createRealStoreFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-site-admin-wiring-'));
  const filePath = path.join(root, 'private', 'auth.sqlite');
  const store = createAuthStore({ filePath });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, filePath, root };
}

// ---------------------------------------------------------------------------
// 1. Source Wiring Assertions
// ---------------------------------------------------------------------------

test('production app wires userAdminStore to mountSiteCreateRoutes', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /mountSiteCreateRoutes\(app,\s*\{[\s\S]*userAdminStore,/);
});

test('site-create HTTP calls provisionSiteAdmin and separates siteAdmin outcome from site creation', async () => {
  const source = await readFile(siteCreateHttpUrl, 'utf8');
  assert.match(source, /import\s*\{\s*provisionSiteAdmin\s*\}\s*from\s*'\.\/site-admin-provisioning\.js'/);
  assert.match(source, /siteAdmin = await provisionSiteAdmin\(\{/);
  assert.match(source, /siteAdminError = Object\.freeze\(\{/);
  assert.match(source, /response\.status\(result\.created \? 201 : 200\)\.json\(\{\s*data: Object\.freeze\(\{\s*\.\.\.result,\s*siteAdmin,/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test('site-admin-provisioning maps errors to safe attention codes without credential leakage', async () => {
  const source = await readFile(siteAdminProvisioningUrl, 'utf8');
  assert.match(source, /username_taken:\s*'site_admin_conflict'/);
  assert.match(source, /operation_user_conflict:\s*'site_admin_conflict'/);
  assert.match(source, /site_admin_replay_requires_review/);
  assert.match(source, /site_admin_result_unverified/);
  assert.doesNotMatch(source, /console\.(error|log|warn)/);
  assert.doesNotMatch(source, /error\.message|error\.stack/);
});

test('web siteAdminResult maps attention codes and isolates raw server errors', async () => {
  const source = await readFile(siteAdminResultUrl, 'utf8');
  assert.match(source, /site_admin_conflict/);
  assert.match(source, /site_admin_replay_requires_review/);
  assert.match(source, /site_admin_result_unverified/);
  assert.match(source, /export function siteAdminResult/);
  assert.match(source, /export function siteAdminMessage/);
});

test('web SiteCreateResult displays account notice separately and retains it across provisioning states', async () => {
  const source = await readFile(siteCreateResultUrl, 'utf8');
  assert.match(source, /state\.siteAdmin && state\.siteAdmin\.status !== 'not_requested'/);
  assert.match(source, /state\.siteAdmin\.status === 'attention'\s*\?\s*'ws-notice ws-notice-warn'\s*:\s*'ws-notice'/);
  assert.match(source, /siteAdminMessage\(state\.siteAdmin\)/);
  assert.match(source, /to="\/settings\/users"/);
  assert.match(source, /siteHref\(domain\.id, 'overview'\)/);
  assert.match(source, /siteHref\(domain\.id, 'files'\)/);
});

test('auth-store defines permanent auth_operation_users table and reconciliation exports', async () => {
  const source = await readFile(authStoreUrl, 'utf8');
  assert.match(source, /CREATE TABLE IF NOT EXISTS auth_operation_users/);
  assert.match(source, /operation_id TEXT PRIMARY KEY NOT NULL/);
  assert.match(source, /user_id TEXT NOT NULL REFERENCES users\(id\)/);
  assert.match(source, /website_id TEXT NOT NULL/);
  assert.match(source, /function reconcileOperationUser/);
  assert.match(source, /function getOperationUser/);
  assert.match(source, /users\.reconcileOperationUser = reconcileOperationUser/);
  assert.match(source, /users\.getOperationUser = getOperationUser/);
});

// ---------------------------------------------------------------------------
// 2. HTTP Integration: Site Record & Account Result Separation
// ---------------------------------------------------------------------------

test('account conflict (username_taken) separates created site from attention account result', async (t) => {
  const state = await resources();
  const userAdminStore = {
    createSiteManager: async () => {
      const err = new Error('Username taken');
      err.code = 'username_taken';
      throw err;
    },
  };

  const request = await listener(t, 'owner', state, userAdminStore);
  const input = baseSiteInput(state.serverId, {
    operationId: '10101010-1010-4010-8010-101010101010',
    primaryDomain: 'conflict-test.example.test',
    siteAdmin: { email: 'existing@example.test', password: 'fixture-password-only' },
  });

  const previewRes = await request('/api/sites/create-preview', { body: { input } });
  assert.equal(previewRes.status, 200);
  const preview = (await previewRes.json()).data;

  const response = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()).data;

  // Site is created and exists in website registry
  assert.equal(result.created, true);
  assert.ok(result.website.id);
  const website = await state.websiteRegistry.getWebsite(result.website.id);
  assert.ok(website, 'Website must be persisted in websiteRegistry');

  // Account result is attention with conflict code
  assert.equal(result.siteAdmin.status, 'attention');
  assert.equal(result.siteAdmin.code, 'site_admin_conflict');
  assert.equal(result.siteAdminError.code, 'site_admin_conflict');
  assert.equal(result.siteAdminError.status, 409);

  // Client mapper reflects attention and localized Turkish warning
  const webResult = siteAdminResult(result.siteAdmin, { requested: true, websiteId: result.website.id });
  assert.deepEqual(webResult, { status: 'attention', code: 'site_admin_conflict' });
  assert.match(siteAdminMessage(webResult), /Bu kullanıcı adı zaten kullanılıyor/);
});

test('store throw or lock separates created site from unverified account result without credential leaks', async (t) => {
  const state = await resources();
  const userAdminStore = {
    createSiteManager: async () => {
      const err = new Error('private-hash-or-sql-failure');
      err.code = 'store_locked';
      throw err;
    },
  };

  const request = await listener(t, 'owner', state, userAdminStore);
  const input = baseSiteInput(state.serverId, {
    operationId: '20202020-2020-4020-8020-202020202020',
    primaryDomain: 'lock-test.example.test',
    siteAdmin: { email: 'locked-admin@example.test', password: 'super-secret-password-123' },
  });

  const previewRes = await request('/api/sites/create-preview', { body: { input } });
  const preview = (await previewRes.json()).data;

  const response = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()).data;

  assert.equal(result.created, true);
  assert.equal(result.siteAdmin.status, 'attention');
  assert.equal(result.siteAdmin.code, 'site_admin_locked');
  assert.equal(result.siteAdminError.code, 'site_admin_locked');

  // No passwords or secret strings in serialized response
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('super-secret-password-123'), false);
  assert.equal(serialized.includes('private-hash'), false);

  const webResult = siteAdminResult(result.siteAdmin, { requested: true, websiteId: result.website.id });
  assert.deepEqual(webResult, { status: 'attention', code: 'site_admin_locked' });
  assert.match(siteAdminMessage(webResult), /kilitli/);
});

test('missing dependency yields attention without failing site registration', async (t) => {
  const state = await resources();
  const request = await listener(t, 'owner', state, null); // userAdminStore is null
  const input = baseSiteInput(state.serverId, {
    operationId: '30303030-3030-4030-8030-303030303030',
    primaryDomain: 'missing-dep.example.test',
    siteAdmin: { email: 'admin@example.test', password: 'fixture-password-only' },
  });

  const previewRes = await request('/api/sites/create-preview', { body: { input } });
  const preview = (await previewRes.json()).data;

  const response = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()).data;

  assert.equal(result.created, true);
  assert.equal(result.siteAdmin.status, 'attention');
  assert.equal(result.siteAdmin.code, 'site_admin_unavailable');
  assert.equal(result.siteAdminError.code, 'site_admin_unavailable');
  assert.equal(result.siteAdminError.status, 400);

  const webResult = siteAdminResult(result.siteAdmin, { requested: true, websiteId: result.website.id });
  assert.deepEqual(webResult, { status: 'attention', code: 'site_admin_unavailable' });
  assert.match(siteAdminMessage(webResult), /kullanılamadı/);
});

// ---------------------------------------------------------------------------
// 3. Replay Idempotency & Protection
// ---------------------------------------------------------------------------

test('replay of site creation returns 200 with replay_requires_review and never mutates user store', async (t) => {
  const state = await resources();
  let calls = 0;
  const userAdminStore = {
    createSiteManager: async ({ username, websiteId }) => {
      calls += 1;
      return {
        id: '40404040-4040-4040-8040-404040404040',
        username,
        role: 'site_manager',
        active: true,
        websiteIds: [websiteId],
      };
    },
  };

  const request = await listener(t, 'owner', state, userAdminStore);
  const input = baseSiteInput(state.serverId, {
    operationId: '40404040-4040-4040-8040-404040404040',
    primaryDomain: 'replay-wiring.example.test',
    siteAdmin: { email: 'replay-wiring@example.test', password: 'fixture-password-only' },
  });

  const previewRes = await request('/api/sites/create-preview', { body: { input } });
  const preview = (await previewRes.json()).data;

  // First call: 201
  const firstResponse = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(firstResponse.status, 201);
  assert.equal(calls, 1);

  // Second call (replay): 200 OK, created: false, calls still 1
  const replayResponse = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(replayResponse.status, 200);
  const replayResult = (await replayResponse.json()).data;

  assert.equal(replayResult.created, false);
  assert.equal(replayResult.siteAdmin.status, 'attention');
  assert.equal(replayResult.siteAdmin.code, 'site_admin_replay_requires_review');
  assert.equal(calls, 1, 'Replay must never re-invoke createSiteManager');

  const webResult = siteAdminResult(replayResult.siteAdmin, { requested: true, websiteId: replayResult.website.id });
  assert.deepEqual(webResult, { status: 'attention', code: 'site_admin_replay_requires_review' });
  assert.match(siteAdminMessage(webResult), /Mevcut site kaydı kullanıldı/);
});

// ---------------------------------------------------------------------------
// 4. Host Plan Completion & Warning Persistence
// ---------------------------------------------------------------------------

test('host plan completion (phase: ready) preserves account warning persistently', async () => {
  const websiteId = '50505050-5050-4050-8050-505050505050';
  const domainId = '60606060-6060-4060-8060-606060606060';
  const operationId = '70707070-7070-4070-8070-707070707070';
  const serverId = '80808080-8080-4080-8080-808080808080';

  const preview = {
    operationId,
    ids: { websiteId, primaryDomainId: domainId },
    hostname: { primaryDomain: 'ready-persist.example.test' },
    previewDigest: 'f'.repeat(64),
    confirmation: `create-site:${operationId}:${'f'.repeat(64)}`,
    provisioning: {
      operationId,
      websiteId,
      ready: false,
      steps: [{ id: 'nginx', required: true, state: 'pending' }],
    },
  };

  const created = {
    operationId,
    website: { id: websiteId, serverId },
    primaryDomain: { id: domainId, websiteId, serverId, primaryDomain: 'ready-persist.example.test' },
    siteAdmin: { status: 'attention', websiteId, code: 'site_admin_conflict' },
    provisioning: {
      operationId,
      websiteId,
      ready: false,
      steps: [{ id: 'nginx', required: true, state: 'pending' }],
    },
  };

  const flow = createSiteSubmission({
    request: async (url) => url.endsWith('create-preview') ? preview : created,
    advance: async (_id, { onStep }) => {
      const readyOp = {
        operationId,
        websiteId,
        ready: true,
        steps: [{ id: 'nginx', required: true, state: 'succeeded' }],
      };
      onStep({ operationId, operation: readyOp });
      return readyOp;
    },
  });

  const state = await flow.submit({
    operationId,
    serverId,
    primaryDomain: 'ready-persist.example.test',
    siteAdmin: { email: 'admin@example.test', password: 'fixture-password-only' },
  });

  // Host provisioning succeeded and reached ready phase
  assert.equal(state.phase, 'ready');
  assert.equal(state.created.id, domainId);

  // BUT account warning remains visible and persistent
  assert.deepEqual(state.siteAdmin, { status: 'attention', code: 'site_admin_conflict' });
  assert.equal(state.siteAdmin.status, 'attention');
  assert.equal(state.siteAdmin.code, 'site_admin_conflict');
  assert.match(siteAdminMessage(state.siteAdmin), /Bu kullanıcı adı zaten kullanılıyor/);
});

// ---------------------------------------------------------------------------
// 5. Permanent Operation→User Reconciliation (auth_operation_users SQLite)
// ---------------------------------------------------------------------------

test('permanent operation→user reconciliation stores association in SQLite and enables idempotent replay', async (t) => {
  const { store, filePath } = createRealStoreFixture(t);
  const ownerUser = await store.completeSetup({
    setupToken: store.issueSetupToken().token,
    username: 'ReconcileOwner',
    password: 'OwnerPassword123!',
  });

  const websiteId = '90909090-9090-4090-8090-909090909090';
  const operationId = 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0';
  const password = 'SiteManagerPass123!';

  // 1. Initial creation with operationId
  const initialUser = await store.users.createSiteManager({
    username: 'manager.recon@example.test',
    password,
    websiteId,
    actorId: ownerUser.id,
    operationId,
  });

  assert.ok(initialUser.id);
  assert.equal(initialUser.username, 'manager.recon@example.test');
  assert.equal(initialUser.role, 'site_manager');
  assert.deepEqual(initialUser.websiteIds, [websiteId]);

  // 2. Direct SQLite check on auth_operation_users table
  const db = new DatabaseSync(filePath);
  let opRow;
  let userRowBefore;
  try {
    opRow = db.prepare('SELECT * FROM auth_operation_users WHERE operation_id = ?').get(operationId);
    assert.ok(opRow, 'auth_operation_users must contain the operationId row');
    assert.equal(opRow.operation_id, operationId);
    assert.equal(opRow.user_id, initialUser.id);
    assert.equal(opRow.website_id, websiteId);

    userRowBefore = db.prepare('SELECT * FROM users WHERE id = ?').get(initialUser.id);
    assert.ok(userRowBefore);
  } finally {
    db.close();
  }

  // 3. getOperationUser lookup
  const lookup = store.users.getOperationUser(operationId);
  assert.ok(lookup);
  assert.equal(lookup.operationId, operationId);
  assert.equal(lookup.userId, initialUser.id);
  assert.equal(lookup.websiteId, websiteId);
  assert.equal(lookup.user.username, 'manager.recon@example.test');

  // 4. reconcileOperationUser verification
  const reconciled = store.users.reconcileOperationUser(operationId, websiteId);
  assert.ok(reconciled);
  assert.equal(reconciled.id, initialUser.id);
  assert.equal(reconciled.username, 'manager.recon@example.test');

  // 5. Replay createSiteManager with same operationId: returns existing user WITHOUT changing password or recreating
  const replayedUser = await store.users.createSiteManager({
    username: 'manager.recon@example.test',
    password: 'DifferentPasswordThatMustNotBeSet!',
    websiteId,
    actorId: ownerUser.id,
    operationId,
  });

  assert.equal(replayedUser.id, initialUser.id, 'Replay must return exact same user ID');
  assert.equal(replayedUser.username, initialUser.username);

  // Verify SQLite password_hash and count did not change
  const dbVerify = new DatabaseSync(filePath);
  try {
    const userRowAfter = dbVerify.prepare('SELECT * FROM users WHERE id = ?').get(initialUser.id);
    assert.equal(userRowAfter.password_hash, userRowBefore.password_hash, 'Password hash must NOT be updated on replay');

    const totalUsers = dbVerify.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('site_manager');
    assert.equal(totalUsers.count, 1, 'Exactly 1 site manager must exist in SQLite');

    const totalOpRows = dbVerify.prepare('SELECT COUNT(*) as count FROM auth_operation_users WHERE operation_id = ?').get(operationId);
    assert.equal(totalOpRows.count, 1, 'Exactly 1 operation user row must exist');
  } finally {
    dbVerify.close();
  }

  // 6. Conflict checks on replay
  // Different website for same operationId throws 409
  await assert.rejects(
    store.users.createSiteManager({
      username: 'manager.recon@example.test',
      password,
      websiteId: 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0',
      actorId: ownerUser.id,
      operationId,
    }),
    { code: 'operation_user_conflict', status: 409 },
  );

  // Different username for same operationId throws 409
  await assert.rejects(
    store.users.createSiteManager({
      username: 'different.user@example.test',
      password,
      websiteId,
      actorId: ownerUser.id,
      operationId,
    }),
    { code: 'operation_user_conflict', status: 409 },
  );

  // reconcileOperationUser with wrong websiteId throws 409
  assert.throws(
    () => store.users.reconcileOperationUser(operationId, 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0'),
    { code: 'operation_user_conflict', status: 409 },
  );

  // Non-existent operation returns null
  assert.equal(store.users.reconcileOperationUser('non-existent-op', websiteId), null);
  assert.equal(store.users.getOperationUser('non-existent-op'), null);
});
