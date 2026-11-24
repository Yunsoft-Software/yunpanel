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
import { createAuthenticatedApi } from '../../api/src/auth-http.js';
import { createAuthStore } from '../../api/src/auth-store.js';
import {
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  PREMIUM_CAPABILITIES,
} from '../../api/src/license-entitlement-verifier.js';
import { createLicenseEntitlementService } from '../../api/src/license-entitlement-service.js';
import { createServerRegistry } from '../../api/src/server-registry.js';

function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const kid = computePublicKeyId(spkiDer);
  return { privateKey, publicKeyPem, kid };
}

function signToken(privateKey, kid, {
  licenseId,
  entitlementVersion = 1,
  billingModel = 'monthly_term',
  periodMonths = 3,
  campaignCode = null,
  domain = 'panel.ornek.test',
  instanceId,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const isPermanent = billingModel === 'permanent' || billingModel === 'lifetime';
  const exp = isPermanent ? null : nowSec + (periodMonths * 30 * 86400);
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
    tier: 'premium',
    status: 'active',
    billingModel,
    periodMonths: isPermanent ? null : periodMonths,
    startsAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: exp === null ? null : new Date(exp * 1000).toISOString(),
    domain,
    normalizedDomain: domain,
    allowedHosts: [domain, `www.${domain}`],
    stagingHosts: [`staging.${domain}`, `dev.${domain}`, 'localhost', '127.0.0.1'],
    activatedInstanceId: instanceId,
    capabilities: { ...PREMIUM_CAPABILITIES },
    ...(campaignCode ? { campaignCode } : {}),
  };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(`${h}.${p}`, 'utf8'), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
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

test('Real Playwright Chromium E2E: first-time setup optional 3-month Premium referral, zero PII leakage, campaign -> paid -> permanent protection, and TR/EN browser locales', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-setup-offer-e2e-'));
  let websiteServer = null;
  let apiServer = null;
  let webServer = null;
  let browser = null;
  let authStore = null;
  const previousEnvKeyFile = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
  const previousEnvKeyPem = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

  try {
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

    const keys = generateEd25519KeyPair();
    const publicKeyPath = path.join(tmpDir, 'entitlement-public.pem');
    writeFileSync(publicKeyPath, keys.publicKeyPem, { mode: 0o600 });
    process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = publicKeyPath;

    const websiteRequests = [];
    websiteServer = await listenServer(http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        websiteRequests.push({
          method: req.method,
          url: req.url,
          referer: req.headers.referer ?? null,
        });
        if (req.method === 'GET' && req.url === '/kampanya/premium-3-ay') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><body><h1>Yunsoft 3 Aylik Premium Kampanyasi</h1></body></html>');
          return;
        }
        if (req.method === 'GET' && req.url === '/docs/yunpanel') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><body><h1>YunPanel Dokumantasyonu</h1></body></html>');
          return;
        }
        if (req.method === 'POST' && req.url === '/api/commerce/v1/entitlements/activate') {
          const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          res.setHeader('content-type', 'application/json; charset=utf-8');
          if (body.licenseKey === 'YUN-CAMP-3M-2026') {
            const signed = signToken(keys.privateKey, keys.kid, {
              licenseId: 'camp_web_3m_01',
              billingModel: 'promotional_term',
              periodMonths: 3,
              campaignCode: 'NEWSLETTER-3M-2026',
              domain: body.domain || 'panel.ornek.test',
              instanceId: body.instanceId,
            });
            res.writeHead(200);
            res.end(JSON.stringify({ data: { activated: true, entitlementToken: signed } }));
            return;
          }
          if (body.licenseKey === 'YUN-PAID-12M-2026') {
            const signed = signToken(keys.privateKey, keys.kid, {
              licenseId: 'lic_paid_12m_01',
              billingModel: 'monthly_term',
              periodMonths: 12,
              domain: body.domain || 'panel.ornek.test',
              instanceId: body.instanceId,
            });
            res.writeHead(200);
            res.end(JSON.stringify({ data: { activated: true, entitlementToken: signed } }));
            return;
          }
          res.writeHead(404);
          res.end(JSON.stringify({ error: { code: 'LICENSE_NOT_FOUND', message: 'License key not found.' } }));
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });
    }));

    const webPort = await reserveLoopbackPort();
    const publicOrigin = `http://127.0.0.1:${webPort}`;
    const proxyToken = crypto.randomBytes(32).toString('base64url');
    const masterKey = crypto.randomBytes(32).toString('hex');

    authStore = createAuthStore({
      filePath: path.join(tmpDir, 'auth.sqlite'),
      masterKey,
    });
    const { token: setupToken } = authStore.issueSetupToken();

    const serverRegistry = createServerRegistry({
      filePath: path.join(tmpDir, 'servers.json'),
    });
    const localServer = await serverRegistry.createLocalServer({
      hostname: 'panel.ornek.test',
      displayName: 'Local Setup Host',
    });

    const offerUrl = `${websiteServer.baseUrl}/kampanya/premium-3-ay`;
    const docsUrl = `${websiteServer.baseUrl}/docs/yunpanel`;

    const licenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicKeyFile: publicKeyPath,
      commerceBaseUrl: `${websiteServer.baseUrl}/api/commerce`,
      publicOrigin,
      instanceId: localServer.id,
      masterKey,
      development: true,
      offerUrl,
      docsUrl,
    });

    const apiListener = createAuthenticatedApi({
      store: authStore,
      publicOrigin,
      development: true,
      ownerMfaRequired: false,
      proxyToken,
      trustedProxyIps: '127.0.0.1',
      licenseEntitlementService: licenseService,
      setupOfferUrl: offerUrl,
      docsUrl,
      createHandler: () => createApp({
        registry: serverRegistry,
        localServerId: localServer.id,
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

    // Verify first-time setup renders cleanly under BOTH en-US and tr-TR browser locales & mobile viewport
    const enContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
    const enPage = await enContext.newPage();
    const enErrors = [];
    enPage.on('pageerror', (err) => enErrors.push(err.message));
    await enPage.goto(`${publicOrigin}/`, { waitUntil: 'networkidle' });
    await enPage.getByRole('heading', { name: 'Owner hesabını oluşturun' }).waitFor({ timeout: 10_000 });
    await enPage.locator('[data-setup-premium-offer="true"]').waitFor();
    const mobileOverflow = await enPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(mobileOverflow, false, 'Setup offer card must not cause horizontal overflow on 390px mobile');
    assert.deepEqual(enErrors, []);
    await enContext.close();

    // Main tr-TR desktop verification flow
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'tr-TR' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(`${publicOrigin}/`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Owner hesabını oluşturun' }).waitFor({ timeout: 10_000 });

    // Fill recovery email and verify offer & docs links NEVER leak email, domain, query params, or Referer
    const recoveryEmail = 'kurulum-sahibi@ornek.test';
    await page.getByLabel('Kurulum anahtarı').fill(setupToken);
    await page.locator('input[name="username"]').fill('ownersetup');
    await page.getByLabel('Kurtarma e-postası (isteğe bağlı)').fill(recoveryEmail);
    await page.locator('input[name="password"]').fill('StrongSetupPass!2026');
    await page.getByLabel('Parolayı tekrar girin').fill('StrongSetupPass!2026');

    const setupOfferLink = page.locator('[data-setup-offer-link="true"]');
    const setupDocsLink = page.locator('[data-setup-docs-link="true"]');
    assert.equal(await setupOfferLink.getAttribute('href'), offerUrl);
    assert.equal(await setupDocsLink.getAttribute('href'), docsUrl);
    assert.equal(await setupOfferLink.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal((await setupOfferLink.getAttribute('href')).includes(recoveryEmail), false);
    assert.equal((await setupOfferLink.getAttribute('href')).includes('?'), false);

    // Click offer link -> opens local Website endpoint with 200 and no Referer
    const [offerPopup] = await Promise.all([
      context.waitForEvent('page'),
      setupOfferLink.click(),
    ]);
    await offerPopup.waitForLoadState('domcontentloaded');
    assert.equal(offerPopup.url(), offerUrl);
    assert.match(await offerPopup.textContent('h1'), /Yunsoft 3 Aylik Premium Kampanyasi/);
    await offerPopup.close();

    const [docsPopup] = await Promise.all([
      context.waitForEvent('page'),
      setupDocsLink.click(),
    ]);
    await docsPopup.waitForLoadState('domcontentloaded');
    assert.equal(docsPopup.url(), docsUrl);
    await docsPopup.close();

    const offerHit = websiteRequests.find((r) => r.url === '/kampanya/premium-3-ay');
    assert.ok(offerHit);
    assert.equal(offerHit.referer, null, 'External referral click must not send Referer header');

    // Complete Owner setup without needing any subscription
    await page.getByRole('button', { name: 'Owner hesabını oluştur' }).click();
    await page.getByText('Kurulum tamamlandı. Yeni hesabınızla giriş yapın.').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('[data-setup-premium-offer="true"]').count(), 0);

    // Sign in and navigate to Settings -> Lisans
    await page.locator('input[name="username"]').fill('ownersetup');
    await page.locator('input[name="password"]').fill('StrongSetupPass!2026');
    await page.getByRole('button', { name: 'Giriş yap' }).click();
    await page.getByRole('navigation', { name: 'Panel bölümleri' }).waitFor({ timeout: 15_000 });

    await page.goto(`${publicOrigin}/settings?section=license`, { waitUntil: 'networkidle' });
    await page.locator('[data-license-premium-offer="true"]').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('[data-license-offer-link="true"]').getAttribute('href'), offerUrl);
    assert.equal(await page.locator('[data-license-docs-link="true"]').getAttribute('href'), docsUrl);

    // 1. Activate 3-month promotional campaign key -> Kampanya · 3 ay
    await page.getByLabel('Lisans anahtarı').fill('YUN-CAMP-3M-2026');
    await page.getByLabel('Lisanslı alan adı').fill('panel.ornek.test');
    await page.getByRole('button', { name: 'Lisansı etkinleştir' }).click();
    await page.getByText('Kampanya · 3 ay').waitFor({ timeout: 10_000 });

    // 2. Upgrade to Paid Yearly -> offer section hides automatically!
    await page.getByLabel('Lisans anahtarı').fill('YUN-PAID-12M-2026');
    await page.getByLabel('Lisanslı alan adı').fill('panel.ornek.test');
    await page.getByRole('button', { name: 'Lisansı etkinleştir' }).click();
    await page.getByText('Yıllık · 12 ay').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('[data-license-premium-offer="true"]').count(), 0);

    // 3. Attempting to paste a 3-month promotional token over active Paid Yearly is rejected cleanly!
    const promoToken = signToken(keys.privateKey, keys.kid, {
      licenseId: 'camp_web_3m_02',
      billingModel: 'promotional_term',
      periodMonths: 3,
      campaignCode: 'NEWSLETTER-3M-2026',
      domain: 'panel.ornek.test',
      instanceId: localServer.id,
    });
    await page.getByRole('button', { name: 'İmzalı jeton' }).click();
    await page.getByLabel('İmzalı lisans jetonu').fill(promoToken);
    await page.getByRole('button', { name: 'Lisansı etkinleştir' }).click();
    await page.getByText('Aktif ücretli veya kalıcı lisansınız korunuyor; kampanya hakkı mevcut lisansın üzerine yazılmaz.').waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText('Yıllık · 12 ay').isVisible(), true);

    // 4. Activate Permanent entitlement -> Kalıcı + Süresiz, protected against term/promo overwrite
    const permanentToken = signToken(keys.privateKey, keys.kid, {
      licenseId: 'lic_permanent_web_01',
      billingModel: 'permanent',
      periodMonths: null,
      domain: 'panel.ornek.test',
      instanceId: localServer.id,
    });
    await page.getByLabel('İmzalı lisans jetonu').fill(permanentToken);
    await page.getByRole('button', { name: 'Lisansı etkinleştir' }).click();
    await page.getByText('Kalıcı', { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByText('Süresiz', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-license-premium-offer="true"]').count(), 0);

    await page.getByLabel('İmzalı lisans jetonu').fill(promoToken);
    await page.getByRole('button', { name: 'Lisansı etkinleştir' }).click();
    await page.getByText('Aktif ücretli veya kalıcı lisansınız korunuyor; kampanya hakkı mevcut lisansın üzerine yazılmaz.').waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText('Kalıcı', { exact: true }).isVisible(), true);

    assert.deepEqual(pageErrors, []);
    await context.close();
  } finally {
    if (previousEnvKeyFile === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = previousEnvKeyFile;
    if (previousEnvKeyPem === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM = previousEnvKeyPem;
    if (browser) await browser.close();
    if (webServer) await webServer.close();
    if (apiServer) await apiServer.close();
    if (websiteServer) await websiteServer.close();
    if (authStore) authStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
