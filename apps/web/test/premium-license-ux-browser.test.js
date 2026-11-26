import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { createPanelServer } from '../server.js';
import { createApp } from '../../api/src/http/app.js';
import { createAuthenticatedApi } from '../../api/src/auth/auth-http.js';
import { createAuthStore } from '../../api/src/auth/auth-store.js';
import {
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  PREMIUM_CAPABILITIES,
} from '../../api/src/panel/license-entitlement-verifier.js';
import { createLicenseEntitlementService } from '../../api/src/panel/license-entitlement-service.js';
import { createServerRegistry } from '../../api/src/runtime/server-registry.js';

function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const kid = computePublicKeyId(spkiDer);
  return { privateKey, publicKeyPem, kid };
}

function signRealEntitlementToken(privateKey, kid, {
  licenseId = 'lic_wave1_ux_01',
  entitlementVersion = 1,
  periodMonths = 12,
  domain = 'panel.example.test',
  instanceId,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const exp = nowSec + 365 * 86400;
  const header = {
    alg: 'EdDSA',
    crv: 'Ed25519',
    typ: ENTITLEMENT_TOKEN_TYPE,
    kid,
  };
  const payload = {
    iss: ENTITLEMENT_ISSUER,
    sub: licenseId,
    licenseId,
    entitlementVersion,
    iat: nowSec,
    nbf: nowSec,
    exp,
    productCode: 'yunpanel_premium',
    productFamily: 'yunpanel',
    tier: 'premium',
    status: 'active',
    billingModel: 'monthly_term',
    periodMonths,
    startsAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: new Date(exp * 1000).toISOString(),
    domain,
    normalizedDomain: domain,
    allowedHosts: [domain, `www.${domain}`],
    stagingHosts: [`staging.${domain}`, `dev.${domain}`, 'localhost', '127.0.0.1'],
    activatedInstanceId: instanceId,
    capabilities: { ...PREMIUM_CAPABILITIES },
  };
  const headerPart = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerPart}.${payloadPart}`;
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
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

async function assertNoSecretsLeaked(page, secrets) {
  const snapshot = await page.evaluate(() => ({
    href: window.location.href,
    localStorage: JSON.stringify(Object.entries(window.localStorage)),
    sessionStorage: JSON.stringify(Object.entries(window.sessionStorage)),
  }));
  const combined = `${snapshot.href}\n${snapshot.localStorage}\n${snapshot.sessionStorage}`;
  for (const secret of secrets) {
    assert.equal(combined.includes(secret), false, `Secret marker leaked to URL or Web Storage: ${secret}`);
  }
}

test('Real Playwright Chromium E2E: Free Owner sees early Premium notices & backend 403, activates real Ed25519 Premium, returns to task and creates real Reseller + Customer with zero secret leakage', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-premium-ux-e2e-'));
  let apiServer = null;
  let webServer = null;
  let browser = null;
  let authStore = null;
  const previousEnvKeyFile = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
  const previousEnvKeyPem = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

  const ownerPassword = 'StrongWave1OwnerPassword!2026';
  const resellerPassword = 'StrongWave1ResellerPass!2026';
  const customerPassword = 'StrongWave1CustomerPass!2026';
  const secrets = [ownerPassword, resellerPassword, customerPassword];

  try {
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

    const keys = generateEd25519KeyPair();
    const publicKeyPath = path.join(tmpDir, 'entitlement-public.pem');
    writeFileSync(publicKeyPath, keys.publicKeyPem, { mode: 0o600 });
    process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = publicKeyPath;

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
      displayName: 'Local Wave 1 Host',
    });
    const localServerId = localServer.id;

    const licenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicKeyFile: publicKeyPath,
      publicOrigin,
      instanceId: localServerId,
      masterKey,
      development: true,
    });

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
        userAdminStore: authStore.users,
        authStore,
        licenseEntitlementService: licenseService,
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

    // --- PART A: Free Owner Experience ---
    await page.goto(`${publicOrigin}/websites`, { waitUntil: 'networkidle' });
    await page.locator('input[name="username"]').fill('owneradmin');
    await page.locator('input[name="password"]').fill(ownerPassword);
    await page.getByRole('button', { name: 'Giriş yap' }).click();

    const sidebar = page.getByRole('navigation', { name: 'Panel bölümleri' });
    await sidebar.waitFor({ timeout: 15_000 });

    // Sidebar shows Premium indicator on Müşteriler & Bayiler, NOT on Free Owner tools
    const resellersNav = sidebar.locator('a[href="/resellers"]');
    const customersNav = sidebar.locator('a[href="/customers"]');
    const websitesNav = sidebar.locator('a[href="/websites"]');
    await resellersNav.locator('[data-premium-badge="true"]').waitFor({ timeout: 10_000 });
    await customersNav.locator('[data-premium-badge="true"]').waitFor({ timeout: 10_000 });
    assert.equal(await websitesNav.locator('[data-premium-badge="true"]').count(), 0);

    // Free Owner normal site creation stays open under "Yönetim hesabım", while Premium owner modes show early notice BEFORE password fields
    await page.goto(`${publicOrigin}/websites/new`, { waitUntil: 'networkidle' });
    const ownerSelect = page.getByLabel('Site sahibi');
    await ownerSelect.waitFor({ timeout: 10_000 });
    assert.equal(await ownerSelect.inputValue(), 'owner');
    const continueButton = page.getByRole('button', { name: 'Devam et', exact: true });
    assert.equal(await continueButton.isDisabled(), false, 'Free Owner creating own site must stay enabled');

    await ownerSelect.selectOption('new_admin');
    const newWebsiteNotice = page.locator('[data-premium-notice="new-website-owner"]');
    await newWebsiteNotice.waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('input[type="password"]').count(), 0, 'Must not show password form before Premium');
    assert.equal(await continueButton.isDisabled(), true);
    await newWebsiteNotice.getByRole('button', { name: 'Yönetim hesabımla devam et' }).click();
    assert.equal(await ownerSelect.inputValue(), 'owner');
    assert.equal(await continueButton.isDisabled(), false);

    // /users: existing Owner account remains visible; Premium notice appears before any create password form
    await page.goto(`${publicOrigin}/users`, { waitUntil: 'networkidle' });
    await page.getByRole('cell', { name: 'Sunucu Yöneticisi' }).first().waitFor({ timeout: 10_000 });
    await page.locator('[data-premium-notice="users"]').waitFor({ timeout: 5_000 });
    await page.getByRole('button', { name: /Kullanıcı ekle/ }).click();
    await page.locator('[data-premium-gate-dialog="users"]').waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('dialog input[type="password"]').count(), 0);
    await page.getByRole('button', { name: 'Vazgeç' }).click();

    // /customers: early notice + Premium gate before any password form
    await page.goto(`${publicOrigin}/customers`, { waitUntil: 'networkidle' });
    await page.locator('[data-premium-notice="customer"]').waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: /Müşteri ekle/ }).click();
    await page.locator('[data-premium-gate-dialog="customer"]').waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('dialog input[type="password"]').count(), 0);
    await page.getByRole('button', { name: 'Vazgeç' }).click();

    // /resellers: early notice + Premium gate before any password form
    await page.goto(`${publicOrigin}/resellers`, { waitUntil: 'networkidle' });
    const resellerNotice = page.locator('[data-premium-notice="reseller"]');
    await resellerNotice.waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: /Bayi ekle/ }).click();
    await page.locator('[data-premium-gate-dialog="reseller"]').waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('dialog input[type="password"]').count(), 0);

    // Direct backend enforcement MUST still reject Free Owner create-login with 403 premium_license_required
    const directFreeCheck = await page.evaluate(async (pw) => {
      const sessionResp = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const sessionJson = await sessionResp.json();
      const csrf = sessionJson?.data?.csrfToken ?? sessionJson?.csrfToken ?? '';
      const createResp = await fetch('/api/panel/users/hosting/accounts/create-login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({
          kind: 'reseller',
          username: 'blockedreseller',
          password: pw,
          limits: { maxCustomers: 5, maxWebsites: 10 },
        }),
      });
      return { status: createResp.status, body: await createResp.json() };
    }, resellerPassword);
    assert.equal(directFreeCheck.status, 403);
    assert.equal(directFreeCheck.body?.error?.code ?? directFreeCheck.body?.code, 'premium_license_required');

    // Click "Lisans yönetimine git" from the Premium gate modal -> safe returnTo flow
    await page.locator('[data-premium-gate-dialog="reseller"]').getByRole('link', { name: 'Lisans yönetimine git' }).click();
    await page.waitForURL((url) => url.pathname === '/settings' && url.searchParams.get('section') === 'license');
    const licenseUrl = new URL(page.url());
    assert.equal(licenseUrl.searchParams.get('returnTo'), '/resellers?action=create');
    assert.equal(licenseUrl.searchParams.get('feature'), 'reseller');
    await page.locator('[data-license-return-banner="pending"]').waitFor({ timeout: 10_000 });
    await assertNoSecretsLeaked(page, secrets);

    // --- PART B: Real Locally Signed Ed25519 Premium Activation + Return-to-Task ---
    const signedToken = signRealEntitlementToken(keys.privateKey, keys.kid, {
      licenseId: 'lic_wave1_browser_01',
      entitlementVersion: 1,
      periodMonths: 12,
      domain: 'panel.example.test',
      instanceId: localServerId,
    });

    await page.getByRole('button', { name: 'İmzalı jeton' }).click();
    await page.getByLabel('İmzalı lisans jetonu').fill(signedToken);
    const [activateResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panel/license/activate') && r.request().method() === 'POST', { timeout: 10_000 }),
      page.getByRole('button', { name: 'Lisansı etkinleştir' }).click(),
    ]);
    assert.equal(activateResp.status(), 200);
    await page.getByText('YunPanel Premium lisansı doğrulandı ve etkinleştirildi.').waitFor({ timeout: 10_000 });

    // Return banner switches to ready and sidebar Premium badges clear immediately
    const readyBanner = page.locator('[data-license-return-banner="ready"]');
    await readyBanner.waitFor({ timeout: 10_000 });
    assert.equal(await resellersNav.locator('[data-premium-badge="true"]').count(), 0);
    assert.equal(await customersNav.locator('[data-premium-badge="true"]').count(), 0);

    // Click return link -> returns directly to /resellers?action=create and auto-opens Bayi ekle dialog!
    await readyBanner.getByRole('link', { name: 'Bayi eklemeye dön' }).click();
    await page.waitForURL((url) => url.pathname === '/resellers');
    const resellerDialog = page.getByRole('dialog');
    await resellerDialog.waitFor({ timeout: 10_000 });
    await resellerDialog.getByLabel('Kullanıcı adı').fill('pilotbayi');
    await resellerDialog.getByLabel('İlk parola').fill(resellerPassword);
    const [resellerResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panel/users/hosting/accounts/create-login') && r.request().method() === 'POST', { timeout: 10_000 }),
      resellerDialog.getByRole('button', { name: 'Hesabı oluştur' }).click(),
    ]);
    assert.equal(resellerResp.status(), 201);
    await page.getByRole('rowheader', { name: 'pilotbayi' }).waitFor({ timeout: 10_000 });

    // Visit /customers -> create a real Customer linked to pilotbayi (201)
    await customersNav.click();
    await page.waitForURL((url) => url.pathname === '/customers');
    assert.equal(await page.locator('[data-premium-notice="customer"]').count(), 0);
    await page.getByRole('button', { name: 'Müşteri ekle' }).click();
    const customerDialog = page.getByRole('dialog');
    await customerDialog.waitFor({ timeout: 10_000 });
    await customerDialog.getByLabel('Kullanıcı adı').fill('pilotmusteri');
    await customerDialog.getByLabel('İlk parola').fill(customerPassword);
    await customerDialog.getByLabel('Bağlı bayi').selectOption({ label: 'pilotbayi' });
    const [customerResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panel/users/hosting/accounts/create-login') && r.request().method() === 'POST', { timeout: 10_000 }),
      customerDialog.getByRole('button', { name: 'Hesabı oluştur' }).click(),
    ]);
    assert.equal(customerResp.status(), 201);
    await page.getByRole('rowheader', { name: 'pilotmusteri' }).waitFor({ timeout: 10_000 });

    await assertNoSecretsLeaked(page, [...secrets, 'pilotbayi', 'pilotmusteri']);
    assert.deepEqual(pageErrors, [], `Unexpected pageerror events: ${pageErrors.join('; ')}`);
  } finally {
    if (previousEnvKeyFile === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = previousEnvKeyFile;
    if (previousEnvKeyPem === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM = previousEnvKeyPem;
    if (browser) await browser.close();
    if (webServer) await webServer.close();
    if (apiServer) await apiServer.close();
    if (authStore) authStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Real Playwright Chromium E2E: Slow or failed GET /api/panel/license fails closed on Bayi/Müşteri/Kullanıcı creation & profile linking while keeping existing data and Owner /websites usable, then recovers on retry', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-license-failclosed-e2e-'));
  let apiServer = null;
  let webServer = null;
  let browser = null;
  let authStore = null;
  const previousEnvKeyFile = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
  const previousEnvKeyPem = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

  const ownerPassword = 'StrongFailClosedOwner!2026';
  const siteMgrPassword = 'StrongFailClosedSiteMgr!2026';

  let licenseMode = 'hold';
  let releaseLicenseHold = null;
  let licenseHoldPromise = new Promise((resolve) => { releaseLicenseHold = resolve; });
  let licenseRequestCount = 0;

  try {
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

    const keys = generateEd25519KeyPair();
    const publicKeyPath = path.join(tmpDir, 'entitlement-public.pem');
    writeFileSync(publicKeyPath, keys.publicKeyPem, { mode: 0o600 });
    process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = publicKeyPath;

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
    const ownerLogin = await authStore.login({ username: 'owneradmin', password: ownerPassword });
    await authStore.users.create(ownerLogin.token, (session) => session, {
      username: 'existingmgr',
      password: siteMgrPassword,
      role: 'site_manager',
      active: true,
      websiteIds: [],
    });

    const serverRegistry = createServerRegistry({
      filePath: path.join(tmpDir, 'servers.json'),
    });
    const localServer = await serverRegistry.createLocalServer({
      hostname: 'panel.example.test',
      displayName: 'Local FailClosed Host',
    });
    const localServerId = localServer.id;

    const licenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicKeyFile: publicKeyPath,
      publicOrigin,
      instanceId: localServerId,
      masterKey,
      development: true,
    });

    const realApiListener = createAuthenticatedApi({
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
        userAdminStore: authStore.users,
        authStore,
        licenseEntitlementService: licenseService,
      }),
    });

    // Real backend HTTP server wrapper that controls ONLY timing/availability of GET /api/license
    // before forwarding directly to realApiListener + real createLicenseEntitlementService.
    apiServer = await listenServer(http.createServer(async (req, res) => {
      const reqPath = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && reqPath === '/api/license') {
        licenseRequestCount += 1;
        if (licenseMode === 'hold') {
          await licenseHoldPromise;
          if (req.destroyed || res.writableEnded) return;
        }
        if (licenseMode === 'error') {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            error: { code: 'license_service_unavailable', message: 'License status temporarily unavailable.' },
          }));
          return;
        }
      }
      return realApiListener(req, res);
    }));

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

    // --- CASE A: Slow GET /api/panel/license held on real backend ---
    const slowCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const slowPage = await slowCtx.newPage();
    const slowErrors = [];
    slowPage.on('pageerror', (err) => slowErrors.push(err.message));

    await slowPage.goto(`${publicOrigin}/websites`, { waitUntil: 'domcontentloaded' });
    await slowPage.locator('input[name="username"]').fill('owneradmin');
    await slowPage.locator('input[name="password"]').fill(ownerPassword);
    await slowPage.getByRole('button', { name: 'Giriş yap' }).click();

    const slowSidebar = slowPage.getByRole('navigation', { name: 'Panel bölümleri' });
    await slowSidebar.waitFor({ timeout: 15_000 });

    // Owner normal /websites screen and /websites/new (ownerMode="owner") remain usable while license check is in flight,
    // whereas Premium-gated new_admin / customer site-owner modes stay fail-closed!
    await slowPage.getByRole('heading', { name: 'Web Siteleri' }).waitFor({ timeout: 10_000 });
    const addSiteLink = slowPage.locator('main .ws-page-heading').getByRole('link', { name: 'Web sitesi ekle' });
    assert.ok(await addSiteLink.isVisible());
    await addSiteLink.click();
    await slowPage.getByLabel('Site sahibi').waitFor({ timeout: 10_000 });
    assert.equal(await slowPage.getByRole('button', { name: 'Devam et', exact: true }).isDisabled(), false, 'Owner normal site creation must remain enabled while license loads');
    await slowPage.getByLabel('Site sahibi').selectOption('new_admin');
    await slowPage.locator('[data-license-gate-state="new-website-owner-loading"]').waitFor({ timeout: 5_000 });
    assert.equal(await slowPage.locator('input[type="password"]').count(), 0);
    assert.equal(await slowPage.getByRole('button', { name: 'Devam et', exact: true }).isDisabled(), true);
    await slowPage.getByLabel('Site sahibi').selectOption('customer');
    await slowPage.locator('[data-license-gate-state="new-website-owner-loading"]').waitFor({ timeout: 5_000 });
    assert.equal(await slowPage.getByRole('button', { name: 'Devam et', exact: true }).isDisabled(), true);
    await slowPage.getByRole('button', { name: 'Yönetim hesabımla devam et' }).click();
    assert.equal(await slowPage.getByRole('button', { name: 'Devam et', exact: true }).isDisabled(), false);

    // /resellers finishes loading its real list while /api/panel/license is still held -> Bayi ekle stays disabled
    await slowSidebar.locator('a[href="/resellers"]').click();
    await slowPage.getByRole('button', { name: 'Değişiklikleri bırak' }).click();
    await slowPage.getByText('Henüz bayi yok').waitFor({ timeout: 10_000 });
    const resellerLoadingNotice = slowPage.locator('[data-license-gate-state="loading"]');
    await resellerLoadingNotice.waitFor({ timeout: 5_000 });
    assert.match(await resellerLoadingNotice.textContent(), /Lisans durumu doğrulanıyor/);
    assert.equal(await slowPage.getByRole('button', { name: /Bayi ekle/ }).isDisabled(), true);

    // /customers finishes loading while license is still held -> Müşteri ekle stays disabled
    await slowSidebar.locator('a[href="/customers"]').click();
    await slowPage.getByText('Henüz müşteri yok').waitFor({ timeout: 10_000 });
    await slowPage.locator('[data-license-gate-state="loading"]').waitFor({ timeout: 5_000 });
    assert.equal(await slowPage.getByRole('button', { name: /Müşteri ekle/ }).isDisabled(), true);

    // /users finishes loading real SQLite users while license is still held -> existing users visible, Kullanıcı ekle disabled
    await slowSidebar.locator('a[href="/tools-settings"]').click();
    await slowPage.locator('a[href="/settings/users"]').first().click();
    await slowPage.getByRole('rowheader', { name: 'owneradmin' }).waitFor({ timeout: 10_000 });
    await slowPage.getByRole('rowheader', { name: 'existingmgr' }).waitFor({ timeout: 10_000 });
    await slowPage.locator('[data-license-gate-state="loading"]').waitFor({ timeout: 5_000 });
    assert.equal(await slowPage.getByRole('button', { name: /Kullanıcı ekle/ }).isDisabled(), true);

    // Release real backend license fetch (Free tier) -> transitions cleanly to Premium notice without password forms
    licenseMode = 'normal';
    releaseLicenseHold();
    await slowPage.locator('[data-premium-notice="users"]').waitFor({ timeout: 10_000 });
    assert.equal(await slowPage.locator('[data-license-gate-state="loading"]').count(), 0);
    assert.equal(await slowPage.getByRole('button', { name: /Kullanıcı ekle/ }).isDisabled(), false);
    await slowPage.getByRole('button', { name: /Kullanıcı ekle/ }).click();
    await slowPage.locator('[data-premium-gate-dialog="users"]').waitFor({ timeout: 5_000 });
    assert.equal(await slowPage.locator('dialog input[type="password"]').count(), 0);
    await slowPage.getByRole('button', { name: 'Vazgeç' }).click();
    await slowSidebar.locator('a[href="/resellers"]').click();
    await slowPage.locator('[data-premium-notice="reseller"]').waitFor({ timeout: 10_000 });
    assert.deepEqual(slowErrors, []);
    await slowCtx.close();

    // --- CASE B: Real 503 failure on GET /api/panel/license + retry recovery ---
    licenseMode = 'error';
    const errCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const errPage = await errCtx.newPage();
    const errErrors = [];
    errPage.on('pageerror', (err) => errErrors.push(err.message));

    // Also include ?action=create on /resellers to verify error state NEVER auto-opens create modal!
    await errPage.goto(`${publicOrigin}/resellers?action=create`, { waitUntil: 'networkidle' });
    await errPage.locator('input[name="username"]').fill('owneradmin');
    await errPage.locator('input[name="password"]').fill(ownerPassword);
    await errPage.getByRole('button', { name: 'Giriş yap' }).click();

    const errSidebar = errPage.getByRole('navigation', { name: 'Panel bölümleri' });
    await errSidebar.waitFor({ timeout: 15_000 });
    await errPage.getByText('Henüz bayi yok').waitFor({ timeout: 10_000 });
    const resellerErrNotice = errPage.locator('[data-license-gate-state="error"]');
    await resellerErrNotice.waitFor({ timeout: 10_000 });
    assert.match(await resellerErrNotice.textContent(), /Lisans durumu okunamadı/);
    assert.equal(await errPage.getByRole('button', { name: /Bayi ekle/ }).isDisabled(), true);
    assert.equal(await errPage.getByRole('dialog').count(), 0, 'action=create must not open dialog when license fetch fails');

    // /customers in license error state
    await errSidebar.locator('a[href="/customers"]').click();
    await errPage.getByText('Henüz müşteri yok').waitFor({ timeout: 10_000 });
    await errPage.locator('[data-license-gate-state="error"]').waitFor({ timeout: 5_000 });
    assert.equal(await errPage.getByRole('button', { name: /Müşteri ekle/ }).isDisabled(), true);

    // /websites/new in license error state: Owner normal mode stays enabled, new_admin/customer stay fail-closed with retry button!
    await errSidebar.locator('a[href="/websites"]').click();
    await errPage.locator('main .ws-page-heading').getByRole('link', { name: 'Web sitesi ekle' }).click();
    await errPage.getByLabel('Site sahibi').waitFor({ timeout: 10_000 });
    assert.equal(await errPage.getByRole('button', { name: 'Devam et', exact: true }).isDisabled(), false);
    await errPage.getByLabel('Site sahibi').selectOption('new_admin');
    await errPage.locator('[data-license-gate-state="new-website-owner-error"]').waitFor({ timeout: 5_000 });
    assert.equal(await errPage.locator('input[type="password"]').count(), 0);
    assert.equal(await errPage.getByRole('button', { name: 'Devam et', exact: true }).isDisabled(), true);

    // /users in license error state: existing users remain visible, Kullanıcı ekle disabled,
    // and HostingProfileDialog keeps Premium-gated Profili bağla disabled with retry notice!
    await errSidebar.locator('a[href="/tools-settings"]').click();
    await errPage.getByRole('button', { name: 'Değişiklikleri bırak' }).click();
    await errPage.locator('a[href="/settings/users"]').first().click();
    await errPage.getByRole('rowheader', { name: 'owneradmin' }).waitFor({ timeout: 10_000 });
    await errPage.getByRole('rowheader', { name: 'existingmgr' }).waitFor({ timeout: 10_000 });
    const usersErrNotice = errPage.locator('[data-license-gate-state="error"]');
    await usersErrNotice.waitFor({ timeout: 10_000 });
    assert.equal(await errPage.getByRole('button', { name: /Kullanıcı ekle/ }).isDisabled(), true);

    await errPage.getByRole('button', { name: 'existingmgr bayi veya müşteri profilini yönet' }).click();
    const profileDialog = errPage.getByRole('dialog');
    await profileDialog.waitFor({ timeout: 10_000 });
    await profileDialog.locator('[data-license-gate-state="hosting-profile-error"]').waitFor({ timeout: 10_000 });
    assert.equal(await profileDialog.getByRole('button', { name: 'Profili bağla' }).isDisabled(), true);
    await profileDialog.getByRole('button', { name: 'Kapat', exact: true }).click();

    // Restore real backend GET /api/license and click retry button -> clean recovery!
    licenseMode = 'normal';
    const beforeRetryCount = licenseRequestCount;
    await usersErrNotice.getByRole('button', { name: 'Lisans durumunu yeniden dene' }).click();
    await errPage.locator('[data-premium-notice="users"]').waitFor({ timeout: 10_000 });
    assert.ok(licenseRequestCount > beforeRetryCount, 'Retry button must trigger a real GET /api/license refresh');
    assert.equal(await errPage.locator('[data-license-gate-state="error"]').count(), 0);
    assert.equal(await errPage.getByRole('button', { name: /Kullanıcı ekle/ }).isDisabled(), false);

    assert.deepEqual(errErrors, []);
    await errCtx.close();
  } finally {
    releaseLicenseHold?.();
    if (previousEnvKeyFile === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = previousEnvKeyFile;
    if (previousEnvKeyPem === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM = previousEnvKeyPem;
    if (browser) await browser.close();
    if (webServer) await webServer.close();
    if (apiServer) await apiServer.close();
    if (authStore) authStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
