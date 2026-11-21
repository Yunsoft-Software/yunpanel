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
import { createApp } from '../../api/src/app.js';
import { createApplicationRegistry } from '../../api/src/application-registry.js';
import { createAuthenticatedApi } from '../../api/src/auth-http.js';
import { createAuthStore } from '../../api/src/auth-store.js';
import { createCertificateRegistry } from '../../api/src/certificate-registry.js';
import { createDomainRegistry } from '../../api/src/domain-registry.js';
import { createJobRegistry } from '../../api/src/job-registry.js';
import { createServerRegistry } from '../../api/src/server-registry.js';
import { createWebsiteRegistry } from '../../api/src/website-registry.js';
import {
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  PREMIUM_CAPABILITIES,
} from '../../api/src/license-entitlement-verifier.js';
import { createLicenseEntitlementService } from '../../api/src/license-entitlement-service.js';

function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const kid = computePublicKeyId(spkiDer);
  return { privateKey, publicKeyPem, kid };
}

function signRealEntitlementToken(privateKey, kid, {
  licenseId = 'lic_wave2a_slice2_01',
  entitlementVersion = 1,
  periodMonths = 12,
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

async function signIn(page, publicOrigin, targetPath, username, password) {
  await page.goto(`${publicOrigin}${targetPath}`, { waitUntil: 'networkidle' });
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.getByRole('navigation', { name: 'Panel bölümleri' }).waitFor({ timeout: 15_000 });
}

test('Real Playwright Chromium E2E: Owner, Reseller and Customer first-screen guidance, honest quotas, real maxWebsites enforcement, accurate Reseller copy, and foreign site isolation', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-wave2a-slice2-'));
  let apiServer = null;
  let webServer = null;
  let browser = null;
  let authStore = null;
  const previousEnvKeyFile = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
  const previousEnvKeyPem = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

  const ownerPass = 'StrongOwnerWave2A!2026';
  const resellerPass = 'StrongResellerWave2A!2026';
  const custOnePass = 'StrongCustOneWave2A!2026';
  const custTwoPass = 'StrongCustTwoWave2A!2026';

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
      password: ownerPass,
    });

    const serverRegistry = createServerRegistry({ filePath: path.join(tmpDir, 'servers.json') });
    const localServer = await serverRegistry.createLocalServer({
      hostname: 'panel.example.test',
      displayName: 'Local Wave2A Host',
    });
    const localServerId = localServer.id;

    const applicationRegistry = createApplicationRegistry({
      filePath: path.join(tmpDir, 'applications.json'),
      serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
    });
    const websiteRegistry = createWebsiteRegistry({
      filePath: path.join(tmpDir, 'websites.json'),
      serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
      getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
    });
    const domainRegistry = createDomainRegistry({
      filePath: path.join(tmpDir, 'domains.json'),
      serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
      getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
    });
    const certificateRegistry = createCertificateRegistry({ filePath: path.join(tmpDir, 'certs.json') });
    const jobRegistry = createJobRegistry({ filePath: path.join(tmpDir, 'jobs.json') });

    const licenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicKeyFile: publicKeyPath,
      publicOrigin,
      instanceId: localServerId,
      masterKey,
      development: true,
    });

    // Activate real Ed25519 signed Premium token via real service
    const signedToken = signRealEntitlementToken(keys.privateKey, keys.kid, {
      instanceId: localServerId,
    });
    const activated = await licenseService.activate({ token: signedToken });
    assert.equal(activated.valid, true);
    assert.equal(activated.tier, 'premium');

    // Create real reseller + 2 customers using real AuthStore login/token
    const requireManagement = (session) => session;
    const ownerLogin = await authStore.login({ username: 'owneradmin', password: ownerPass });
    const ownerToken = ownerLogin.token;
    const resellerAcc = await authStore.users.hostingAccounts.createOwnerLogin(ownerToken, requireManagement, {
      kind: 'reseller',
      username: 'ajansbayi',
      password: resellerPass,
      limits: { maxCustomers: 10, maxWebsites: 10 },
    });
    const custOne = await authStore.users.hostingAccounts.createOwnerLogin(ownerToken, requireManagement, {
      kind: 'customer',
      username: 'musteribir',
      password: custOnePass,
      resellerId: resellerAcc.id,
    });
    const custTwo = await authStore.users.hostingAccounts.createOwnerLogin(ownerToken, requireManagement, {
      kind: 'customer',
      username: 'musteriiki',
      password: custTwoPass,
      resellerId: resellerAcc.id,
      quotas: { maxWebsites: 2, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null },
    });

    // Create real Applications, Websites & Domains (draft + SSL off) and bind them to custOne and custTwo in real SQLite!
    const appOne = await applicationRegistry.createApplication({
      serverId: localServerId,
      name: 'cust-one.buyer.example.test',
      repositoryUrl: null,
      branch: null,
      build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
    });
    const siteOne = await websiteRegistry.createWebsite({
      serverId: localServerId,
      name: 'cust-one.buyer.example.test',
      applicationId: appOne.id,
    });
    const domainOne = await domainRegistry.createDomain({
      serverId: localServerId,
      websiteId: siteOne.id,
      primaryDomain: 'cust-one.buyer.example.test',
      targetType: 'static',
      target: { root: siteOne.documentRoot },
      httpsMode: 'off',
    });
    const appTwo = await applicationRegistry.createApplication({
      serverId: localServerId,
      name: 'foreign.buyer.example.test',
      repositoryUrl: null,
      branch: null,
      build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
    });
    const siteTwo = await websiteRegistry.createWebsite({
      serverId: localServerId,
      name: 'foreign.buyer.example.test',
      applicationId: appTwo.id,
    });
    const domainTwo = await domainRegistry.createDomain({
      serverId: localServerId,
      websiteId: siteTwo.id,
      primaryDomain: 'foreign.buyer.example.test',
      targetType: 'static',
      target: { root: siteTwo.documentRoot },
      httpsMode: 'off',
    });

    // Attach siteOne to custOne and siteTwo to custTwo using real SQLite hosting site allocation store!
    authStore.users.hostingAccounts.allocateCustomerSite(ownerToken, requireManagement, {
      customerId: custOne.id,
      site: siteOne,
    });
    authStore.users.hostingAccounts.allocateCustomerSite(ownerToken, requireManagement, {
      customerId: custTwo.id,
      site: siteTwo,
    });
    // Also reserve 1 pending site allocation on custTwo in real SQLite so custTwo has
    // 1 visible site (`siteTwo`) + 1 reserved allocation = authoritative usage.websites 2 / 2!
    authStore.users.hostingAccounts.siteAllocations.reserve(ownerToken, requireManagement, {
      operationId: crypto.randomUUID(),
      websiteId: crypto.randomUUID(),
      customerId: custTwo.id,
      serverId: localServerId,
      intentDigest: 'a'.repeat(64),
      websiteDigest: 'b'.repeat(64),
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
        applicationRegistry,
        websiteRegistry,
        domainRegistry,
        certificateRegistry,
        jobRegistry,
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

    // --- 1. OWNER FIRST SCREEN (/websites + /dashboard) ---
    const ownerCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const ownerPage = await ownerCtx.newPage();
    const ownerErrors = [];
    ownerPage.on('pageerror', (err) => ownerErrors.push(err.message));

    await signIn(ownerPage, publicOrigin, '/websites', 'owneradmin', ownerPass);
    const ownerStrip = ownerPage.locator('[data-next-actions="owner"]');
    await ownerStrip.waitFor({ timeout: 10_000 });
    // Item 10: PageHeading on /websites no longer duplicates Uygulama Marketi (single entry lives in left sidebar)
    assert.equal(await ownerPage.locator('main .ws-page-heading').getByRole('link', { name: 'Uygulama Marketi' }).count(), 0);
    assert.ok(await ownerPage.locator('main .ws-page-heading').getByRole('link', { name: 'Web sitesi ekle' }).isVisible());
    assert.ok(await ownerPage.getByRole('link', { name: 'Sunucu sağlığı ve genel bakış' }).isVisible());
    assert.ok(await ownerPage.getByRole('link', { name: 'Güvenlik duvarı' }).isVisible());
    assert.match(await ownerStrip.textContent(), /henüz yayında değil|DNS veya SSL bekleyen/);

    await ownerPage.goto(`${publicOrigin}/dashboard`, { waitUntil: 'networkidle' });
    await ownerPage.locator('[data-next-actions="dashboard"]').waitFor({ timeout: 10_000 });

    // Owner /customers: shared CustomerQuotaDialog opt-in disk/traffic enforcement + immediate rollback (real SQLite + real API)
    await ownerPage.goto(`${publicOrigin}/customers`, { waitUntil: 'networkidle' });
    const ownerCustTwoRow = ownerPage.locator('tr', { has: ownerPage.getByRole('rowheader', { name: 'musteriiki' }) });
    await ownerCustTwoRow.waitFor({ timeout: 10_000 });
    await ownerCustTwoRow.getByRole('button', { name: 'Kota tahsis et' }).click();
    const ownerQuotaDialog = ownerPage.getByRole('dialog');
    await ownerQuotaDialog.waitFor({ timeout: 5_000 });
    const diskToggle = ownerQuotaDialog.getByRole('checkbox', { name: /Disk yazma kotasını uygula/ });
    const trafficToggle = ownerQuotaDialog.getByRole('checkbox', { name: /Aylık trafik sınırını uygula/ });
    assert.equal(await diskToggle.isDisabled(), true, 'Disk enforcement toggle must be disabled when maxDiskMb is empty');
    assert.equal(await diskToggle.isChecked(), false);
    assert.equal(await trafficToggle.isDisabled(), true, 'Traffic enforcement toggle must be disabled when maxTrafficMb is empty');
    assert.equal(await trafficToggle.isChecked(), false);

    await ownerQuotaDialog.getByLabel(/Disk Kotası/).fill('500');
    await ownerQuotaDialog.getByLabel(/Aylık Trafik Kotası/).fill('2048');
    assert.equal(await diskToggle.isDisabled(), false);
    assert.equal(await trafficToggle.isDisabled(), false);
    await diskToggle.check();
    await trafficToggle.check();
    const [enableResp] = await Promise.all([
      ownerPage.waitForResponse((r) => r.url().includes('/quotas') && r.request().method() === 'PATCH', { timeout: 10_000 }),
      ownerQuotaDialog.getByRole('button', { name: 'Kotaları Kaydet' }).click(),
    ]);
    assert.equal(enableResp.status(), 200);
    const enableJson = await enableResp.json();
    assert.deepEqual(enableJson?.data?.account?.quotaEnforcement, {
      websites: true,
      databases: true,
      disk: true,
      traffic: true,
    });
    await ownerPage.getByText('musteriiki müşterisinin kaynak kotaları güncellendi.').waitFor({ timeout: 10_000 });
    const enabledRowText = await ownerCustTwoRow.textContent();
    assert.match(enabledRowText, /Panel yazma kotası etkin/);
    assert.match(enabledRowText, /HTTP trafik sınırı etkin/);

    // Reopen dialog and toggle BOTH checkboxes OFF without touching numbers -> dirty enables save -> immediate rollback!
    await ownerCustTwoRow.getByRole('button', { name: 'Kota tahsis et' }).click();
    await ownerQuotaDialog.waitFor({ timeout: 5_000 });
    assert.equal(await diskToggle.isChecked(), true);
    assert.equal(await trafficToggle.isChecked(), true);
    const saveBtn = ownerQuotaDialog.getByRole('button', { name: 'Kotaları Kaydet' });
    assert.equal(await saveBtn.isDisabled(), true, 'Save must be disabled when nothing changed');
    await diskToggle.uncheck();
    await trafficToggle.uncheck();
    assert.equal(await saveBtn.isDisabled(), false, 'Unchecking enforcement toggles must mark dialog dirty');
    const [rollbackResp] = await Promise.all([
      ownerPage.waitForResponse((r) => r.url().includes('/quotas') && r.request().method() === 'PATCH', { timeout: 10_000 }),
      saveBtn.click(),
    ]);
    assert.equal(rollbackResp.status(), 200);
    const rollbackJson = await rollbackResp.json();
    assert.deepEqual(rollbackJson?.data?.account?.quotaEnforcement, {
      websites: true,
      databases: true,
      disk: false,
      traffic: false,
    });
    await ownerPage.locator('tr', { has: ownerPage.getByRole('rowheader', { name: 'musteriiki' }) }).waitFor({ timeout: 10_000 });
    await ownerPage.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('tr'));
      const row = rows.find((r) => r.textContent?.includes('musteriiki'));
      return row && !row.textContent.includes('Panel yazma kotası etkin') && !row.textContent.includes('HTTP trafik sınırı etkin');
    }, { timeout: 10_000 });

    assert.deepEqual(ownerErrors, []);
    await ownerCtx.close();

    // --- 2. RESELLER FIRST SCREEN (/customers): Accurate copy, honest quotas, REAL maxWebsites enforcement ---
    const resellerCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const resellerPage = await resellerCtx.newPage();
    const resellerErrors = [];
    resellerPage.on('pageerror', (err) => resellerErrors.push(err.message));

    await signIn(resellerPage, publicOrigin, '/customers', 'ajansbayi', resellerPass);
    await resellerPage.getByRole('rowheader', { name: 'musteribir' }).waitFor({ timeout: 10_000 });
    const resellerText = await resellerPage.locator('main').textContent();

    // Item 9: NO contradictory header text or developer jargon
    assert.doesNotMatch(resellerText, /Site yetkileri ve sunucu kaynakları bu ekrandan verilmez/);
    assert.doesNotMatch(resellerText, /site grant'i/);
    assert.match(resellerText, /Size bağlı müşteri hesaplarını oluşturun, web sitesi ve kaynak kotalarını tahsis edin ve giriş durumlarını yönetin/);
    assert.match(resellerText, /mevcut web sitelerinin yayını durmaz/);

    // Item 6: Set real customer quotas on musteribir via UI (maxWebsites: 1, maxDiskMb: 500, maxDatabases: 2)
    const custOneRow = resellerPage.locator('tr', { has: resellerPage.getByRole('rowheader', { name: 'musteribir' }) });
    await custOneRow.getByRole('button', { name: 'Kota tahsis et' }).click();
    const quotaDialog = resellerPage.getByRole('dialog');
    await quotaDialog.waitFor({ timeout: 5_000 });
    const quotaDialogText = await quotaDialog.textContent();
    assert.match(quotaDialogText, /Web sitesi ve veritabanı kotaları yeni işlemlerde otomatik uygulanır/);
    assert.match(quotaDialogText, /Disk ve aylık trafik sınırlarını aşağıdan açıp kapatabilirsiniz/);
    const resellerDiskToggle = quotaDialog.getByRole('checkbox', { name: /Disk yazma kotasını uygula/ });
    assert.equal(await resellerDiskToggle.isDisabled(), true);
    await quotaDialog.getByLabel(/Web Sitesi Kotası/).fill('1');
    await quotaDialog.getByLabel(/Disk Kotası/).fill('500');
    assert.equal(await resellerDiskToggle.isDisabled(), false);
    assert.equal(await resellerDiskToggle.isChecked(), false);
    await quotaDialog.getByLabel(/Veritabanı Kotası/).fill('2');
    const [quotaResp] = await Promise.all([
      resellerPage.waitForResponse((r) => r.url().includes('/quotas') && r.request().method() === 'PATCH', { timeout: 10_000 }),
      quotaDialog.getByRole('button', { name: 'Kotaları Kaydet' }).click(),
    ]);
    assert.equal(quotaResp.status(), 200);
    await resellerPage.getByText('musteribir müşterisinin kaynak kotaları güncellendi.').waitFor({ timeout: 10_000 });

    // Table shows enforced 1 / 1 (Kota doldu) + honest Ölçülmüyor + Kayıtlı sınır for unenforced disk + Uygulanan sınır for databases
    const updatedRowText = await custOneRow.textContent();
    assert.match(updatedRowText, /1 \/ 1/);
    assert.match(updatedRowText, /Kota Doldu/i);
    assert.match(updatedRowText, /Ölçülmüyor/);
    assert.match(updatedRowText, /Kayıtlı sınır: 500 MB/);
    assert.match(updatedRowText, /Uygulanan sınır: 2/);
    assert.equal(await custOneRow.getByRole('button', { name: 'Site tahsis et' }).isDisabled(), true);

    // Next-actions strip surfaces quota-full customer callout
    const resellerNext = resellerPage.locator('[data-next-actions="reseller-customers"]');
    await resellerNext.waitFor({ timeout: 5_000 });
    assert.match(await resellerNext.textContent(), /web sitesi kotası doldu/);

    // Verify REAL backend enforcement of customer maxWebsites quota when full!
    const quotaEnforcementResult = await resellerPage.evaluate(async ({ customerId, serverId }) => {
      const sessionResp = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const sessionJson = await sessionResp.json();
      const csrf = sessionJson?.data?.csrfToken ?? sessionJson?.csrfToken ?? '';
      const resp = await fetch('/api/panel/sites/hosted/create-preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          customerId,
          input: {
            operationId: crypto.randomUUID(),
            serverId,
            name: 'second-blocked.buyer.example.test',
            primaryDomain: 'second-blocked.buyer.example.test',
            parentDomainId: null,
            wwwMode: 'alias',
            httpsMode: 'managed',
            source: { kind: 'new_static' },
            database: { mode: 'none' },
            mail: { mode: 'local' },
            dns: { mode: 'local' },
          },
        }),
      });
      return { status: resp.status, body: await resp.json() };
    }, { customerId: custOne.id, serverId: localServerId });
    assert.ok([403, 409].includes(quotaEnforcementResult.status), `Expected 403/409 quota block, got ${quotaEnforcementResult.status}: ${JSON.stringify(quotaEnforcementResult.body)}`);
    assert.equal(quotaEnforcementResult.body?.error?.code ?? quotaEnforcementResult.body?.code, 'customer_quota_exceeded');

    // Item 12: Mobile responsive customer actions at 390x844 and 320x700 — zero horizontal page overflow,
    // primary action immediately visible and secondary actions cleanly reachable via Diğer işlemler disclosure.
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 700 }]) {
      await resellerPage.setViewportSize(viewport);
      const mobileOverflow = await resellerPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      assert.ok(
        mobileOverflow.scrollWidth <= mobileOverflow.innerWidth,
        `Unexpected horizontal overflow at ${viewport.width}px: scrollWidth=${mobileOverflow.scrollWidth} > innerWidth=${mobileOverflow.innerWidth}`,
      );
      const mobileRow = resellerPage.locator('tr', { has: resellerPage.getByRole('rowheader', { name: 'musteribir' }) });
      const primaryBtn = mobileRow.getByRole('button', { name: 'Site tahsis et' });
      assert.ok(await primaryBtn.isVisible(), `Primary Site tahsis et button must be visible at ${viewport.width}px`);
      const primaryBox = await primaryBtn.boundingBox();
      assert.ok(primaryBox && primaryBox.x >= 0 && primaryBox.x + primaryBox.width <= viewport.width + 1, `Primary button clipped at ${viewport.width}px: ${JSON.stringify(primaryBox)}`);

      const detailsMenu = mobileRow.locator('details.ws-row-actions-menu');
      const summary = detailsMenu.locator('summary');
      assert.ok(await summary.isVisible(), `Diğer işlemler summary must be visible at ${viewport.width}px`);
      if (!(await detailsMenu.evaluate((el) => el.open))) {
        await summary.click();
      }
      for (const actionLabel of ['Kota tahsis et', 'Girişi düzenle', 'Askıya al']) {
        const actionBtn = detailsMenu.getByRole('button', { name: actionLabel });
        assert.ok(await actionBtn.isVisible(), `${actionLabel} must be visible inside Diğer işlemler at ${viewport.width}px`);
        const box = await actionBtn.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1, `${actionLabel} clipped at ${viewport.width}px: ${JSON.stringify(box)}`);
      }
      const openOverflow = await resellerPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      assert.ok(
        openOverflow.scrollWidth <= openOverflow.innerWidth,
        `Unexpected horizontal overflow when menu open at ${viewport.width}px: scrollWidth=${openOverflow.scrollWidth} > innerWidth=${openOverflow.innerWidth}`,
      );
      await summary.click();
    }

    assert.deepEqual(resellerErrors, []);
    await resellerCtx.close();

    // --- 3. CUSTOMER FIRST SCREEN (/websites): Honest quotas (NO `— /`), site breakdown, management context, next actions, foreign isolation ---
    const custCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const custPage = await custCtx.newPage();
    const custErrors = [];
    custPage.on('pageerror', (err) => custErrors.push(err.message));

    await signIn(custPage, publicOrigin, '/websites', 'musteribir', custOnePass);
    const quotaSection = custPage.locator('[data-customer-quotas="true"]');
    await quotaSection.waitFor({ timeout: 10_000 });
    // Authoritative backend /users/hosting/accounts/:selfId resolves 1 / 1 (including reservations)
    await custPage.locator('[data-quota-metric="websites"]').filter({ hasText: '1 / 1' }).waitFor({ timeout: 10_000 });
    const quotaSectionContainer = quotaSection.locator('..');
    const quotaHeaderAndBody = await quotaSectionContainer.textContent();

    // No broken `— /` or `— / Sınırsız`, and NEVER displays account.updatedAt as `Son ölçüm:`!
    assert.doesNotMatch(quotaHeaderAndBody, /—\s*\//);
    assert.match(quotaHeaderAndBody, /Henüz ölçülmedi/);
    assert.doesNotMatch(quotaHeaderAndBody, /Son ölçüm:/);
    assert.match(quotaHeaderAndBody, /Bayi yönetimli müşteri/);

    // Enforced vs unmeasured groups are strictly separated; enforced websites+databases vs opt-in-off disk+traffic
    const websitesMetricText = await custPage.locator('[data-quota-group="enforced"] [data-quota-metric="websites"]').textContent();
    assert.match(websitesMetricText, /1 \/ 1/);
    assert.match(websitesMetricText, /Kota doldu/);
    assert.match(websitesMetricText, /Yeni site tahsisinde uygulanır/);
    const databasesMetricText = await custPage.locator('[data-quota-group="enforced"] [data-quota-metric="databases"]').textContent();
    assert.match(databasesMetricText, /Tanımlı sınır: 2/);
    assert.match(databasesMetricText, /Yeni veritabanı oluşturma, bağlama ve WordPress kurulumlarında uygulanır/);

    const unmeasuredGroupText = await custPage.locator('[data-quota-group="unmeasured"]').textContent();
    assert.doesNotMatch(unmeasuredGroupText, /Aktif sınır|uygulanır/);
    assert.match(await custPage.locator('[data-quota-group="unmeasured"] [data-quota-metric="diskMb"]').textContent(), /Ölçülmüyor/);
    assert.match(await custPage.locator('[data-quota-group="unmeasured"] [data-quota-metric="diskMb"]').textContent(), /Tanımlı sınır: 500 MB/);
    assert.match(await custPage.locator('[data-quota-group="unmeasured"] [data-quota-metric="diskMb"]').textContent(), /henüz otomatik ölçülmüyor ve uygulanmıyor/);
    assert.match(await custPage.locator('[data-quota-group="unmeasured"] [data-quota-metric="trafficMb"]').textContent(), /Ölçülmüyor/);
    assert.match(await custPage.locator('[data-quota-group="unmeasured"] [data-quota-metric="trafficMb"]').textContent(), /Sınır: Sınırsız/);

    // Site-level breakdown lists own site and NEVER foreign site
    const breakdown = custPage.locator('[data-customer-site-breakdown="true"]');
    await breakdown.waitFor({ timeout: 5_000 });
    const breakdownText = await breakdown.textContent();
    assert.match(breakdownText, /cust-one\.buyer\.example\.test/);
    assert.doesNotMatch(breakdownText, /foreign\.buyer\.example\.test/);

    // Customer next-actions strip shows unfinished SSL/DNS/draft steps with site-scoped links
    const custNext = custPage.locator('[data-next-actions="customer"]');
    await custNext.waitFor({ timeout: 5_000 });
    assert.ok(await custNext.locator(`a[href="/websites/${domainOne.id}/overview"]`).isVisible());
    assert.ok(await custNext.locator(`a[href="/websites/${domainOne.id}/ssl"]`).isVisible());
    assert.ok(await custNext.locator(`a[href="/websites/${domainOne.id}/dns"]`).isVisible());

    // Foreign site isolation holds on both UI and direct API
    const fullMainText = await custPage.locator('main').textContent();
    assert.doesNotMatch(fullMainText, /foreign\.buyer\.example\.test/);
    const foreignDomainResp = await custPage.evaluate(async (foreignId) => {
      const r = await fetch(`/api/panel/domains/${encodeURIComponent(foreignId)}`, { credentials: 'same-origin' });
      return r.status;
    }, domainTwo.id);
    assert.ok([403, 404].includes(foreignDomainResp), `Expected 403/404 for foreign domain, got ${foreignDomainResp}`);
    assert.deepEqual(custErrors, []);
    await custCtx.close();

    // --- 4. CUSTOMER WITH RESERVED ALLOCATION (custTwo): 1 visible site + 1 reserved -> authoritative 2 / 2 (NEVER fabricated "1 boş") ---
    const custTwoCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const custTwoPage = await custTwoCtx.newPage();
    const custTwoErrors = [];
    custTwoPage.on('pageerror', (err) => custTwoErrors.push(err.message));

    await signIn(custTwoPage, publicOrigin, '/websites', 'musteriiki', custTwoPass);
    await custTwoPage.locator('[data-quota-metric="websites"]').filter({ hasText: '2 / 2' }).waitFor({ timeout: 10_000 });
    const custTwoWebsitesMetric = await custTwoPage.locator('[data-quota-metric="websites"]').textContent();
    assert.match(custTwoWebsitesMetric, /2 \/ 2/);
    assert.match(custTwoWebsitesMetric, /Kota doldu/);
    assert.match(custTwoWebsitesMetric, /1 bekleyen tahsis dahil/);
    assert.doesNotMatch(custTwoWebsitesMetric, /1 boş/);
    assert.deepEqual(custTwoErrors, []);
    await custTwoCtx.close();
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
