import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { siteAdminResult, siteAdminMessage } from '../../web/src/workspace/site-admin-result.js';

const origin = 'https://panel.example.test';
const csrfToken = 'site-admin-result-csrf';

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
  const enrollment = await registry.issueEnrollmentToken({ label: 'site-admin-result-http' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'site-admin-result-host' });
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
    name: 'Admin Result Site',
    primaryDomain: 'admin-result.example.test',
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

test('real app.js import enforces authentication and CSRF before reaching site creation routes', async (t) => {
  const state = await resources();
  const request = await listener(t, 'owner', state);
  const input = baseSiteInput(state.serverId, {
    siteAdmin: { email: 'admin@example.test', password: 'fixture-password-only' },
  });

  const unauthenticated = await request('/api/sites', { authenticated: false, body: { input } });
  assert.equal(unauthenticated.status, 401);

  const missingCsrf = await request('/api/sites', {
    headers: { 'x-csrf-token': '' },
    body: { input },
  });
  assert.equal(missingCsrf.status, 403);

  const wrongOrigin = await request('/api/sites', {
    headers: { origin: 'https://evil.example.test' },
    body: { input },
  });
  assert.equal(wrongOrigin.status, 403);

  const readOnlyRequest = await listener(t, 'read_only', state);
  const deniedPreview = await readOnlyRequest('/api/sites/create-preview', { body: { input } });
  assert.equal(deniedPreview.status, 403);

  const deniedApply = await readOnlyRequest('/api/sites', {
    body: { input, previewDigest: 'a'.repeat(64), confirmation: 'blocked' },
  });
  assert.equal(deniedApply.status, 403);
});

test('successful site creation awaits site-admin provisioning and yields verified account result', async (t) => {
  const state = await resources();
  let createdUser = null;
  const userAdminStore = {
    createSiteManager: async ({ username, password, websiteId, actorId }) => {
      createdUser = {
        id: '99999999-9999-4999-8999-999999999999',
        username,
        role: 'site_manager',
        active: true,
        websiteIds: [websiteId],
      };
      assert.equal(password, 'fixture-password-only');
      assert.equal(actorId, 'owner-id');
      return createdUser;
    },
  };

  const request = await listener(t, 'owner', state, userAdminStore);
  const input = baseSiteInput(state.serverId, {
    operationId: '11111111-1111-4111-8111-111111111111',
    primaryDomain: 'created-site.example.test',
    siteAdmin: { email: ' Admin@Example.test ', password: 'fixture-password-only' },
  });

  const previewRes = await request('/api/sites/create-preview', { body: { input } });
  assert.equal(previewRes.status, 200);
  const preview = (await previewRes.json()).data;
  assert.match(preview.confirmation, /^create-site:/);
  assert.equal(preview.autoApply, false);

  const response = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()).data;

  assert.equal(result.created, true);
  assert.equal(result.website.id, preview.ids.websiteId);
  assert.equal(result.siteAdmin.status, 'created');
  assert.equal(result.siteAdmin.websiteId, preview.ids.websiteId);
  assert.equal(result.siteAdmin.code, null);
  assert.equal(result.siteAdminError, undefined);

  assert.equal(createdUser.username, 'admin@example.test');
  assert.equal(createdUser.role, 'site_manager');
  assert.equal(createdUser.active, true);
  assert.deepEqual(createdUser.websiteIds, [result.website.id]);

  const webResult = siteAdminResult(result.siteAdmin, { requested: true, websiteId: result.website.id });
  assert.deepEqual(webResult, { status: 'created', code: null });
  assert.match(siteAdminMessage(webResult), /Yönetici hesabı oluşturuldu/);

  assert.equal(JSON.stringify(result).includes('fixture-password-only'), false);
});

test('unrequested account creates site with not_requested status and does not touch user store', async (t) => {
  const state = await resources();
  let accessed = false;
  const userAdminStore = {
    createSiteManager: () => {
      accessed = true;
      throw new Error('must not be called');
    },
  };

  const request = await listener(t, 'owner', state, userAdminStore);
  const input = baseSiteInput(state.serverId, {
    operationId: '22222222-2222-4222-8222-222222222222',
    primaryDomain: 'no-admin.example.test',
  });

  const previewRes = await request('/api/sites/create-preview', { body: { input } });
  const preview = (await previewRes.json()).data;

  const response = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()).data;

  assert.equal(result.created, true);
  assert.equal(result.siteAdmin.status, 'not_requested');
  assert.equal(result.siteAdmin.code, null);
  assert.equal(accessed, false);

  const webResult = siteAdminResult(result.siteAdmin, { requested: false, websiteId: result.website.id });
  assert.deepEqual(webResult, { status: 'not_requested', code: null });
});

test('account conflict preserves created site while projecting attention status and siteAdminError', async (t) => {
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
    operationId: '33333333-3333-4333-8333-333333333333',
    primaryDomain: 'conflict.example.test',
    siteAdmin: { email: 'existing@example.test', password: 'fixture-password-only' },
  });

  const previewRes = await request('/api/sites/create-preview', { body: { input } });
  const preview = (await previewRes.json()).data;

  const response = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()).data;

  assert.equal(result.created, true);
  assert.ok(result.website.id);
  assert.equal(result.siteAdmin.status, 'attention');
  assert.equal(result.siteAdmin.code, 'site_admin_conflict');
  assert.equal(result.siteAdminError.code, 'site_admin_conflict');
  assert.equal(result.siteAdminError.status, 409);

  const website = await state.websiteRegistry.getWebsite(result.website.id);
  assert.ok(website);

  const webResult = siteAdminResult(result.siteAdmin, { requested: true, websiteId: result.website.id });
  assert.deepEqual(webResult, { status: 'attention', code: 'site_admin_conflict' });
  assert.match(siteAdminMessage(webResult), /Bu kullanıcı adı zaten kullanılıyor/);
});

test('replay of site creation returns 200 with replay_requires_review and never re-invokes user store', async (t) => {
  const state = await resources();
  let calls = 0;
  const userAdminStore = {
    createSiteManager: async ({ username, websiteId }) => {
      calls += 1;
      return {
        id: '11111111-2222-4333-8444-555555555555',
        username,
        role: 'site_manager',
        active: true,
        websiteIds: [websiteId],
      };
    },
  };

  const request = await listener(t, 'owner', state, userAdminStore);
  const input = baseSiteInput(state.serverId, {
    operationId: '44444444-4444-4444-8444-444444444444',
    primaryDomain: 'replay.example.test',
    siteAdmin: { email: 'replay-admin@example.test', password: 'fixture-password-only' },
  });

  const previewRes = await request('/api/sites/create-preview', { body: { input } });
  const preview = (await previewRes.json()).data;

  const firstResponse = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(firstResponse.status, 201);
  assert.equal(calls, 1);

  const replayResponse = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(replayResponse.status, 200);
  const replayResult = (await replayResponse.json()).data;

  assert.equal(replayResult.created, false);
  assert.equal(replayResult.siteAdmin.status, 'attention');
  assert.equal(replayResult.siteAdmin.code, 'site_admin_replay_requires_review');
  assert.equal(calls, 1);

  const webResult = siteAdminResult(replayResult.siteAdmin, { requested: true, websiteId: replayResult.website.id });
  assert.deepEqual(webResult, { status: 'attention', code: 'site_admin_replay_requires_review' });
  assert.match(siteAdminMessage(webResult), /Mevcut site kaydı kullanıldı/);
});

test('unavailable userAdminStore yields attention without failing site registration', async (t) => {
  const state = await resources();
  const request = await listener(t, 'owner', state, null);
  const input = baseSiteInput(state.serverId, {
    operationId: '55555555-5555-4555-8555-555555555555',
    primaryDomain: 'no-store.example.test',
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
});
