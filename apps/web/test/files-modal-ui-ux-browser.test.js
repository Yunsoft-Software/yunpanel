import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createPanelServer } from '../server.js';
import { createApp } from '../../api/src/http/app.js';
import { createApplicationRegistry } from '../../api/src/applications/application-registry.js';
import { createAuthenticatedApi } from '../../api/src/auth/auth-http.js';
import { createAuthStore } from '../../api/src/auth/auth-store.js';
import { createDomainRegistry } from '../../api/src/domains/domain-registry.js';
import { createJobRegistry } from '../../api/src/jobs/job-registry.js';
import {
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  PREMIUM_CAPABILITIES,
} from '../../api/src/panel/license-entitlement-verifier.js';
import { createLicenseEntitlementService } from '../../api/src/panel/license-entitlement-service.js';
import { createServerRegistry } from '../../api/src/runtime/server-registry.js';
import { createSiteFileManager } from '../../api/src/files/site-file-manager.js';
import { executeSiteFileOperation } from '../../api/src/files/site-file-worker.js';
import { createWebsiteRegistry } from '../../api/src/websites/website-registry.js';

function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const kid = computePublicKeyId(spkiDer);
  return { privateKey, publicKeyPem, kid };
}

function signRealEntitlementToken(privateKey, kid, {
  licenseId = 'lic_uiux_browser_01',
  domain = 'panel.example.test',
  instanceId,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const exp = nowSec + 365 * 86400;
  const header = { alg: 'EdDSA', crv: 'Ed25519', typ: ENTITLEMENT_TOKEN_TYPE, kid };
  const payload = {
    iss: ENTITLEMENT_ISSUER,
    sub: licenseId,
    licenseId,
    entitlementVersion: 1,
    iat: nowSec,
    nbf: nowSec,
    exp,
    productCode: 'yunpanel_premium',
    productFamily: 'yunpanel',
    tier: 'premium',
    status: 'active',
    billingModel: 'monthly_term',
    periodMonths: 12,
    startsAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: new Date(exp * 1000).toISOString(),
    domain,
    normalizedDomain: domain,
    allowedHosts: [domain, `www.${domain}`],
    stagingHosts: ['localhost', '127.0.0.1'],
    activatedInstanceId: instanceId,
    capabilities: { ...PREMIUM_CAPABILITIES },
  };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signaturePart = crypto.sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url');
  return `${signingInput}.${signaturePart}`;
}

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
          server.close(() => done());
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        }),
      });
    });
  });
}

test('Real browser acceptance: Files auto-reopen fix, PanelKit modal dirty guard/stacking/busy, and shared UI/UX controls', { timeout: 120_000 }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-uiux-browser-'));
  const prevKeyFile = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
  const prevKeyPem = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;
  const servers = [];
  let authStore = null;
  let browser = null;

  try {
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

    const keys = generateEd25519KeyPair();
    const publicKeyPath = path.join(tmpDir, 'entitlement-public.pem');
    writeFileSync(publicKeyPath, keys.publicKeyPem, { mode: 0o600 });
    process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = publicKeyPath;

    const webRoot = fileURLToPath(new URL('../dist', import.meta.url));
    const webPort = await reserveLoopbackPort();
    const publicOrigin = `http://127.0.0.1:${webPort}`;
    const proxyToken = crypto.randomBytes(32).toString('base64url');
    const masterKey = crypto.randomBytes(32).toString('hex');
    const ownerPassword = 'BrowserOwnerPass!2026';

    authStore = createAuthStore({ filePath: path.join(tmpDir, 'auth.sqlite'), masterKey });
    const setup = authStore.issueSetupToken();
    await authStore.completeSetup({ setupToken: setup.token, username: 'owneradmin', password: ownerPassword });

    const serverRegistry = createServerRegistry({ filePath: path.join(tmpDir, 'servers.json') });
    const localServer = await serverRegistry.createLocalServer({
      hostname: 'panel.example.test',
      displayName: 'Yerel Test Sunucusu',
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

    const jobRegistry = createJobRegistry({ filePath: path.join(tmpDir, 'jobs.json') });
    await jobRegistry.init();

    // Two isolated sites with real files on disk (resolved with fs.realpath for macOS /private/var consistency)
    const appA = await applicationRegistry.createPhpApplication({ serverId: localServerId, name: 'site-a-php' });
    const siteA = await websiteRegistry.createWebsite({ serverId: localServerId, name: 'site-a.example.test', applicationId: appA.id });
    const domainA = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'site-a.example.test',
      targetType: 'php',
      target: { applicationId: appA.id },
      websiteId: siteA.id,
    });
    const subAppA = await applicationRegistry.createPhpApplication({ serverId: localServerId, name: 'blog-site-a-php' });
    const subSiteA = await websiteRegistry.createWebsite({ serverId: localServerId, name: 'blog.site-a.example.test', applicationId: subAppA.id });
    await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'blog.site-a.example.test',
      parentDomainId: domainA.id,
      targetType: 'php',
      target: { applicationId: subAppA.id },
      websiteId: subSiteA.id,
    });

    const appB = await applicationRegistry.createPhpApplication({ serverId: localServerId, name: 'site-b-php' });
    const siteB = await websiteRegistry.createWebsite({ serverId: localServerId, name: 'site-b.example.test', applicationId: appB.id });
    const domainB = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'site-b.example.test',
      targetType: 'php',
      target: { applicationId: appB.id },
      websiteId: siteB.id,
    });

    const siteARootRaw = path.join(tmpDir, 'sites', siteA.id);
    const siteBRootRaw = path.join(tmpDir, 'sites', siteB.id);
    await fs.mkdir(path.join(siteARootRaw, 'public'), { recursive: true });
    await fs.mkdir(siteBRootRaw, { recursive: true });
    await fs.writeFile(path.join(siteARootRaw, 'index.html'), '<h1>Site A</h1>\n', 'utf8');
    await fs.writeFile(path.join(siteARootRaw, 'public', 'notes.txt'), 'Subfolder notes A\n', 'utf8');
    await fs.writeFile(path.join(siteBRootRaw, 'site-b.txt'), 'Only in Site B\n', 'utf8');
    const siteAReal = await fs.realpath(siteARootRaw);
    const siteBReal = await fs.realpath(siteBRootRaw);

    const siteRootMap = new Map([
      [siteA.documentRoot, siteAReal],
      [siteB.documentRoot, siteBReal],
    ]);
    const passwdEntries = [
      `${siteA.unixUser}:x:1001:1001:Site A:${siteAReal}:/usr/sbin/nologin`,
      `${siteB.unixUser}:x:1002:1002:Site B:${siteBReal}:/usr/sbin/nologin`,
    ];
    const mapPath = (targetPath) => {
      for (const [managed, realDir] of siteRootMap.entries()) {
        if (targetPath === managed) return realDir;
        if (targetPath.startsWith(`${managed}/`)) return path.join(realDir, targetPath.slice(managed.length + 1));
      }
      return targetPath;
    };
    const reversePath = (realPathValue) => {
      for (const [managed, realDir] of siteRootMap.entries()) {
        if (realPathValue === realDir) return managed;
        if (realPathValue.startsWith(`${realDir}/`)) return `${managed}/${realPathValue.slice(realDir.length + 1)}`;
      }
      return realPathValue;
    };
    const openedPaths = new Map();
    const workerDeps = {
      chmod: (p, mode) => fs.chmod(mapPath(p), mode),
      link: (oldP, newP) => fs.link(mapPath(oldP), mapPath(newP)),
      lstat: (p) => fs.lstat(mapPath(p)),
      mkdir: (p, options) => fs.mkdir(mapPath(p), options),
      open: async (p, flags, mode) => {
        const handle = await fs.open(mapPath(p), flags, mode);
        openedPaths.set(handle.fd, p);
        return handle;
      },
      readdir: (p, options) => fs.readdir(mapPath(p), options),
      readFile: (p) => fs.readFile(mapPath(p)),
      realpath: async (p) => {
        if (p.startsWith('/proc/self/fd/')) return openedPaths.get(Number(p.split('/').at(-1))) ?? '/unknown-descriptor';
        const mapped = mapPath(p);
        if (mapped !== p) return reversePath(await fs.realpath(mapped));
        return fs.realpath(p);
      },
      rename: (oldP, newP) => fs.rename(mapPath(oldP), mapPath(newP)),
      rm: (p, options) => fs.rm(mapPath(p), options),
      stat: (p) => fs.stat(mapPath(p)),
    };
    const siteFileManager = createSiteFileManager({
      websiteRegistry,
      localServerId,
      getuid: () => 0,
      statFn: (p) => fs.stat(mapPath(p)),
      realpathFn: async (p) => {
        const mapped = mapPath(p);
        if (mapped !== p) {
          await fs.realpath(mapped);
          return p;
        }
        return fs.realpath(p);
      },
      readPasswd: async () => `${passwdEntries.join('\n')}\n`,
      runWorker: async ({ request }) => executeSiteFileOperation(request, workerDeps),
    });

    const licenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicKeyFile: publicKeyPath,
      publicOrigin,
      instanceId: localServerId,
      masterKey,
      development: true,
    });
    await licenseService.activate({ token: signRealEntitlementToken(keys.privateKey, keys.kid, { instanceId: localServerId }) });

    // Real request gate (NOT a mock): holds real POST /api/users before reaching the real handler so busy-state lock is verifiable
    let holdNextUserCreate = false;
    let releaseUserCreate = () => {};
    let userCreateHeldResolve = null;
    const apiListener = createAuthenticatedApi({
      store: authStore,
      publicOrigin,
      development: true,
      ownerMfaRequired: false,
      proxyToken,
      trustedProxyIps: '127.0.0.1',
      licenseEntitlementService: licenseService,
      createHandler: () => createApp({
        registry: serverRegistry,
        localServerId,
        applicationRegistry,
        websiteRegistry,
        domainRegistry,
        jobRegistry,
        siteFileManager,
        userAdminStore: authStore.users,
        authStore,
        licenseEntitlementService: licenseService,
      }),
    });

    const apiServer = await listenServer(http.createServer((req, res) => {
      if (holdNextUserCreate && req.method === 'POST' && req.url?.startsWith('/api/users')) {
        holdNextUserCreate = false;
        const waitGate = new Promise((resolve) => { releaseUserCreate = resolve; });
        userCreateHeldResolve?.();
        waitGate.then(() => apiListener(req, res));
        return;
      }
      apiListener(req, res);
    }));
    servers.push(apiServer);

    const webServer = await listenServer(createPanelServer({
      allowedClientIps: '127.0.0.1',
      apiHost: '127.0.0.1',
      apiPort: apiServer.port,
      publicOrigin,
      proxyToken,
      trustedProxyIps: '127.0.0.1',
      webRoot,
    }), webPort);
    servers.push(webServer);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    const nativeDialogs = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('dialog', (dialog) => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });

    // =========================================================================
    // 1. LOGIN THEME CONTROL (icon-only + accessible name/tooltip)
    // =========================================================================
    await page.goto(`${publicOrigin}/login`, { waitUntil: 'networkidle' });
    const loginThemeBtn = page.locator('button.auth-theme-toggle');
    await loginThemeBtn.waitFor({ timeout: 10_000 });
    assert.equal((await loginThemeBtn.innerText()).trim(), '', 'Login theme toggle must be icon-only with no visible text');
    assert.equal(await loginThemeBtn.locator('svg').count(), 1, 'Login theme toggle must render sun/moon icon');
    assert.equal(await loginThemeBtn.getAttribute('aria-label'), 'Açık temaya geç');
    assert.equal(await loginThemeBtn.getAttribute('title'), 'Açık temaya geç');
    await loginThemeBtn.click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.wsTheme), 'light');
    assert.equal(await loginThemeBtn.getAttribute('aria-label'), 'Gece temasına geç');
    assert.equal(await loginThemeBtn.getAttribute('title'), 'Gece temasına geç');
    await loginThemeBtn.click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.wsTheme), 'dark');

    // Sign in as real Owner
    await page.locator('input[name="username"]').fill('owneradmin');
    await page.locator('input[name="password"]').fill(ownerPassword);
    await page.getByRole('button', { name: 'Giriş yap' }).click();
    await page.getByRole('navigation', { name: 'Panel bölümleri' }).waitFor({ timeout: 15_000 });

    // =========================================================================
    // 2. UNIFIED ICON-FIRST TOPBAR, SINGLE SIDEBAR TOGGLE, NO APPEARANCE FOOTER, TOOLS PADDING, SITE ACCORDION, MOBILE MENU
    // =========================================================================
    const chromeAudit = await page.evaluate(() => {
      const toolbar = document.querySelector('.ws-toolbar');
      const visibleCount = (sel) => [...document.querySelectorAll(sel)].filter((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      }).length;
      return {
        toolbarHeight: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 0,
        appearanceCount: document.querySelectorAll('.ws-appearance').length,
        visibleMobileMenu: visibleCount('.ws-mobile-menu'),
        visibleNavClose: visibleCount('.ws-nav-close'),
        accountBtnText: (document.querySelector('button[aria-label="Hesabım"]')?.textContent ?? '').trim(),
        logoutBtnText: (document.querySelector('button[aria-label="Çıkış yap"]')?.textContent ?? '').trim(),
        aiBtnText: (document.querySelector('button[aria-label="AI asistanı aç"]')?.textContent ?? '').trim(),
      };
    });
    assert.ok(chromeAudit.toolbarHeight > 0 && chromeAudit.toolbarHeight <= 60, `Desktop topbar must be a single crisp row: ${JSON.stringify(chromeAudit)}`);
    assert.equal(chromeAudit.appearanceCount, 0, 'Sidebar must not render legacy Görünüm tercihleri disclosure');
    assert.equal(chromeAudit.visibleMobileMenu, 1, 'Desktop must show exactly one sidebar toggle');
    assert.equal(chromeAudit.visibleNavClose, 0, 'Desktop must NOT show mobile close button inside sidebar');
    assert.equal(chromeAudit.accountBtnText, '', 'Account button in topbar must be icon-only');
    assert.equal(chromeAudit.logoutBtnText, '', 'Logout button in topbar must be icon-only');
    assert.equal(chromeAudit.aiBtnText, '', 'AI assistant button in topbar must be icon-only');

    const toolbarThemeBtn = page.locator('.ws-toolbar-actions button.ws-theme-toggle');
    await toolbarThemeBtn.waitFor({ timeout: 5_000 });
    assert.equal((await toolbarThemeBtn.innerText()).trim(), '', 'Workspace theme toggle must be icon-only');
    assert.equal(await toolbarThemeBtn.locator('svg').count(), 1);
    assert.equal(await toolbarThemeBtn.getAttribute('aria-label'), 'Açık temaya geç');
    assert.equal(await toolbarThemeBtn.getAttribute('title'), 'Açık temaya geç');

    // Light mode Dashboard 1st KPI card readable contrast check
    await page.goto(`${publicOrigin}/dashboard`, { waitUntil: 'networkidle' });
    await toolbarThemeBtn.click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.wsTheme), 'light');
    const firstKpiContrast = await page.evaluate(() => {
      const card = document.querySelector('.ws-console-metrics .ws-metric:first-child');
      const strong = card?.querySelector('strong');
      return {
        bg: card ? getComputedStyle(card).backgroundColor : null,
        text: strong ? getComputedStyle(strong).color : null,
      };
    });
    assert.notEqual(firstKpiContrast.bg, firstKpiContrast.text, 'Light mode first Dashboard KPI card must not have white-on-white text');
    await toolbarThemeBtn.click(); // back to dark

    // Tools & Settings padding & symmetry
    await page.goto(`${publicOrigin}/tools-settings`, { waitUntil: 'networkidle' });
    const toolsLayout = await page.evaluate(() => {
      const grid = document.querySelector('.ws-console-quicklinks');
      const style = grid ? getComputedStyle(grid) : null;
      return {
        paddingTop: style ? parseFloat(style.paddingTop) : 0,
        paddingLeft: style ? parseFloat(style.paddingLeft) : 0,
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    assert.ok(toolsLayout.paddingTop >= 20 && toolsLayout.paddingLeft >= 20, `Tools & Settings quicklinks must have generous section padding: ${JSON.stringify(toolsLayout)}`);
    assert.equal(toolsLayout.overflowX, 0);

    // Site accordion single prominent icon-only buttons + aria-expanded + subdomain info kept
    await page.goto(`${publicOrigin}/websites`, { waitUntil: 'networkidle' });
    const rootCard = page.locator('article.ws-website-task-card').filter({ hasText: 'site-a.example.test' }).first();
    await rootCard.waitFor({ timeout: 10_000 });
    assert.match(await rootCard.innerText(), /1 alt alan adı/, 'Subdomain count info must remain visible');
    const subToggle = rootCard.locator('button.ws-website-subdomains-toggle');
    assert.equal((await subToggle.innerText()).trim(), '', 'Subdomain accordion button must be icon-only');
    assert.equal(await subToggle.getAttribute('aria-expanded'), 'true');
    assert.match(await subToggle.getAttribute('aria-label') ?? '', /alt alan adını daralt/i);
    assert.match(await subToggle.getAttribute('title') ?? '', /alt alan adını daralt/i);
    await subToggle.click();
    assert.equal(await subToggle.getAttribute('aria-expanded'), 'false');
    await subToggle.click();
    assert.equal(await subToggle.getAttribute('aria-expanded'), 'true');

    const toolsToggle = rootCard.locator('button.ws-website-task-toggle');
    assert.equal((await toolsToggle.innerText()).trim(), '', 'Tools accordion button must be icon-only');
    assert.equal(await toolsToggle.getAttribute('aria-expanded'), 'false');
    assert.match(await toolsToggle.getAttribute('aria-label') ?? '', /Tüm araçları göster/i);
    assert.match(await toolsToggle.getAttribute('title') ?? '', /Tüm araçları göster/i);
    await toolsToggle.click();
    assert.equal(await toolsToggle.getAttribute('aria-expanded'), 'true');
    assert.match(await toolsToggle.getAttribute('title') ?? '', /Araçları daralt/i);

    // Mobile menu single close control
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.ws-mobile-menu').click();
    await page.locator('.ws-sidebar.is-open').waitFor({ timeout: 5_000 });
    assert.equal(await page.getByRole('button', { name: 'Menüyü kapat' }).count(), 1, 'Mobile menu must expose exactly one close button');
    // Clicking backdrop closes menu
    await page.mouse.click(350, 400);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.ws-sidebar.is-open').count(), 0);
    await page.setViewportSize({ width: 1440, height: 900 });

    // =========================================================================
    // 3. BUG 1: FILES SITE EDITOR AUTO-REOPEN & BOUNDARY CASES
    // =========================================================================
    await page.goto(`${publicOrigin}/websites/${domainA.id}/files`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /index\.html/ }).first().click();
    const editorDialog = page.locator('dialog.ws-modal[open]').filter({ hasText: 'index.html' });
    await editorDialog.waitFor({ timeout: 10_000 });
    assert.match(page.url(), /file=index\.html/);

    // Close via Kapat -> must stay closed across wait, refresh, folder navigation, and tab round-trip
    await editorDialog.getByRole('button', { name: 'Kapat', exact: true }).click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0, 'Closed file editor must NOT auto-reopen');
    assert.doesNotMatch(page.url(), /file=/, 'Closed file editor must clear ?file= query param');

    // Explicit refresh must keep editor closed
    await page.getByRole('button', { name: 'Dosya listesini yenile' }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0, 'Refreshing files must not reopen closed editor');

    // Explicit reopen works cleanly, then close with Escape
    await page.getByRole('button', { name: /index\.html/ }).first().click();
    await editorDialog.waitFor({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0, 'Closing editor with Escape must stay closed');

    // Dirty editor guard on deep-linked ?file=index.html:
    // outside click -> 2 dialogs -> Escape preserves draft -> outside click -> single Değişiklikleri bırak clears ?file= with ZERO second blocker warning!
    await page.goto(`${publicOrigin}/websites/${domainA.id}/files?file=index.html`, { waitUntil: 'networkidle' });
    await editorDialog.waitFor({ timeout: 10_000 });
    const textarea = editorDialog.locator('textarea');
    await textarea.fill('<h1>Edited draft A</h1>\n');
    await page.mouse.click(10, 10);
    const filesDiscardDialog = page.locator('dialog.ws-modal[open]').filter({ hasText: 'Kaydedilmemiş değişiklikler var' });
    await filesDiscardDialog.waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 2);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 1);
    assert.equal(await textarea.inputValue(), '<h1>Edited draft A</h1>\n', 'Escape on discard warning must preserve file draft');
    await page.mouse.click(10, 10);
    await filesDiscardDialog.waitFor({ timeout: 5_000 });
    await filesDiscardDialog.getByRole('button', { name: 'Düzenlemeye dön', exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 1);
    assert.equal(await textarea.inputValue(), '<h1>Edited draft A</h1>\n', 'Returning to edit must preserve file draft');
    const editorFocused = await page.evaluate(() => {
      const dialog = document.querySelector('dialog.ws-modal[open]');
      return Boolean(dialog && document.activeElement === dialog.querySelector('textarea'));
    });
    assert.equal(editorFocused, true, 'Cancelling discard warning in file editor must restore focus to textarea');
    await page.mouse.click(10, 10);
    await filesDiscardDialog.waitFor({ timeout: 5_000 });
    await filesDiscardDialog.getByRole('button', { name: 'Değişiklikleri bırak', exact: true }).click();
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('dialog[open]').count(), 0, 'Single Değişiklikleri bırak must NOT trigger a second route-leave warning and must not auto-reopen');
    assert.equal(new URL(page.url()).searchParams.has('file'), false, 'Single Değişiklikleri bırak must remove ?file= from URL');

    // Verify real in-app SPA navigation (browser back after SPA transition) while file draft is dirty STILL blocks and protects draft!
    await page.goto(`${publicOrigin}/files`, { waitUntil: 'networkidle' });
    await page.locator('tr').filter({ hasText: /^site-a\.example\.test/ }).first().getByRole('link', { name: /Dosya Yöneticisi/ }).click();
    await page.getByRole('button', { name: /index\.html/ }).first().waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: /index\.html/ }).first().click();
    await editorDialog.waitFor({ timeout: 10_000 });
    await editorDialog.locator('textarea').fill('<h1>Unsaved before browser back</h1>\n');
    await page.evaluate(() => window.history.back());
    const routeLeaveWarn = page.locator('dialog.ws-modal[open]').filter({ hasText: 'Bu sayfadan ayrılırsanız' });
    await routeLeaveWarn.waitFor({ timeout: 5_000 });
    await routeLeaveWarn.getByRole('button', { name: 'Düzenlemeye dön', exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await editorDialog.locator('textarea').inputValue(), '<h1>Unsaved before browser back</h1>\n', 'Cancelling route-leave guard must keep dirty file draft');
    await page.mouse.click(10, 10);
    await filesDiscardDialog.waitFor({ timeout: 5_000 });
    await filesDiscardDialog.getByRole('button', { name: 'Değişiklikleri bırak', exact: true }).click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('dialog[open]').count(), 0);

    // Direct deep link /websites/:id/files?path=public&file=notes.txt opens once, stays closed after close
    await page.goto(`${publicOrigin}/websites/${domainA.id}/files?path=public&file=notes.txt`, { waitUntil: 'networkidle' });
    const notesDialog = page.locator('dialog.ws-modal[open]').filter({ hasText: 'notes.txt' });
    await notesDialog.waitFor({ timeout: 10_000 });
    assert.match(await notesDialog.locator('textarea').inputValue(), /Subfolder notes A/);
    await notesDialog.getByRole('button', { name: 'Kapat', exact: true }).click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0, 'Deep-linked subfolder file must stay closed after close');
    assert.match(page.url(), /path=public/, 'Folder path must remain preserved after closing deep-linked file');
    assert.doesNotMatch(page.url(), /file=/);

    // Direct link on global /files?site=<websiteId>&file=index.html
    await page.goto(`${publicOrigin}/files?site=${encodeURIComponent(siteA.id)}&file=index.html`, { waitUntil: 'networkidle' });
    await editorDialog.waitFor({ timeout: 10_000 });
    await editorDialog.getByRole('button', { name: 'Kapat', exact: true }).click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0, 'Global /files deep link must stay closed after close');

    // Site scoping isolation: Site B shows site-b.txt and never opens Site A's index.html
    await page.goto(`${publicOrigin}/websites/${domainB.id}/files?file=index.html`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /site-b\.txt/ }).first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0, 'Non-existent Site A filename on Site B must not open any editor');

    // =========================================================================
    // 4. BUG 2: MODAL BACKDROP, UNSAVED GUARD, STACKING, REVERT-TO-INITIAL, BUSY & FOCUS
    // =========================================================================
    // 4a. Explicit dirty modal (UserDialog on /settings/users)
    await page.goto(`${publicOrigin}/settings/users`, { waitUntil: 'networkidle' });
    const addUserBtn = page.getByRole('button', { name: /Kullanıcı ekle/i });
    await addUserBtn.click();
    const userModal = page.locator('dialog.ws-modal[open]').filter({ hasText: 'Kullanıcı ekle' });
    await userModal.waitFor({ timeout: 5_000 });

    // Inside click must NOT close
    const modalBox = await userModal.boundingBox();
    await page.mouse.click(modalBox.x + modalBox.width / 2, modalBox.y + 60);
    await page.waitForTimeout(200);
    assert.equal(await userModal.count(), 1, 'Inside click must not close modal');

    // Pointerdown inside -> drag outside -> pointerup on backdrop must NOT close
    await page.mouse.move(modalBox.x + modalBox.width / 2, modalBox.y + 60);
    await page.mouse.down();
    await page.mouse.move(10, 10);
    await page.mouse.up();
    await page.waitForTimeout(200);
    assert.equal(await userModal.count(), 1, 'Dragging from inside modal to backdrop must not close modal');

    // Clean outside click closes immediately without warning
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0, 'Clean modal must close immediately on backdrop click');

    // Dirty modal -> outside click -> shared PanelKit warning with exact title & buttons
    await addUserBtn.click();
    await userModal.waitFor({ timeout: 5_000 });
    const userInput = userModal.locator('input[name="username"]');
    await userInput.fill('taslak-kullanici');
    await page.mouse.click(10, 10);
    const warnDialog = page.locator('dialog.ws-modal[open]').filter({ hasText: 'Kaydedilmemiş değişiklikler var' });
    await warnDialog.waitFor({ timeout: 5_000 });
    assert.equal((await warnDialog.locator('h2').textContent())?.trim(), 'Kaydedilmemiş değişiklikler var');
    assert.equal(await warnDialog.getByRole('button', { name: 'Düzenlemeye dön', exact: true }).count(), 1);
    assert.equal(await warnDialog.getByRole('button', { name: 'Değişiklikleri bırak', exact: true }).count(), 1);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 2, 'Warning dialog must stack cleanly on top of underlying modal');

    // Return to editing via Düzenlemeye dön -> closes ONLY warning, preserves draft, restores focus inside modal
    await warnDialog.getByRole('button', { name: 'Düzenlemeye dön', exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 1);
    assert.equal(await userInput.inputValue(), 'taslak-kullanici');
    const focusInsideAfterCancel = await page.evaluate(() => Boolean(document.querySelector('dialog.ws-modal[open]')?.contains(document.activeElement)));
    assert.equal(focusInsideAfterCancel, true, 'Focus must return inside underlying modal after cancelling warning');

    // Trigger warning again -> Escape closes ONLY topmost warning & preserves draft
    await page.mouse.click(10, 10);
    await warnDialog.waitFor({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 1);
    assert.equal(await userInput.inputValue(), 'taslak-kullanici');

    // Trigger warning again -> backdrop click on warning closes ONLY warning & preserves draft
    await page.mouse.click(10, 10);
    await warnDialog.waitFor({ timeout: 5_000 });
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 1);
    assert.equal(await userInput.inputValue(), 'taslak-kullanici');

    // Revert edited field back to initial value -> treated as clean -> backdrop click closes immediately without warning!
    await userInput.fill('');
    await page.mouse.click(10, 10);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0, 'Form reverted to initial value must be treated as clean');

    // Reopen, edit, trigger warning, explicitly click Değişiklikleri bırak -> closes both!
    await addUserBtn.click();
    await userModal.waitFor({ timeout: 5_000 });
    await userModal.locator('input[name="username"]').fill('discard-user');
    await page.mouse.click(10, 10);
    await warnDialog.waitFor({ timeout: 5_000 });
    await warnDialog.getByRole('button', { name: 'Değişiklikleri bırak', exact: true }).click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0);

    // 4b. Busy lock on real in-flight POST /api/users: backdrop click, Escape, and X button must NOT close while busy
    await addUserBtn.click();
    await userModal.waitFor({ timeout: 5_000 });
    await userModal.locator('input[name="username"]').fill('busytestuser');
    await userModal.locator('input[name="new-password"]').fill('BusyTestPassword!2026');
    const heldPromise = new Promise((resolve) => { userCreateHeldResolve = resolve; });
    holdNextUserCreate = true;
    await userModal.getByRole('button', { name: 'Hesap oluştur', exact: true }).click();
    await heldPromise;
    await page.waitForTimeout(150);
    await page.mouse.click(10, 10);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal(await userModal.count(), 1, 'Busy modal must ignore backdrop click and Escape');
    assert.equal(await warnDialog.count(), 0, 'Busy modal must not open discard warning');
    releaseUserCreate();
    await page.locator('dialog.ws-modal[open]').waitFor({ state: 'detached', timeout: 10_000 });
    await page.getByRole('rowheader', { name: 'busytestuser' }).waitFor({ timeout: 10_000 });

    // 4c. Auto-tracked modal without explicit dirty prop (Yeni dosya in FilesPanel)
    await page.goto(`${publicOrigin}/websites/${domainA.id}/files`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Yeni Dosya' }).click();
    const newFileModal = page.locator('dialog.ws-modal[open]').filter({ hasText: 'Yeni dosya' });
    await newFileModal.waitFor({ timeout: 5_000 });
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);
    assert.equal(await newFileModal.count(), 0, 'Auto-tracked clean modal must close on backdrop click');
    await page.getByRole('button', { name: 'Yeni Dosya' }).click();
    await newFileModal.waitFor({ timeout: 5_000 });
    const fileNameInput = newFileModal.locator('input').first();
    await fileNameInput.fill('draft.txt');
    // Footer Vazgeç button must route through shared ModalCloseButton dirty guard
    await newFileModal.getByRole('button', { name: 'Vazgeç', exact: true }).click();
    await warnDialog.waitFor({ timeout: 5_000 });
    await warnDialog.getByRole('button', { name: 'Düzenlemeye dön', exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await fileNameInput.inputValue(), 'draft.txt', 'Footer Vazgeç -> Düzenlemeye dön must preserve draft');
    await page.mouse.click(10, 10);
    await warnDialog.waitFor({ timeout: 5_000 });
    await warnDialog.getByRole('button', { name: 'Düzenlemeye dön', exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await fileNameInput.inputValue(), 'draft.txt');
    await fileNameInput.fill('');
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0, 'Auto-tracked modal reverted to initial must close cleanly');

    // CommandPalette unified single-border search field check
    await page.locator('button.ws-command-trigger').click();
    const cmdDialog = page.locator('dialog.ws-modal[open]').filter({ hasText: 'Hızlı erişim' });
    await cmdDialog.waitFor({ timeout: 5_000 });
    const cmdMetrics = await page.evaluate(() => {
      const box = document.querySelector('dialog.ws-modal[open] .ws-command-search');
      const input = box?.querySelector('input');
      const style = input ? getComputedStyle(input) : null;
      return {
        boxWidth: box ? box.getBoundingClientRect().width : 0,
        inputBorderTopWidth: style?.borderTopWidth ?? null,
        inputBg: style?.backgroundColor ?? null,
      };
    });
    assert.ok(cmdMetrics.boxWidth >= 280, `Command palette search box must span container cleanly: ${JSON.stringify(cmdMetrics)}`);
    assert.equal(cmdMetrics.inputBorderTopWidth, '0px', `Command palette inner input must have unified borderless styling: ${JSON.stringify(cmdMetrics)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal(await cmdDialog.count(), 0);

    // 4d. AccountDialog ("Hesabım") clean/dirty/stacked-warning/revert check
    await page.getByRole('button', { name: 'Hesabım' }).click();
    const accountDialog = page.locator('dialog.auth-dialog[open]');
    await accountDialog.waitFor({ timeout: 5_000 });
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);
    assert.equal(await accountDialog.count(), 0, 'Clean AccountDialog must close on backdrop click');
    await page.getByRole('button', { name: 'Hesabım' }).click();
    await accountDialog.waitFor({ timeout: 5_000 });
    const currentPwdInput = accountDialog.locator('input[type="password"]').first();
    await currentPwdInput.fill('temp-draft');
    await page.mouse.click(10, 10);
    await warnDialog.waitFor({ timeout: 5_000 });
    await warnDialog.getByRole('button', { name: 'Düzenlemeye dön', exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await accountDialog.count(), 1);
    assert.equal(await currentPwdInput.inputValue(), 'temp-draft');
    await currentPwdInput.fill('');
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);
    assert.equal(await accountDialog.count(), 0, 'Reverted AccountDialog must close cleanly');

    // Keyboard Tab trap check on UserDialog
    await page.goto(`${publicOrigin}/settings/users`, { waitUntil: 'networkidle' });
    await addUserBtn.click();
    await userModal.waitFor({ timeout: 5_000 });
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const stayedInside = await page.evaluate(() => Boolean(document.querySelector('dialog.ws-modal[open]')?.contains(document.activeElement)));
      assert.equal(stayedInside, true, `Tab press #${i + 1} must stay trapped inside modal`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('dialog.ws-modal[open]').count(), 0);

    assert.deepEqual(nativeDialogs, [], 'Zero native window.alert/confirm/prompt dialogs allowed');
    assert.deepEqual(pageErrors, [], `Zero uncaught page errors expected: ${JSON.stringify(pageErrors)}`);
    await context.close();
  } finally {
    if (browser) await browser.close();
    for (const srv of servers) await srv.close().catch(() => {});
    if (authStore) authStore.close();
    if (prevKeyFile === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = prevKeyFile;
    if (prevKeyPem === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM = prevKeyPem;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
