import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/app.js';
import { createApplicationRegistry } from '../src/applications/application-registry.js';
import { createAuthenticatedApi } from '../src/auth/auth-http.js';
import { createAuthStore } from '../src/auth/auth-store.js';
import { createDatabaseBindingRegistry } from '../src/databases/database-binding-registry.js';
import { createDomainRegistry } from '../src/domains/domain-registry.js';
import { createServerRegistry } from '../src/runtime/server-registry.js';
import { createWebsiteRegistry } from '../src/websites/website-registry.js';

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

async function loginCookie(baseUrl, { username, password, proxyToken }) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-yunpanel-proxy-token': proxyToken,
      'x-yunpanel-client-ip': '127.0.0.1',
      origin: 'http://127.0.0.1:3000',
    },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login failed for ${username}: ${await res.clone().text()}`);
  const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  return setCookies.map((header) => header.split(';')[0]).join('; ');
}

test('Real createApp site consumption: real disk + active DB count + customer defined limits (unenforced) + two-tenant isolation + draft/failure honesty', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-api-consumption-'));
  let apiServer = null;
  let unconfiguredServer = null;
  let authStore = null;

  const ownerPassword = 'OwnerStrongPassword!2026';
  const customerAPassword = 'CustomerAStrongPassword!2026';
  const customerBPassword = 'CustomerBStrongPassword!2026';

  try {
    const proxyToken = crypto.randomBytes(32).toString('base64url');
    const masterKey = crypto.randomBytes(32).toString('hex');
    const publicOrigin = 'http://127.0.0.1:3000';

    authStore = createAuthStore({
      filePath: path.join(tmpDir, 'auth.sqlite'),
      masterKey,
    });
    const setup = authStore.issueSetupToken();
    await authStore.completeSetup({ setupToken: setup.token, username: 'owneradmin', password: ownerPassword });

    const serverRegistry = createServerRegistry({ filePath: path.join(tmpDir, 'servers.json') });
    const localServer = await serverRegistry.createLocalServer({ hostname: 'panel.local.test', displayName: 'Local Host' });
    const localServerId = localServer.id;

    const applicationRegistry = createApplicationRegistry({
      filePath: path.join(tmpDir, 'applications.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    });
    await applicationRegistry.init();

    const websiteRegistry = createWebsiteRegistry({
      filePath: path.join(tmpDir, 'websites.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
      getApplication: (id) => applicationRegistry.getApplication(id),
    });
    await websiteRegistry.init();

    const domainRegistry = createDomainRegistry({
      filePath: path.join(tmpDir, 'domains.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
      getWebsite: (id) => websiteRegistry.getWebsite(id),
    });
    await domainRegistry.init();

    const databaseBindingRegistry = createDatabaseBindingRegistry({
      filePath: path.join(tmpDir, 'db-bindings.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
      getWebsite: (id) => websiteRegistry.getWebsite(id),
      getApplication: (id) => applicationRegistry.getApplication(id),
    });
    await databaseBindingRegistry.init();

    // Real applications + websites + domains for Tenant A, Tenant B, and Draft site
    const appA = await applicationRegistry.createApplication({ serverId: localServerId, name: 'tenant-a-static', repositoryUrl: 'https://github.com/yunpanel/tenant-a' });
    const siteA = await websiteRegistry.createWebsite({ serverId: localServerId, name: 'alpha.example.test', applicationId: appA.id });
    await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'alpha.example.test',
      targetType: 'static',
      target: { root: `/var/www/yunpanel/apps/${appA.id}/current` },
      websiteId: siteA.id,
    });

    const appB = await applicationRegistry.createApplication({ serverId: localServerId, name: 'tenant-b-static', repositoryUrl: 'https://github.com/yunpanel/tenant-b' });
    const siteB = await websiteRegistry.createWebsite({ serverId: localServerId, name: 'beta.example.test', applicationId: appB.id });
    await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'beta.example.test',
      targetType: 'static',
      target: { root: `/var/www/yunpanel/apps/${appB.id}/current` },
      websiteId: siteB.id,
    });

    const appDraft = await applicationRegistry.createApplication({ serverId: localServerId, name: 'draft-static', repositoryUrl: 'https://github.com/yunpanel/draft' });
    const siteDraft = await websiteRegistry.createWebsite({ serverId: localServerId, name: 'draft.example.test', applicationId: appDraft.id });
    await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'draft.example.test',
      targetType: 'static',
      target: { root: `/var/www/yunpanel/apps/${appDraft.id}/current` },
      websiteId: siteDraft.id,
    });

    // Real atomic release directories (current -> releases/rel-1) for Tenant A (256 KiB + symlink trap to Tenant B) and Tenant B (2 MiB); Draft NOT created on disk
    const staticPublishRoot = path.join(tmpDir, 'static-apps');
    const siteAContainer = path.join(staticPublishRoot, appA.id);
    const siteARelease = path.join(siteAContainer, 'releases', 'rel-1');
    const siteBContainer = path.join(staticPublishRoot, appB.id);
    const siteBRelease = path.join(siteBContainer, 'releases', 'rel-1');
    mkdirSync(siteARelease, { recursive: true });
    mkdirSync(siteBRelease, { recursive: true });
    symlinkSync(siteARelease, path.join(siteAContainer, 'current'));
    symlinkSync(siteBRelease, path.join(siteBContainer, 'current'));
    writeFileSync(path.join(siteARelease, 'site-a.bin'), Buffer.alloc(256 * 1024, 0x41));
    writeFileSync(path.join(siteBRelease, 'tenant-b-secret.bin'), Buffer.alloc(2 * 1024 * 1024, 0x42));
    symlinkSync(siteBRelease, path.join(siteARelease, 'foreign-link'));

    // Real database bindings: 2 for Site A, 1 for Site B, 0 for Draft
    await databaseBindingRegistry.bindDatabase({
      serverId: localServerId,
      databaseName: 'alpha_main',
      websiteId: siteA.id,
      applicationId: appA.id,
      confirmation: `bind-database:${localServerId}:alpha_main:${siteA.id}`,
    });
    await databaseBindingRegistry.bindDatabase({
      serverId: localServerId,
      databaseName: 'alpha_analytics',
      websiteId: siteA.id,
      applicationId: appA.id,
      confirmation: `bind-database:${localServerId}:alpha_analytics:${siteA.id}`,
    });
    await databaseBindingRegistry.bindDatabase({
      serverId: localServerId,
      databaseName: 'beta_main',
      websiteId: siteB.id,
      applicationId: appB.id,
      confirmation: `bind-database:${localServerId}:beta_main:${siteB.id}`,
    });

    // Create real Customer A (with defined quotas: maxDiskMb=500, maxTrafficMb=10000, maxDatabases=1) and Customer B in SQLite AuthStore
    const ownerSession = await authStore.login({ username: 'owneradmin', password: ownerPassword, ip: '127.0.0.1' });
    const allowOwner = (session) => session;
    const customerA = await authStore.hostingAccounts.createOwnerLogin(ownerSession.token, allowOwner, {
      kind: 'customer',
      username: 'customer_a',
      password: customerAPassword,
      quotas: { maxWebsites: 3, maxDiskMb: 500, maxTrafficMb: 10000, maxDatabases: 1 },
    });
    const customerB = await authStore.hostingAccounts.createOwnerLogin(ownerSession.token, allowOwner, {
      kind: 'customer',
      username: 'customer_b',
      password: customerBPassword,
      quotas: { maxWebsites: 2, maxDiskMb: 250, maxTrafficMb: 5000, maxDatabases: 2 },
    });

    // Bind Customer A -> Site A and Customer B -> Site B via official hostingAccounts.allocateCustomerSite
    authStore.hostingAccounts.allocateCustomerSite(ownerSession.token, allowOwner, { customerId: customerA.id, site: siteA });
    authStore.hostingAccounts.allocateCustomerSite(ownerSession.token, allowOwner, { customerId: customerB.id, site: siteB });

    const apiListener = createAuthenticatedApi({
      store: authStore,
      publicOrigin,
      development: true,
      ownerMfaRequired: false,
      proxyToken,
      trustedProxyIps: '127.0.0.1',
      createHandler: () => createApp({
        registry: serverRegistry,
        localServerId,
        applicationRegistry,
        websiteRegistry,
        domainRegistry,
        databaseBindingRegistry,
        userAdminStore: authStore.users,
        authStore,
        siteConsumptionPathContractOptions: { staticPublishRoot },
        siteConsumptionAllowCurrentUserWithoutSetpriv: true,
      }),
    });
    apiServer = await listenServer(http.createServer(apiListener));

    const ownerCookie = await loginCookie(apiServer.baseUrl, { username: 'owneradmin', password: ownerPassword, proxyToken });
    const customerACookie = await loginCookie(apiServer.baseUrl, { username: 'customer_a', password: customerAPassword, proxyToken });
    const customerBCookie = await loginCookie(apiServer.baseUrl, { username: 'customer_b', password: customerBPassword, proxyToken });

    const reqHeaders = (cookie) => ({
      cookie,
      'x-yunpanel-proxy-token': proxyToken,
      'x-yunpanel-client-ip': '127.0.0.1',
    });

    // 1. Owner inspects Site A via default management-app.js wiring
    const ownerRes = await fetch(`${apiServer.baseUrl}/api/websites/${siteA.id}/consumption`, { headers: reqHeaders(ownerCookie) });
    assert.equal(ownerRes.status, 200);
    const { data: siteAConsumption } = await ownerRes.json();

    assert.equal(siteAConsumption.websiteId, siteA.id);
    assert.equal(siteAConsumption.customerId, customerA.id);
    assert.ok(siteAConsumption.measuredAt && Number.isFinite(Date.parse(siteAConsumption.measuredAt)), 'top-level measuredAt must be real ISO timestamp');
    assert.ok(siteAConsumption.metrics.diskSpaceMb.bytes >= 256 * 1024);
    assert.ok(siteAConsumption.metrics.diskSpaceMb.bytes < 1024 * 1024, 'symlink trap to Tenant B must NEVER be counted');
    assert.equal(siteAConsumption.metrics.diskSpaceMb.scope, 'active_release_root');
    assert.equal(siteAConsumption.metrics.diskSpaceMb.definedLimit, 500);
    assert.equal(siteAConsumption.metrics.diskSpaceMb.definedLimitScope, 'customer_account');
    assert.equal(siteAConsumption.metrics.diskSpaceMb.enforcedLimit, null);
    assert.equal(siteAConsumption.metrics.diskSpaceMb.enforced, false);

    assert.equal(siteAConsumption.metrics.databases.measured, 2);
    assert.equal(siteAConsumption.metrics.databases.definedLimit, 1);
    assert.equal(siteAConsumption.metrics.databases.definedLimitScope, 'customer_account');
    assert.equal(siteAConsumption.metrics.databases.enforcedLimit, 1);
    assert.equal(siteAConsumption.metrics.databases.enforced, true);
    assert.equal(siteAConsumption.metrics.databases.enforcementScope, 'customer_account_databases');
    assert.equal(siteAConsumption.metrics.databases.exceeded, true);

    assert.equal(siteAConsumption.metrics.trafficMb.measured, null);
    assert.equal(siteAConsumption.metrics.trafficMb.unknown, true);
    assert.equal(siteAConsumption.metrics.trafficMb.definedLimit, 10000);
    assert.equal(siteAConsumption.metrics.trafficMb.enforcedLimit, null);
    assert.equal(siteAConsumption.metrics.trafficMb.reasonCode, 'traffic_source_unavailable');
    assert.equal(siteAConsumption.categories.traffic.usageMb.metric, 'trafficMb');

    // /quotas alias returns same canonical report
    const quotasRes = await fetch(`${apiServer.baseUrl}/api/websites/${siteA.id}/quotas`, { headers: reqHeaders(ownerCookie) });
    assert.equal(quotasRes.status, 200);
    const { data: siteAQuotas } = await quotasRes.json();
    assert.equal(siteAQuotas.metrics.databases.measured, 2);
    assert.equal(siteAQuotas.metrics.diskSpaceMb.definedLimit, 500);

    // 2. Customer A accesses own Site A -> 200
    const custARes = await fetch(`${apiServer.baseUrl}/api/websites/${siteA.id}/consumption`, { headers: reqHeaders(customerACookie) });
    assert.equal(custARes.status, 200);
    const { data: custAData } = await custARes.json();
    assert.equal(custAData.metrics.databases.measured, 2);
    assert.equal(custAData.metrics.diskSpaceMb.definedLimit, 500);
    assert.equal(custAData.metrics.diskSpaceMb.enforcedLimit, null);

    // 3. Two-tenant isolation: Customer B -> Site A MUST be 403; Customer A -> Site B MUST be 403
    const crossBA = await fetch(`${apiServer.baseUrl}/api/websites/${siteA.id}/consumption`, { headers: reqHeaders(customerBCookie) });
    assert.equal(crossBA.status, 403);
    const crossBAQuotas = await fetch(`${apiServer.baseUrl}/api/websites/${siteA.id}/quotas`, { headers: reqHeaders(customerBCookie) });
    assert.equal(crossBAQuotas.status, 403);
    const crossAB = await fetch(`${apiServer.baseUrl}/api/websites/${siteB.id}/consumption`, { headers: reqHeaders(customerACookie) });
    assert.equal(crossAB.status, 403);

    // 4. Draft site: disk is unmeasured (null + measuredAt: null + site_root_not_deployed), DB count is real 0
    const draftRes = await fetch(`${apiServer.baseUrl}/api/websites/${siteDraft.id}/consumption`, { headers: reqHeaders(ownerCookie) });
    assert.equal(draftRes.status, 200);
    const { data: draftData } = await draftRes.json();
    assert.equal(draftData.metrics.diskSpaceMb.measured, null);
    assert.equal(draftData.metrics.diskSpaceMb.measuredAt, null);
    assert.equal(draftData.metrics.diskSpaceMb.reasonCode, 'site_root_not_deployed');
    assert.equal(draftData.metrics.databases.measured, 0);

    // 5. When ZERO metrics can be measured (draft site + unavailable DB registry), top-level measuredAt MUST be null!
    const unconfiguredListener = createAuthenticatedApi({
      store: authStore,
      publicOrigin,
      development: true,
      ownerMfaRequired: false,
      proxyToken,
      trustedProxyIps: '127.0.0.1',
      createHandler: () => createApp({
        registry: serverRegistry,
        localServerId,
        applicationRegistry,
        websiteRegistry,
        domainRegistry,
        databaseBindingRegistry: null,
        userAdminStore: authStore.users,
        authStore,
        siteConsumptionPathContractOptions: { staticPublishRoot },
        siteConsumptionAllowCurrentUserWithoutSetpriv: true,
      }),
    });
    unconfiguredServer = await listenServer(http.createServer(unconfiguredListener));
    const zeroMeasuredRes = await fetch(`${unconfiguredServer.baseUrl}/api/websites/${siteDraft.id}/consumption`, { headers: reqHeaders(ownerCookie) });
    assert.equal(zeroMeasuredRes.status, 200);
    const { data: zeroMeasuredData } = await zeroMeasuredRes.json();
    assert.equal(zeroMeasuredData.metrics.diskSpaceMb.measured, null);
    assert.equal(zeroMeasuredData.metrics.databases.measured, null);
    assert.equal(zeroMeasuredData.metrics.trafficMb.measured, null);
    assert.equal(zeroMeasuredData.measuredAt, null, 'top-level measuredAt MUST be null when zero metrics were measured');
  } finally {
    await apiServer?.close();
    await unconfiguredServer?.close();
    authStore?.close?.();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
