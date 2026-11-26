import { register } from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from '@playwright/test';
import { createPanelServer } from '../server.js';
import { createApp } from '../../api/src/http/app.js';
import { createAiConversationService } from '../../api/src/ai/ai-conversation-service.js';
import { createAiProviderRegistry } from '../../api/src/ai/ai-provider-registry.js';
import { createAiToolRegistry } from '../../api/src/ai/ai-tool-registry.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../../api/src/ai/ai-tool-catalog.js';
import { createAuthenticatedApi } from '../../api/src/auth/auth-http.js';
import { createAuthStore } from '../../api/src/auth/auth-store.js';
import {
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  FREE_BASELINE_CAPABILITIES,
  PREMIUM_CAPABILITIES,
} from '../../api/src/panel/license-entitlement-verifier.js';
import { createLicenseEntitlementService } from '../../api/src/panel/license-entitlement-service.js';
import { createServerRegistry } from '../../api/src/runtime/server-registry.js';

register('./jsx-loader.js', import.meta.url);

const {
  default: LicenseSettingsPanel,
  LicenseSummaryView,
} = await import('../src/workspace/LicenseSettingsPanel.jsx');
const {
  formatBillingPeriodLabel,
  formatLicenseError,
  formatLicenseStatusLabel,
  resolveLicenseBadgeState,
  sanitizeExternalYunsoftUrl,
} = await import('../src/workspace/license-client.js');
const { WorkspaceContext } = await import('../src/workspace/WorkspaceContext.jsx');

function generateTestEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const kid = computePublicKeyId(spkiDer);
  return { publicKey, privateKey, publicKeyPem, kid };
}

function signTestToken(privateKey, kid, {
  licenseId = 'lic_e2e_web_01',
  entitlementVersion = 1,
  periodMonths = 1,
  durationSeconds = periodMonths === 12 ? 365 * 86400 : 30 * 86400,
  domain = 'panel.example.test',
  instanceId = null,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const exp = nowSec + durationSeconds;
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

test('license-client formatters cover Free, Monthly (1m), Yearly (12m), Expired, and anti-rollback errors cleanly', () => {
  assert.equal(formatLicenseStatusLabel({ valid: false, status: 'free' }), 'Ücretsiz sürüm');
  assert.equal(formatLicenseStatusLabel({ valid: true, tier: 'premium', renewalRequired: false }), 'Aktif');
  assert.equal(formatLicenseStatusLabel({ valid: true, tier: 'premium', renewalRequired: true }), 'Yenileme yaklaştı');
  assert.equal(formatLicenseStatusLabel({ valid: false, status: 'expired' }), 'Süresi doldu');
  assert.equal(formatLicenseStatusLabel({ valid: false, status: 'revoked' }), 'İptal edildi');
  assert.equal(formatLicenseStatusLabel({ valid: false, status: 'unverified' }), 'Doğrulama anahtarı eksik');

  assert.equal(resolveLicenseBadgeState({ valid: false, status: 'free' }), 'unknown');
  assert.equal(resolveLicenseBadgeState({ valid: true, tier: 'premium', renewalRequired: false }), 'active');
  assert.equal(resolveLicenseBadgeState({ valid: true, tier: 'premium', renewalRequired: true }), 'warning');
  assert.equal(resolveLicenseBadgeState({ valid: false, status: 'expired' }), 'expired');

  assert.equal(formatBillingPeriodLabel({ periodMonths: 1, billingPeriod: 'monthly' }), 'Aylık · 1 ay');
  assert.equal(formatBillingPeriodLabel({ periodMonths: 12, billingPeriod: 'yearly' }), 'Yıllık · 12 ay');
  assert.equal(formatBillingPeriodLabel({ periodMonths: 3, billingPeriod: 'promotional', grantKind: 'promotional' }), 'Kampanya · 3 ay');
  assert.equal(formatBillingPeriodLabel({ periodMonths: null, billingPeriod: 'permanent', grantKind: 'permanent' }), 'Kalıcı');
  assert.equal(formatBillingPeriodLabel({ periodMonths: null, billingPeriod: null }), '—');

  assert.equal(
    sanitizeExternalYunsoftUrl('https://yunsoft.com/kampanya/premium-3-ay?email=owner@ornek.test', {
      fallbackUrl: 'https://yunsoft.com/kampanya/premium-3-ay',
      allowLoopbackHttp: false,
    }),
    'https://yunsoft.com/kampanya/premium-3-ay',
  );
  assert.equal(
    sanitizeExternalYunsoftUrl('http://yunsoft.com/kampanya/premium-3-ay', { allowLoopbackHttp: false }),
    null,
  );
  assert.equal(
    sanitizeExternalYunsoftUrl('https://192.0.2.44/kampanya/premium-3-ay', { allowLoopbackHttp: false }),
    null,
  );

  assert.match(formatLicenseError({ code: 'paid_or_permanent_entitlement_protected' }), /ücretli veya kalıcı lisansınız korunuyor/);
  assert.match(formatLicenseError({ code: 'stale_license_token' }), /mevcut sürümden daha eski/);
  assert.match(formatLicenseError({ code: 'license_product_mismatch' }), /başka bir Yunsoft ürününe/);
  assert.match(formatLicenseError({ code: 'license_domain_mismatch' }), /eşleşmiyor/);
  assert.match(formatLicenseError({ code: 'license_exchange_unreachable' }), /korunmaya devam ediyor/);
});

test('LicenseSummaryView and LicenseSettingsPanel render Owner and non-Owner states without hardcoded prices or AI slop', () => {
  const freeOwnerMarkup = renderToStaticMarkup(
    createElement(
      WorkspaceContext.Provider,
      { value: { isOwner: true, canManage: true, license: { data: null, refresh: () => {} } } },
      createElement(LicenseSettingsPanel, {
        initialLicense: {
          valid: false,
          tier: 'free',
          status: 'free',
          panelHost: 'panel.example.test',
          panelDomain: 'panel.example.test',
          panelDomainValid: true,
          verificationKeyConfigured: true,
          instanceId: 'srv-local-01',
          capabilities: FREE_BASELINE_CAPABILITIES,
        },
      }),
    ),
  );
  assert.ok(freeOwnerMarkup.includes('Lisans durumu'));
  assert.ok(freeOwnerMarkup.includes('Ücretsiz sürüm'));
  assert.ok(freeOwnerMarkup.includes('Tek yönetici ile sınırsız site, site terminali ve SFTP'));
  assert.ok(freeOwnerMarkup.includes('Ayrı müşteri ve site yöneticisi panel hesapları'));
  assert.ok(freeOwnerMarkup.includes('Lisans etkinleştirme ve yenileme'));
  assert.ok(freeOwnerMarkup.includes('srv-local-01'));

  const yearlyMarkup = renderToStaticMarkup(
    createElement(LicenseSummaryView, {
      isOwner: true,
      onRefresh: () => {},
      onRequestDeactivate: () => {},
      license: {
        valid: true,
        tier: 'premium',
        status: 'active',
        billingPeriod: 'yearly',
        periodMonths: 12,
        domain: 'panel.example.test',
        expiresAt: '2027-11-15T12:00:00.000Z',
        daysRemaining: 365,
        hasStoredLicenseKey: true,
        maskedLicenseKey: 'YUN-****-9999',
        instanceId: 'srv-local-01',
        verificationKeyConfigured: true,
        panelDomainValid: true,
        capabilities: PREMIUM_CAPABILITIES,
      },
    }),
  );
  assert.ok(yearlyMarkup.includes('Premium'));
  assert.ok(yearlyMarkup.includes('Yıllık · 12 ay'));
  assert.ok(yearlyMarkup.includes('YUN-****-9999'));
  assert.ok(yearlyMarkup.includes('Lisansı doğrula ve yenile'));
  assert.ok(yearlyMarkup.includes('Lisansı kaldır'));

  const expiredMarkup = renderToStaticMarkup(
    createElement(LicenseSummaryView, {
      isOwner: true,
      license: {
        valid: false,
        tier: 'free',
        status: 'expired',
        domain: 'panel.example.test',
        capabilities: FREE_BASELINE_CAPABILITIES,
      },
    }),
  );
  assert.ok(expiredMarkup.includes('Premium yetkileri duraklatıldı'));
  assert.ok(expiredMarkup.includes('Mevcut siteleriniz, verileriniz ve sertifikalarınız çalışmaya devam eder'));

  // Non-owner view hides activation form and sensitive instance/key fields
  const nonOwnerMarkup = renderToStaticMarkup(
    createElement(
      WorkspaceContext.Provider,
      { value: { isOwner: false, canManage: false, license: { data: null, refresh: () => {} } } },
      createElement(LicenseSettingsPanel, {
        initialLicense: {
          valid: true,
          tier: 'premium',
          status: 'active',
          billingPeriod: 'monthly',
          periodMonths: 1,
          maskedLicenseKey: 'YUN-****-9999',
          instanceId: 'srv-local-01',
          capabilities: PREMIUM_CAPABILITIES,
        },
      }),
    ),
  );
  assert.ok(nonOwnerMarkup.includes('Aylık · 1 ay'));
  assert.ok(!nonOwnerMarkup.includes('Lisans etkinleştirme ve yenileme'));
  assert.ok(!nonOwnerMarkup.includes('YUN-****-9999'));
  assert.ok(!nonOwnerMarkup.includes('srv-local-01'));

  // Strict AGENTS.md §6 & scope audit: zero hardcoded prices, zero iyzico coupling, zero parenthetical buzzwords
  const panelSource = readFileSync(new URL('../src/workspace/LicenseSettingsPanel.jsx', import.meta.url), 'utf8');
  const clientSource = readFileSync(new URL('../src/workspace/license-client.js', import.meta.url), 'utf8');
  const combinedUiSource = `${panelSource}\n${clientSource}`;
  for (const forbidden of ['1250', '12000', '240 USD', '25 USD', 'iyzico', 'Plesk', 'Easypanel', 'aaPanel', 'fail-closed']) {
    assert.ok(!combinedUiSource.includes(forbidden), `Forbidden UI token present: ${forbidden}`);
  }
});

test('Playwright Chromium E2E: Owner activates Monthly key, refreshes to Yearly, rejects stale token replay, and deactivates cleanly', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-lic-web-e2e-'));
  let commerceServer = null;
  let apiServer = null;
  let webServer = null;
  let browser = null;
  let authStore = null;
  const previousEnvKeyFile = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
  const previousEnvKeyPem = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

  try {
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

    const keys = generateTestEd25519KeyPair();
    const devPublicKeyPath = path.join(tmpDir, 'dev-commerce-public.pem');
    writeFileSync(devPublicKeyPath, keys.publicKeyPem, { mode: 0o600 });
    const webPort = await reserveLoopbackPort();
    const publicOrigin = `http://127.0.0.1:${webPort}`;
    const proxyToken = crypto.randomBytes(32).toString('base64url');

    authStore = createAuthStore({
      filePath: path.join(tmpDir, 'auth.sqlite'),
      masterKey: crypto.randomBytes(32).toString('hex'),
    });
    const setup = authStore.issueSetupToken();
    await authStore.completeSetup({
      setupToken: setup.token,
      username: 'owneradmin',
      password: 'StrongWebOwnerPassword!2026',
    });

    const serverRegistry = createServerRegistry({
      filePath: path.join(tmpDir, 'servers.json'),
    });
    const localServer = await serverRegistry.createLocalServer({
      hostname: 'panel.example.test',
      displayName: 'Local Web E2E Host',
    });
    const localServerId = localServer.id;

    let currentCommercePeriodMonths = 1;
    let currentCommerceVersion = 1;
    let v1SavedToken = null;

    commerceServer = await listenServer(http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        res.setHeader('content-type', 'application/json; charset=utf-8');

        if (req.method === 'POST' && (req.url === '/v1/entitlements/activate' || req.url === '/v1/entitlements/verify')) {
          if (body.licenseKey !== 'YUN-E2E-2026-0001') {
            res.writeHead(404);
            res.end(JSON.stringify({ ok: false, error: 'License key not found.' }));
            return;
          }
          const signed = signTestToken(keys.privateKey, keys.kid, {
            licenseId: 'lic_e2e_browser_01',
            entitlementVersion: currentCommerceVersion,
            periodMonths: currentCommercePeriodMonths,
            domain: body.domain || 'panel.example.test',
            instanceId: body.instanceId || localServerId,
          });
          if (currentCommerceVersion === 1) {
            v1SavedToken = signed;
          }
          res.writeHead(200);
          res.end(JSON.stringify({
            data: req.url === '/v1/entitlements/activate'
              ? { activated: true, entitlementToken: signed }
              : { valid: true, tier: 'premium', entitlementToken: signed },
          }));
          return;
        }

        if (req.method === 'POST' && req.url === '/v1/entitlements/deactivate') {
          res.writeHead(200);
          res.end(JSON.stringify({ data: { deactivated: true } }));
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not_found' }));
      });
    }));

    const masterKey = crypto.randomBytes(32).toString('hex');

    // 1. Default out-of-the-box customer install service (no manual publicKeyPem / publicKeyFile required)
    const defaultVendorLicenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license-default', 'entitlement.json'),
      systemPublicKeyFile: path.join(tmpDir, 'absent-etc-entitlement-public.pem'),
      publicOrigin,
      instanceId: localServerId,
      commerceBaseUrl: commerceServer.baseUrl,
      masterKey,
      development: true,
    });

    let activeLicenseService = defaultVendorLicenseService;
    const licenseService = {
      getStatus: (...args) => activeLicenseService.getStatus(...args),
      hasCapability: (...args) => activeLicenseService.hasCapability(...args),
      requireCapability: (...args) => activeLicenseService.requireCapability(...args),
      activate: (...args) => activeLicenseService.activate(...args),
      refresh: (...args) => activeLicenseService.refresh(...args),
      deactivate: (...args) => activeLicenseService.deactivate(...args),
    };

    const aiToolRegistry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
    const aiProviderRegistry = createAiProviderRegistry({
      filePath: path.join(tmpDir, 'ai-providers.json'),
      masterKey: crypto.randomBytes(32).toString('hex'),
    });
    const aiConversationService = createAiConversationService({
      filePath: path.join(tmpDir, 'ai-conversations.json'),
      providerRegistry: aiProviderRegistry,
      toolRegistry: aiToolRegistry,
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
        aiToolRegistry,
        aiAudit: authStore.audit,
        aiProviderRegistry,
        aiConversationService,
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

    await page.goto(`${publicOrigin}/settings?section=license`, { waitUntil: 'networkidle' });

    // Sign in as Owner
    await page.locator('input[name="username"]').fill('owneradmin');
    await page.locator('input[name="password"]').fill('StrongWebOwnerPassword!2026');
    await page.getByRole('button', { name: 'Giriş yap' }).click();

    // Verify Free baseline state in Settings -> Lisans on fresh default install (vendor kid=1cbcc4d3173d0c15 ready out-of-the-box!)
    await page.getByRole('heading', { name: 'Lisans durumu' }).waitFor({ timeout: 15_000 });
    // Assert the real authenticated Settings navigation in this existing Chromium flow.
    const settingsTabs = page.getByRole('navigation', { name: 'Ayar kategorileri', exact: true });
    assert.deepEqual((await settingsTabs.getByRole('link').allTextContents()).map(value => value.trim()), [
      'Hesap ve erişim', 'Lisans', 'DNS ve SSL', 'AI sağlayıcıları', 'API anahtarları', 'Bildirimler', 'Güncellemeler',
    ]);
    assert.equal(await settingsTabs.getByRole('link', { name: 'Lisans', exact: true }).getAttribute('href'), '/settings?section=license');
    assert.equal(await settingsTabs.locator('a[href="/settings?section=records"]').count(), 0);

    await page.getByText('Ücretsiz sürüm').first().waitFor();
    await page.getByText('Tek yönetici ile sınırsız site, site terminali ve SFTP').waitFor();
    await page.getByText('Ayrı müşteri ve site yöneticisi panel hesapları').waitFor();
    assert.equal(
      await page.getByText('Doğrulama anahtarı tanımlı değil').count(),
      0,
      'Fresh default install must NOT display missing verification key warning to Owner',
    );
    const initialApiStatus = await page.evaluate(async () => {
      const r = await fetch('/api/panel/license', { credentials: 'same-origin' });
      return r.json();
    });
    assert.equal(initialApiStatus.data.verificationKeyConfigured, true);
    assert.deepEqual(initialApiStatus.data.trustedKeyIds, ['1cbcc4d3173d0c15']);

    // Switch to source-dev YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE env override for ephemeral local Commerce signing test
    process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = devPublicKeyPath;
    activeLicenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicOrigin,
      instanceId: localServerId,
      commerceBaseUrl: commerceServer.baseUrl,
      masterKey,
      development: true,
    });

    // Activate Monthly (periodMonths: 1) via License Key exchange
    await page.getByLabel('Lisans anahtarı').fill('YUN-E2E-2026-0001');
    await page.getByLabel('Lisanslı alan adı').fill('panel.example.test');
    const [activateResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panel/license/activate') && r.request().method() === 'POST', { timeout: 5_000 }),
      page.getByRole('button', { name: 'Lisansı etkinleştir' }).click(),
    ]);
    const activateBody = await activateResp.json();
    assert.equal(activateResp.status(), 200, `Activate failed: ${JSON.stringify(activateBody)}`);

    await page.getByText('YunPanel Premium lisansı doğrulandı ve etkinleştirildi.').waitFor({ timeout: 5_000 });
    await page.getByText('Aylık · 1 ay').waitFor();
    await page.getByText('YUN-****-****-0001').waitFor();

    // Upgrade on Commerce side to Yearly (periodMonths: 12, entitlementVersion: 2) and click Refresh
    currentCommercePeriodMonths = 12;
    currentCommerceVersion = 2;
    await page.getByRole('button', { name: 'Lisansı doğrula ve yenile' }).click();

    await page.getByText('Yıllık · 12 ay').waitFor({ timeout: 10_000 });

    // Attempt stale v1 token replay via UI -> rejected with anti-rollback message while preserving Yearly v2!
    assert.ok(v1SavedToken, 'Expected saved v1 token from initial activation');
    await page.getByRole('button', { name: 'İmzalı jeton' }).click();
    await page.getByLabel('İmzalı lisans jetonu').fill(v1SavedToken);
    await page.getByRole('button', { name: 'Lisansı etkinleştir' }).click();

    await page.getByText('Bu lisans jetonu mevcut sürümden daha eski. Güncel lisans jetonunuzu girin.').waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText('Yıllık · 12 ay').isVisible(), true);

    // Deactivate license with explicit confirmation dialog -> returns cleanly to Free baseline
    await page.getByRole('button', { name: 'Lisansı kaldır' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.locator('input').fill('deactivate-license');
    await dialog.getByRole('button', { name: 'Lisansı kaldır' }).click();

    await page.getByText('Lisans bu kurulumdan kaldırıldı. Panel ücretsiz sürümde çalışmaya devam ediyor.').waitFor({ timeout: 10_000 });
    await page.getByText('Ücretsiz sürüm').first().waitFor();
  } finally {
    if (previousEnvKeyFile === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = previousEnvKeyFile;
    if (previousEnvKeyPem === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM = previousEnvKeyPem;
    if (browser) await browser.close();
    if (webServer) await webServer.close();
    if (apiServer) await apiServer.close();
    if (commerceServer) await commerceServer.close();
    if (authStore) authStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
