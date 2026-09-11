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
import { createWebsiteRegistry } from '../src/website-registry.js';

const origin = 'https://panel.example.test';
const csrfToken = 'site-create-csrf';

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

async function resources() {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'site-create-http' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'site-create-http-host' });
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
  await Promise.all([
    applicationRegistry.init(), dockerWorkloadRegistry.init(), websiteRegistry.init(), domainRegistry.init(),
    dnsHostingRegistry.init(), mailDomainRegistry.init(),
  ]);
  return {
    registry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    serverId: enrolled.server.id,
  };
}

async function listener(t, role, state) {
  const handler = createAuthenticatedApi({
    store: fakeStore(role),
    publicOrigin: origin,
    createHandler: () => createApp({ ...state, environment: 'production' }),
  });
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (pathname, { authenticated = true, body } = {}) => fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      ...(authenticated ? { cookie: '__Host-yunpanel_session=valid-session' } : {}),
      origin,
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

function siteInput(serverId) {
  return {
    operationId: 'f6fd38e5-5e87-4980-a0b2-02d320eb7c54',
    serverId,
    name: 'HTTP Site',
    primaryDomain: 'http-site.example.test',
    parentDomainId: null,
    wwwMode: 'none',
    httpsMode: 'off',
    source: { kind: 'external_proxy', target: { host: 'origin.example.test', port: 8443 } },
  };
}

test('Owner previews and applies site creation through the authenticated API', async (t) => {
  const state = await resources();
  const request = await listener(t, 'owner', state);
  const input = siteInput(state.serverId);

  const previewResponse = await request('/api/sites/create-preview', { body: { input } });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).data;
  assert.equal(preview.autoApply, false);
  assert.match(preview.confirmation, /^create-site:/);

  const invalid = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: 'wrong' },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'site_create_confirmation_required');
  assert.equal((await state.websiteRegistry.listWebsites()).length, 0);

  const response = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(response.status, 201);
  const created = (await response.json()).data;
  assert.equal(created.website.id, preview.ids.websiteId);
  assert.equal(created.primaryDomain.id, preview.ids.primaryDomainId);

  const retry = await request('/api/sites', {
    body: { input, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.created, false);
  assert.deepEqual(await state.dnsHostingRegistry.listZones(), []);
  assert.deepEqual(await state.mailDomainRegistry.listMailDomains(), []);
});

test('authentication and Read Only authorization stop site planning before registries mutate', async (t) => {
  const state = await resources();
  const request = await listener(t, 'read_only', state);
  const input = siteInput(state.serverId);

  const unauthenticated = await request('/api/sites/create-preview', { authenticated: false, body: { input } });
  assert.equal(unauthenticated.status, 401);
  const deniedPreview = await request('/api/sites/create-preview', { body: { input } });
  assert.equal(deniedPreview.status, 403);
  const deniedApply = await request('/api/sites', {
    body: { input, previewDigest: 'a'.repeat(64), confirmation: 'blocked' },
  });
  assert.equal(deniedApply.status, 403);
  assert.equal((await state.applicationRegistry.listApplications()).length, 0);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 0);
  assert.equal((await state.domainRegistry.listDomains()).length, 0);
});
