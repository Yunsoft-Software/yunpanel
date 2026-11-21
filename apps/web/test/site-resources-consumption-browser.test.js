import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { createPanelServer } from '../server.js';
import { createApp } from '../../api/src/app.js';
import { createApplicationRegistry } from '../../api/src/application-registry.js';
import { createAuthenticatedApi } from '../../api/src/auth-http.js';
import { createAuthStore } from '../../api/src/auth-store.js';
import { createDatabaseBindingRegistry } from '../../api/src/database-binding-registry.js';
import { createDomainRegistry } from '../../api/src/domain-registry.js';
import { createServerRegistry } from '../../api/src/server-registry.js';
import { createWebsiteRegistry } from '../../api/src/website-registry.js';

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function listenServer(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        baseUrl: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

async function signIn(page, { publicOrigin, username, password, waitHeading }) {
  await page.goto(`${publicOrigin}/websites`, { waitUntil: 'networkidle' });
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await page.getByRole('heading', { name: waitHeading }).waitFor({ timeout: 15_000 });
}

test('Real Playwright Chromium E2E (Zero Mocks): Site Kaynakları discoverability, real disk/DB measurement, two-tenant isolation, draft honesty, and real backend failure state', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-resources-e2e-'));
  let apiServer = null;
  let webServer = null;
  let browser = null;
  let authStore = null;

  const ownerPassword = 'ResourcesOwnerPassword!2026';
  const customerAPassword = 'ResourcesCustomerA!2026';
  const customerBPassword = 'ResourcesCustomerB!2026';

  try {
    const webPort = await reserveLoopbackPort();
    const publicOrigin = `http://127.0.0.1:${webPort}`;
    const proxyToken = crypto.randomBytes(32).toString('base64url');
    const masterKey = crypto.randomBytes(32).toString('hex');

    authStore = createAuthStore({
      filePath: path.join(tmpDir, 'auth.sqlite'),
      masterKey,
    });
    const setup = authStore.issueSetupToken();
    await authStore.completeSetup({ setupToken: setup.token, username: 'owneradmin', password: ownerPassword });

    const serverRegistry = createServerRegistry({ filePath: path.join(tmpDir, 'servers.json') });
    const localServer = await serverRegistry.createLocalServer({ hostname: 'panel.resources.test', displayName: 'Local Host' });
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

    // Real sites: Alpha (Customer A, 512 KiB + 2 DBs), Beta (Customer B, 2 MiB + 1 DB), Draft (no release directory on disk)
    const appA = await applicationRegistry.createApplication({ serverId: localServerId, name: 'alpha-app', repositoryUrl: 'https://github.com/yunpanel/alpha' });
    const siteA = await websiteRegistry.createWebsite({ serverId: localServerId, name: 'alpha.example.test', applicationId: appA.id });
    const domainA = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'alpha.example.test',
      targetType: 'static',
      target: { root: `/var/www/yunpanel/apps/${appA.id}/current` },
      websiteId: siteA.id,
    });

    const appB = await applicationRegistry.createApplication({ serverId: localServerId, name: 'beta-app', repositoryUrl: 'https://github.com/yunpanel/beta' });
    const siteB = await websiteRegistry.createWebsite({ serverId: localServerId, name: 'beta.example.test', applicationId: appB.id });
    const domainB = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'beta.example.test',
      targetType: 'static',
      target: { root: `/var/www/yunpanel/apps/${appB.id}/current` },
      websiteId: siteB.id,
    });

    const appDraft = await applicationRegistry.createApplication({ serverId: localServerId, name: 'draft-app', repositoryUrl: 'https://github.com/yunpanel/draft' });
    const siteDraft = await websiteRegistry.createWebsite({ serverId: localServerId, name: 'draft.example.test', applicationId: appDraft.id });
    const domainDraft = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'draft.example.test',
      targetType: 'static',
      target: { root: `/var/www/yunpanel/apps/${appDraft.id}/current` },
      websiteId: siteDraft.id,
    });

    // Real release files on disk
    const staticPublishRoot = path.join(tmpDir, 'static-apps');
    const releaseA = path.join(staticPublishRoot, appA.id, 'releases', 'rel-a1');
    const releaseB = path.join(staticPublishRoot, appB.id, 'releases', 'rel-b1');
    mkdirSync(releaseA, { recursive: true });
    mkdirSync(releaseB, { recursive: true });
    symlinkSync(releaseA, path.join(staticPublishRoot, appA.id, 'current'));
    symlinkSync(releaseB, path.join(staticPublishRoot, appB.id, 'current'));
    writeFileSync(path.join(releaseA, 'bundle.bin'), Buffer.alloc(512 * 1024, 0x41));
    writeFileSync(path.join(releaseB, 'foreign-2mb.bin'), Buffer.alloc(2 * 1024 * 1024, 0x42));
    symlinkSync(releaseB, path.join(releaseA, 'foreign-escape'));

    // Real database bindings: 2 for Alpha (exceeds Customer A's defined maxDatabases=1, unenforced!), 1 for Beta
    await databaseBindingRegistry.bindDatabase({
      serverId: localServerId,
      databaseName: 'alpha_primary',
      websiteId: siteA.id,
      applicationId: appA.id,
      confirmation: `bind-database:${localServerId}:alpha_primary:${siteA.id}`,
    });
    await databaseBindingRegistry.bindDatabase({
      serverId: localServerId,
      databaseName: 'alpha_reports',
      websiteId: siteA.id,
      applicationId: appA.id,
      confirmation: `bind-database:${localServerId}:alpha_reports:${siteA.id}`,
    });
    await databaseBindingRegistry.bindDatabase({
      serverId: localServerId,
      databaseName: 'beta_primary',
      websiteId: siteB.id,
      applicationId: appB.id,
      confirmation: `bind-database:${localServerId}:beta_primary:${siteB.id}`,
    });

    // Real SQLite customers + quotas + site ownership
    const ownerSession = await authStore.login({ username: 'owneradmin', password: ownerPassword, ip: '127.0.0.1' });
    const allowOwner = (s) => s;
    const customerA = await authStore.hostingAccounts.createOwnerLogin(ownerSession.token, allowOwner, {
      kind: 'customer',
      username: 'customer_alpha',
      password: customerAPassword,
      quotas: { maxWebsites: 3, maxDiskMb: 500, maxTrafficMb: 10000, maxDatabases: 1 },
    });
    const customerB = await authStore.hostingAccounts.createOwnerLogin(ownerSession.token, allowOwner, {
      kind: 'customer',
      username: 'customer_beta',
      password: customerBPassword,
      quotas: { maxWebsites: 2, maxDiskMb: 250, maxTrafficMb: 5000, maxDatabases: 2 },
    });
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

    const webRoot = path.resolve(new URL('../dist', import.meta.url).pathname);
    webServer = await listenServer(
      createPanelServer({
        allowedClientIps: '127.0.0.1',
        apiHost: '127.0.0.1',
        apiPort: apiServer.port,
        publicOrigin,
        proxyToken,
        trustedProxyIps: '127.0.0.1',
        webRoot,
      }),
      webPort,
    );

    browser = await chromium.launch({ headless: true });

    // --- 1. OWNER: Discover Site Kaynakları directly from Site Detail (NO manual URL typing!) ---
    const ownerContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const ownerPage = await ownerContext.newPage();
    const ownerErrors = [];
    ownerPage.on('pageerror', (err) => ownerErrors.push(err.message));

    await signIn(ownerPage, { publicOrigin, username: 'owneradmin', password: ownerPassword, waitHeading: 'alpha.example.test' });
    await ownerPage.getByRole('link', { name: 'alpha.example.test' }).first().click();
    await ownerPage.waitForURL((url) => url.pathname.startsWith(`/websites/${domainA.id}`), { timeout: 10_000 });

    // Verify Site Kaynakları is visible both in site navigation AND quick tool shortcut cards
    const navResourceLink = ownerPage.locator('nav[aria-label="Site araçları"] a', { hasText: 'Site Kaynakları' }).first();
    await navResourceLink.waitFor({ timeout: 5_000 });
    const cardResourceLink = ownerPage.locator('.ws-console-quicklinks a', { hasText: 'Site Kaynakları' }).first();
    await cardResourceLink.waitFor({ timeout: 5_000 });

    // Click visible Site Kaynakları card (zero manual URL typing)
    await cardResourceLink.click();
    await ownerPage.waitForURL((url) => url.pathname === `/websites/${domainA.id}/resources`, { timeout: 10_000 });

    // Wait for real consumption fetch to complete and render rows
    await ownerPage.locator('tr[data-consumption-metric="diskSpaceMb"]').waitFor({ timeout: 10_000 });
    const consumptionPanel = ownerPage.locator('[data-site-consumption-measured-at]');
    const measuredAttr = await consumptionPanel.getAttribute('data-site-consumption-measured-at');
    assert.ok(measuredAttr && Number.isFinite(Date.parse(measuredAttr)), `expected real ISO measuredAt, got "${measuredAttr}"`);

    const panelText = await ownerPage.locator('main').innerText();
    assert.match(panelText, /Son ölçüm:/);
    assert.match(panelText, /Aktif sürüm içerik kökü/);
    assert.match(panelText, /Uygulanmıyor/);
    assert.match(panelText, /Kota Limiti Aşıldı/);
    assert.match(panelText, /uygulanan bir kaynak sınırı aşılmıştır/);
    assert.match(panelText, /Nginx erişim günlüğü kapalı/);

    const diskRowText = await ownerPage.locator('tr[data-consumption-metric="diskSpaceMb"]').innerText();
    assert.match(diskRowText, /MB/);
    assert.doesNotMatch(diskRowText, /Ölçülemedi/);
    assert.match(diskRowText, /500 MB/);
    assert.match(diskRowText, /Uygulanmıyor/);

    const dbRowText = await ownerPage.locator('tr[data-consumption-metric="databases"]').innerText();
    assert.match(dbRowText, /\b2\b/);
    assert.match(dbRowText, /Hesap kotası/);
    assert.match(dbRowText, /Hesap geneli veritabanı sınırı/);
    assert.match(dbRowText, /Aşıldı/);

    const trafficRowText = await ownerPage.locator('tr[data-consumption-metric="trafficMb"]').innerText();
    assert.match(trafficRowText, /Ölçülemiyor/);
    assert.match(trafficRowText, /10\.000 MB/);

    // --- 2. OWNER: Draft site (unmeasured disk -> Ölçülemedi + zero fake 0) ---
    await ownerPage.goto(`${publicOrigin}/websites/${domainDraft.id}/resources`, { waitUntil: 'networkidle' });
    const draftDiskRow = ownerPage.locator('tr[data-consumption-metric="diskSpaceMb"]');
    await draftDiskRow.waitFor({ timeout: 10_000 });
    const draftDiskText = await draftDiskRow.innerText();
    assert.match(draftDiskText, /Ölçülemedi/);
    assert.match(draftDiskText, /Site dosya kökü henüz sunucuda oluşturulmadığı için/);
    assert.match(draftDiskText, /Henüz ölçülmedi/);
    assert.doesNotMatch(draftDiskText, /0 B/);
    assert.deepEqual(ownerErrors, []);
    await ownerContext.close();

    // --- 3. TWO-TENANT ISOLATION: Customer A sees own site via WebsitesPage link; Customer B blocked from Customer A ---
    const custAContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const custAPage = await custAContext.newPage();
    await signIn(custAPage, { publicOrigin, username: 'customer_alpha', password: customerAPassword, waitHeading: 'alpha.example.test' });
    const custABreakdownLink = custAPage.locator('[data-customer-site-breakdown="true"] a', { hasText: 'Site Kaynakları' }).first();
    await custABreakdownLink.waitFor({ timeout: 5_000 });
    await custABreakdownLink.click();
    await custAPage.waitForURL((url) => url.pathname === `/websites/${domainA.id}/resources`, { timeout: 10_000 });
    await custAPage.locator('tr[data-consumption-metric="diskSpaceMb"]').waitFor({ timeout: 10_000 });
    assert.match(await custAPage.locator('tr[data-consumption-metric="databases"]').innerText(), /\b2\b/);
    await custAContext.close();

    const custBContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const custBPage = await custBContext.newPage();
    await signIn(custBPage, { publicOrigin, username: 'customer_beta', password: customerBPassword, waitHeading: 'beta.example.test' });
    // Direct API probe from Customer B browser session against Customer A's website MUST be 403
    const crossTenantStatus = await custBPage.evaluate(async (foreignWebsiteId) => {
      const res = await fetch(`/api/panel/websites/${encodeURIComponent(foreignWebsiteId)}/consumption`, { credentials: 'same-origin' });
      return res.status;
    }, siteA.id);
    assert.equal(crossTenantStatus, 403, 'Customer B must receive 403 for Customer A consumption endpoint');
    // Direct UI navigation to Customer A's domain resources must NOT leak Customer A data
    await custBPage.goto(`${publicOrigin}/websites/${domainA.id}/resources`, { waitUntil: 'networkidle' });
    assert.equal(await custBPage.locator('tr[data-consumption-metric="diskSpaceMb"]').count(), 0);
    assert.match(await custBPage.locator('main').innerText(), /Web sitesi bulunamadı/);
    await custBContext.close();

    // --- 4. REAL BACKEND FAILURE: stop upstream API server -> Yenile clears stale table, shows ErrorNotice + Yeniden dene with ZERO fake 0 ---
    const failContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const failPage = await failContext.newPage();
    await signIn(failPage, { publicOrigin, username: 'owneradmin', password: ownerPassword, waitHeading: 'alpha.example.test' });
    await failPage.goto(`${publicOrigin}/websites/${domainA.id}/resources`, { waitUntil: 'networkidle' });
    await failPage.locator('tr[data-consumption-metric="diskSpaceMb"]').waitFor({ timeout: 10_000 });

    // Close real upstream API server -> createPanelServer produces a genuine 502 upstream error!
    await apiServer.close();
    apiServer = null;

    await failPage.locator('section').filter({ hasText: 'Site Kaynakları' }).getByRole('button', { name: 'Yenile', exact: true }).click();
    await failPage.getByRole('button', { name: 'Yeniden dene', exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await failPage.locator('table[aria-label="Kaynak Tüketimi"]').count(), 0, 'failed backend must clear stale table and render ZERO fake rows');
    assert.equal(await failPage.locator('[data-site-consumption-measured-at]').getAttribute('data-site-consumption-measured-at'), '');
    assert.match(await failPage.locator('section').filter({ hasText: 'Site Kaynakları' }).innerText(), /Henüz ölçülmedi/);
    await failContext.close();
  } finally {
    await browser?.close();
    await webServer?.close();
    await apiServer?.close();
    authStore?.close?.();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
