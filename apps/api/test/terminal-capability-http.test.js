import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import test from 'node:test';
import { createLicenseEntitlementService } from '../src/license-entitlement-service.js';
import { mountTerminalCapabilityRoutes } from '../src/terminal-capability-http.js';
import { createTerminalCapabilityRegistry } from '../src/terminal-capability-registry.js';
import { withPanelContext, readOnlyManagementContext } from './helpers/panel-auth-fixture.js';

const SERVER_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce8';
const WEBSITE_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';
const OWNER_CONTEXT = Object.freeze({
  id: '12345678-1234-4234-9234-123456789012',
  user: Object.freeze({ id: 'owner-1', username: 'owner', role: 'owner' }),
  security: Object.freeze({ managementAllowed: true }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
});

async function request(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/terminal/capabilities`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function fixture(t, context = OWNER_CONTEXT, overrides = {}) {
  const terminalCapabilityRegistry = createTerminalCapabilityRegistry();
  const registry = {
    async getServer(serverId) { return serverId === SERVER_ID ? { id: SERVER_ID } : null; },
  };
  const websiteRegistry = {
    async getWebsite(websiteId) {
      if (websiteId !== WEBSITE_ID) return null;
      return {
        id: WEBSITE_ID,
        serverId: SERVER_ID,
        runtimeType: 'static',
        unixUser: 'yunapp-123456789abc',
        documentRoot: '/var/www/yunpanel/apps/application/current',
      };
    },
  };
  const inner = express();
  inner.use(express.json({ limit: '256kb' }));
  mountTerminalCapabilityRoutes(inner, {
    terminalCapabilityRegistry,
    serverRegistry: overrides.registry ?? registry,
    websiteRegistry: overrides.websiteRegistry ?? websiteRegistry,
    localServerId: overrides.localServerId ?? SERVER_ID,
    licenseEntitlementService: overrides.licenseEntitlementService ?? null,
  });
  inner.use((error, _request, response, _next) => response.status(error.status ?? 500).json({
    error: {
      code: error.code ?? 'internal_error',
      message: error.message,
      ...(error.capability ? { capability: error.capability } : {}),
    },
  }));
  const app = withPanelContext(inner, context);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, terminalCapabilityRegistry };
}

test('Owner issues exact local root and isolated Website capabilities without a shell command', async (t) => {
  const state = await fixture(t);
  const root = await request(state.baseUrl, { scope: 'server', serverId: SERVER_ID });
  assert.equal(root.response.status, 201);
  assert.deepEqual(root.payload.data.target, { scope: 'server', serverId: SERVER_ID, user: 'root', cwd: '/root' });
  assert.equal(state.terminalCapabilityRegistry.consume(root.payload.data.capability, {
    sessionId: OWNER_CONTEXT.id, userId: OWNER_CONTEXT.user.id,
  }).target.user, 'root');

  const site = await request(state.baseUrl, { scope: 'site', websiteId: WEBSITE_ID });
  assert.equal(site.response.status, 201);
  assert.deepEqual(site.payload.data.target, {
    scope: 'site',
    serverId: SERVER_ID,
    websiteId: WEBSITE_ID,
    user: 'yunapp-123456789abc',
    cwd: '/var/www/yunpanel/apps/application/current',
  });
  assert.equal(JSON.stringify(site.payload).includes('command'), false);
});

test('PHP Website terminal derives release current from managed current/public document root', async (t) => {
  const php = await fixture(t, OWNER_CONTEXT, {
    websiteRegistry: {
      async getWebsite(websiteId) {
        if (websiteId !== WEBSITE_ID) return null;
        return {
          id: WEBSITE_ID,
          serverId: SERVER_ID,
          runtimeType: 'php',
          unixUser: 'yunapp-123456789abc',
          documentRoot: '/var/lib/yunpanel/apps/22345678-1234-4234-8234-123456789012/current/public',
        };
      },
    },
  });
  const response = await request(php.baseUrl, { scope: 'site', websiteId: WEBSITE_ID });
  assert.equal(response.response.status, 201);
  assert.deepEqual(response.payload.data.target, {
    scope: 'site',
    serverId: SERVER_ID,
    websiteId: WEBSITE_ID,
    user: 'yunapp-123456789abc',
    cwd: '/var/lib/yunpanel/apps/22345678-1234-4234-8234-123456789012/current',
  });
});

test('PHP terminal rejects noncanonical document roots instead of falling back to HOME or arbitrary cwd', async (t) => {
  const php = await fixture(t, OWNER_CONTEXT, {
    websiteRegistry: {
      async getWebsite() {
        return {
          id: WEBSITE_ID,
          serverId: SERVER_ID,
          runtimeType: 'php',
          unixUser: 'yunapp-123456789abc',
          documentRoot: '/var/lib/yunpanel/data/22345678-1234-4234-8234-123456789012/public',
        };
      },
    },
  });
  const response = await request(php.baseUrl, { scope: 'site', websiteId: WEBSITE_ID });
  assert.equal(response.payload.error.code, 'site_terminal_target_invalid');
});

test('terminal capability rejects remote, unsupported Website and extra request fields', async (t) => {
  const remote = await fixture(t, OWNER_CONTEXT, { localServerId: '216e4db8-468b-4e2f-a021-3ab31e0f4123' });
  assert.equal((await request(remote.baseUrl, { scope: 'server', serverId: SERVER_ID })).payload.error.code, 'terminal_remote_server_unsupported');

  const proxy = await fixture(t, OWNER_CONTEXT, {
    websiteRegistry: {
      async getWebsite() {
        return { id: WEBSITE_ID, serverId: SERVER_ID, runtimeType: 'proxy', unixUser: null, documentRoot: null };
      },
    },
  });
  assert.equal((await request(proxy.baseUrl, { scope: 'site', websiteId: WEBSITE_ID })).payload.error.code, 'site_terminal_unsupported');
  const ordinary = await fixture(t);
  assert.equal((await request(ordinary.baseUrl, { scope: 'server', serverId: SERVER_ID, command: 'id' })).payload.error.code, 'terminal_capability_request_invalid');
});

test('Read Only cannot issue terminal capability', async (t) => {
  const context = { ...readOnlyManagementContext, id: 'read-only-session' };
  const denied = await request((await fixture(t, context)).baseUrl, { scope: 'server', serverId: SERVER_ID });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, 'forbidden');
});

test('Free baseline preserves Owner isolated site terminal while gating separate site-user and reseller logins after RBAC scope check', async (t) => {
  const FOREIGN_WEBSITE_ID = 'aa830043-9752-4640-83b4-3a1998de7899';
  const freeLicenseService = createLicenseEntitlementService({
    filePath: ':memory:',
    publicKeyPem: '',
    publicKeyFile: '',
    publicOrigin: 'https://panel.example.test',
    development: false,
  });

  // 1. Free Owner is allowed both root server terminal AND dedicated site Unix-user terminal
  const freeOwner = await fixture(t, OWNER_CONTEXT, { licenseEntitlementService: freeLicenseService });
  const ownerSite = await request(freeOwner.baseUrl, { scope: 'site', websiteId: WEBSITE_ID });
  assert.equal(ownerSite.response.status, 201);
  assert.equal(ownerSite.payload.data.target.user, 'yunapp-123456789abc');

  const ownerRoot = await request(freeOwner.baseUrl, { scope: 'server', serverId: SERVER_ID });
  assert.equal(ownerRoot.response.status, 201);
  assert.equal(ownerRoot.payload.data.target.user, 'root');

  // 2. Separate site_manager / customer panel login: RBAC scope isolation runs first, then Premium gate
  const siteUserContext = Object.freeze({
    id: '22345678-1234-4234-9234-123456789012',
    user: Object.freeze({
      id: 'site-mgr-1',
      username: 'sitemgr',
      role: 'site_manager',
      active: true,
      websiteIds: Object.freeze([WEBSITE_ID]),
    }),
    security: Object.freeze({ managementAllowed: true }),
    access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
  });
  const freeSiteUser = await fixture(t, siteUserContext, { licenseEntitlementService: freeLicenseService });

  const siteUserRootDenied = await request(freeSiteUser.baseUrl, { scope: 'server', serverId: SERVER_ID });
  assert.equal(siteUserRootDenied.response.status, 403);
  assert.equal(siteUserRootDenied.payload.error.code, 'terminal_server_forbidden');

  const siteUserForeignDenied = await request(freeSiteUser.baseUrl, { scope: 'site', websiteId: FOREIGN_WEBSITE_ID });
  assert.equal(siteUserForeignDenied.response.status, 403);
  assert.equal(siteUserForeignDenied.payload.error.code, 'terminal_site_forbidden');

  const siteUserPremiumRequired = await request(freeSiteUser.baseUrl, { scope: 'site', websiteId: WEBSITE_ID });
  assert.equal(siteUserPremiumRequired.response.status, 403);
  assert.equal(siteUserPremiumRequired.payload.error.code, 'premium_license_required');
  assert.equal(siteUserPremiumRequired.payload.error.capability, 'perSiteIsolatedUsers');

  // 3. Separate reseller panel login: RBAC scope isolation runs first, then resellerAccounts gate
  const resellerContext = Object.freeze({
    id: '32345678-1234-4234-9234-123456789012',
    user: Object.freeze({
      id: 'reseller-1',
      username: 'reseller1',
      role: 'site_manager',
      hosting: Object.freeze({ kind: 'reseller', resellerId: null }),
      active: true,
      websiteIds: Object.freeze([WEBSITE_ID]),
    }),
    security: Object.freeze({ managementAllowed: true }),
    access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
  });
  const freeReseller = await fixture(t, resellerContext, { licenseEntitlementService: freeLicenseService });

  const resellerForeignDenied = await request(freeReseller.baseUrl, { scope: 'site', websiteId: FOREIGN_WEBSITE_ID });
  assert.equal(resellerForeignDenied.response.status, 403);
  assert.equal(resellerForeignDenied.payload.error.code, 'terminal_site_forbidden');

  const resellerPremiumRequired = await request(freeReseller.baseUrl, { scope: 'site', websiteId: WEBSITE_ID });
  assert.equal(resellerPremiumRequired.response.status, 403);
  assert.equal(resellerPremiumRequired.payload.error.code, 'premium_license_required');
  assert.equal(resellerPremiumRequired.payload.error.capability, 'resellerAccounts');
});
