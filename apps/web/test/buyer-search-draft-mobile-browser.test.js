import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { createDomainRegistry } from '../../api/src/domain-registry.js';
import { createServerRegistry } from '../../api/src/server-registry.js';
import { createSiteFileManager } from '../../api/src/site-file-manager.js';
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

test('Real Playwright Chromium E2E (Zero Mocks): Global Search site tasks, Draft site UX & Turkish Files error, Wizard/Chrome deduplication, Turkish /domains, and 320/390/834px mobile navigation', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-wave2b-e2e-'));
  let apiServer = null;
  let webServer = null;
  let browser = null;
  let authStore = null;

  const ownerPassword = 'Wave2BOwnerPassword!2026';

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
    await authStore.completeSetup({
      setupToken: setup.token,
      username: 'owneradmin',
      password: ownerPassword,
    });

    const serverRegistry = createServerRegistry({
      filePath: path.join(tmpDir, 'servers.json'),
    });
    const localServer = await serverRegistry.createLocalServer({
      hostname: 'panel.example.test',
      displayName: 'Wave2B Local Host',
    });
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

    // Real persisted static Application + Website + draft Domain (no deployed /current directory -> real 409 site_files_not_deployed!)
    const draftApp = await applicationRegistry.createApplication({
      serverId: localServerId,
      name: 'draft-static-app',
      repositoryUrl: 'https://github.com/yunpanel/draft-static-app',
    });
    const draftWebsite = await websiteRegistry.createWebsite({
      serverId: localServerId,
      name: 'draft-site.example.test',
      applicationId: draftApp.id,
    });
    const draftDomain = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'draft-site.example.test',
      targetType: 'static',
      target: { root: `/var/www/yunpanel/apps/${draftApp.id}/current` },
      websiteId: draftWebsite.id,
    });

    // Real SiteFileManager using real fs stat/realpath (missing release directory triggers real 409 site_files_not_deployed)
    const siteFileManager = createSiteFileManager({
      websiteRegistry,
      localServerId,
      getuid: () => 0,
    });

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
        siteFileManager,
        userAdminStore: authStore.users,
        authStore,
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
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Real Owner login
    await page.goto(`${publicOrigin}/websites`, { waitUntil: 'networkidle' });
    await page.locator('input[name="username"]').fill('owneradmin');
    await page.locator('input[name="password"]').fill(ownerPassword);
    await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
    await page.getByRole('heading', { name: 'draft-site.example.test' }).waitFor({ timeout: 15_000 });

    // --- ITEM 10 (Duplicate Uygulama Marketi removed from toolbar; single sidebar entry remains) ---
    const marketLinks = page.locator('a[href="/docker"]').filter({ hasText: 'Uygulama Marketi' });
    assert.equal(await marketLinks.count(), 1, 'Owner chrome must expose exactly ONE Uygulama Marketi entry (sidebar only)');

    // --- ITEM 8 (Draft site on Websites list: no Siteyi aç, Kuruluma devam et shown, Dosya Yöneticisi disabled with Turkish reason) ---
    const draftCard = page.locator('article.ws-website-task-card').filter({ hasText: 'draft-site.example.test' });
    assert.equal(await draftCard.getByRole('link', { name: /Siteyi aç/ }).count(), 0, 'Draft site card must not show Siteyi aç');
    await draftCard.getByRole('link', { name: /Kuruluma devam et/ }).waitFor({ timeout: 5_000 });
    const draftFilesButton = draftCard.getByRole('button', { name: /Dosya Yöneticisi/ });
    assert.equal(await draftFilesButton.isDisabled(), true, 'Draft site Dosya Yöneticisi quick button must be disabled');
    assert.ok((await draftCard.innerText()).includes('İlk yayın tamamlandıktan sonra açılır'));

    // --- ITEM 7 (Global Search connected to daily site tasks: yedek, dosya, ssl, posta, terminal) ---
    await page.locator('.ws-command-trigger').click();
    const searchInput = page.getByRole('combobox', { name: /Site, günlük araç/ });
    await searchInput.waitFor({ timeout: 5_000 });

    for (const [keyword, expectedLabel] of [
      ['yedek', 'draft-site.example.test · Yedekleme ve Geri Yükleme'],
      ['dosya', 'draft-site.example.test · Dosya Yöneticisi'],
      ['ssl', 'draft-site.example.test · SSL/TLS Sertifikaları'],
      ['posta', 'draft-site.example.test · E-posta'],
      ['terminal', 'draft-site.example.test · Terminal'],
    ]) {
      await searchInput.fill(keyword);
      const options = await page.locator('#workspace-main, dialog').locator('[role="option"]').allInnerTexts();
      const taskIdx = options.findIndex((text) => text.includes(expectedLabel));
      const fallbackIdx = options.findIndex((text) => text.includes('için tüm sonuçlar'));
      assert.ok(taskIdx >= 0, `Command palette must show "${expectedLabel}" for keyword "${keyword}", got: ${JSON.stringify(options)}`);
      assert.ok(taskIdx < fallbackIdx, `"${expectedLabel}" must appear before generic fallback`);
    }

    // Navigate directly from Command Palette -> site backup tool
    await searchInput.fill('yedek');
    await page.getByRole('option', { name: /draft-site\.example\.test · Yedekleme ve Geri Yükleme/ }).click();
    await page.waitForURL((url) => url.pathname === `/websites/${draftDomain.id}/backup`, { timeout: 10_000 });

    // --- ITEM 10 & ITEM 8 on SiteDetailPage (no Siteyi aç on draft, no Siteyi sil in non-settings header, top-5 daily tools first) ---
    await page.goto(`${publicOrigin}/websites/${draftDomain.id}/overview`, { waitUntil: 'networkidle' });
    await page.locator('[data-site-state-notice="draft"]').waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole('link', { name: /Siteyi aç/ }).count(), 0, 'Draft site detail must not show Siteyi aç');
    assert.equal(await page.getByRole('link', { name: 'Siteyi sil' }).count(), 0, 'Siteyi sil must not appear in overview header');

    const groupTitles = (await page.locator('.yp-plesk-tool-group-title').allTextContents()).map((t) => t.trim());
    assert.deepEqual(groupTitles, ['Sık kullanılan araçlar', 'Geliştirici ve sunucu araçları']);
    const frequentText = await page.locator('.yp-plesk-tool-group').first().innerText();
    for (const dailyTool of ['Dosya Yöneticisi', 'Veritabanları', 'SSL/TLS Sertifikaları', 'E-posta', 'Yedekleme ve Geri Yükleme']) {
      assert.ok(frequentText.includes(dailyTool), `Expected "${dailyTool}" in Sık kullanılan araçlar`);
    }

    // Site Ayarları tab still exposes removal section cleanly
    await page.goto(`${publicOrigin}/websites/${draftDomain.id}/settings`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: /Siteyi.*sil|Kalıcı sil/i }).first().waitFor({ timeout: 10_000 });

    // --- ITEM 8 (Real 409 site_files_not_deployed -> clean Turkish error, NEVER English active release error) ---
    const filesResponsePromise = page.waitForResponse(
      (res) => res.url().includes(`/api/panel/websites/${draftWebsite.id}/files`),
      { timeout: 10_000 },
    );
    await page.goto(`${publicOrigin}/websites/${draftDomain.id}/files`, { waitUntil: 'networkidle' });
    const filesResponse = await filesResponsePromise;
    assert.equal(filesResponse.status(), 409);

    const notDeployedBox = page.locator('[data-files-not-deployed="true"]');
    await notDeployedBox.waitFor({ timeout: 10_000 });
    const filesMainText = await page.locator('main').innerText();
    assert.ok(filesMainText.includes('Bu sitenin henüz etkin bir yayını bulunmuyor'), 'Expected Turkish not-deployed explanation');
    assert.equal(filesMainText.includes('Website does not have an active release'), false, 'Raw English active-release error must never appear');
    await notDeployedBox.getByRole('link', { name: 'Site özetine dön' }).waitFor({ timeout: 5_000 });

    // --- ITEM 10 (New Website Wizard Step 2: WordPress & Static Upload appear ABOVE Next.js / SSR presets) ---
    await page.goto(`${publicOrigin}/websites/new`, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('example.com').fill('wizard-check.example.test');
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();

    const wpCard = page.locator('[data-quick-template="wordpress"]');
    const staticCard = page.locator('[data-quick-template="static_upload"]');
    const nextjsCard = page.locator('[data-preset-id="nextjs"]');
    await wpCard.waitFor({ timeout: 10_000 });
    await staticCard.waitFor({ timeout: 10_000 });
    await nextjsCard.waitFor({ timeout: 10_000 });

    const wpBox = await wpCard.boundingBox();
    const staticBox = await staticCard.boundingBox();
    const nextBox = await nextjsCard.boundingBox();
    assert.ok(wpBox && staticBox && nextBox, 'Wizard template cards must render with bounding boxes');
    assert.ok(wpBox.y < nextBox.y, `WordPress card (y=${wpBox.y}) must appear above Next.js card (y=${nextBox.y})`);
    assert.ok(staticBox.y < nextBox.y, `Static Upload card (y=${staticBox.y}) must appear above Next.js card (y=${nextBox.y})`);

    const sourceModeValues = await page.getByLabel('Site türü').locator('option').evaluateAll(
      (opts) => opts.map((opt) => opt.value),
    );
    assert.equal(sourceModeValues[0], 'new_php');
    assert.equal(sourceModeValues[1], 'new_static_upload');

    // --- ITEM 11 (/domains renders clean Turkish headings & buttons, zero English headings) ---
    await page.goto(`${publicOrigin}/domains`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Alan adı hiyerarşisi' }).waitFor({ timeout: 10_000 });
    await page.getByRole('heading', { name: 'Yeni alan adı' }).waitFor({ timeout: 10_000 });
    await page.getByRole('heading', { name: 'Sertifikalar' }).waitFor({ timeout: 10_000 });

    const domainsText = await page.locator('main').innerText();
    for (const required of [
      'Alan adı hiyerarşisi',
      'Yeni alan adı',
      'Sertifikalar',
      'Alan adı veya alias ara',
      'Tümünü genişlet',
      'Tümünü daralt',
      'Alt alan adı ekle',
      'Hazırla',
      'Alias yok',
    ]) {
      assert.ok(domainsText.includes(required), `Expected Turkish text "${required}" on /domains`);
    }
    for (const forbidden of [
      'Domain hierarchy',
      'New domain',
      'Search domains and aliases',
      'Expand all',
      'Collapse all',
      'Add subdomain',
      'No aliases',
      'Unknown target',
      'Validate ACME',
      'Issue certificate',
    ]) {
      assert.equal(domainsText.includes(forbidden), false, `Forbidden English text "${forbidden}" found on /domains`);
    }

    // --- ITEM 12 (Mobile 320x700, 390x844, and 834x900: visible primary site nav + single selector + zero page horizontal overflow) ---
    for (const [width, height] of [[320, 700], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${publicOrigin}/websites/${draftDomain.id}/overview`, { waitUntil: 'networkidle' });
      const mobileNav = page.locator('[data-mobile-site-nav="true"]');
      await mobileNav.waitFor({ state: 'visible', timeout: 10_000 });

      const mobileSelect = mobileNav.getByLabel('Diğer site araçları');
      assert.equal(await mobileSelect.isVisible(), true, `Diğer site araçları selector must be visible at ${width}px`);

      const primaryLinks = mobileNav.locator('.ws-site-tool-mobile-primary a');
      const linkCount = await primaryLinks.count();
      assert.ok(linkCount >= 4, `Expected at least 4 primary mobile site links at ${width}px, got ${linkCount}`);

      const metrics = await page.evaluate(() => {
        const links = [...document.querySelectorAll('.ws-site-tool-mobile-primary a')];
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          maxRight: Math.max(...links.map((el) => Math.ceil(el.getBoundingClientRect().right))),
        };
      });
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth,
        `Page horizontal overflow at ${width}px: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`,
      );
      assert.ok(
        metrics.maxRight <= width,
        `Mobile primary nav link clipped past ${width}px: maxRight=${metrics.maxRight}`,
      );

      // Selecting another tool from 'Diğer site araçları' navigates cleanly
      await mobileSelect.selectOption('dns');
      await page.waitForURL((url) => url.pathname === `/websites/${draftDomain.id}/dns`, { timeout: 10_000 });
    }

    // 834px tablet viewport: zero page-level horizontal overflow
    await page.setViewportSize({ width: 834, height: 900 });
    await page.goto(`${publicOrigin}/websites/${draftDomain.id}/overview`, { waitUntil: 'networkidle' });
    const tabletOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(
      tabletOverflow.scrollWidth <= tabletOverflow.innerWidth,
      `Tablet horizontal overflow at 834px: scrollWidth=${tabletOverflow.scrollWidth} > innerWidth=${tabletOverflow.innerWidth}`,
    );

    assert.deepEqual(pageErrors, [], `Unexpected pageerror events: ${pageErrors.join('; ')}`);
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (webServer) await webServer.close();
    if (apiServer) await apiServer.close();
    if (authStore) authStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
