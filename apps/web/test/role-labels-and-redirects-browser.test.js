import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createDomainRegistry } from '../../api/src/domain-registry.js';
import {
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  PREMIUM_CAPABILITIES,
} from '../../api/src/license-entitlement-verifier.js';
import { createLicenseEntitlementService } from '../../api/src/license-entitlement-service.js';
import { createPowerDnsAuthoritativeService } from '../../api/src/powerdns-authoritative-service.js';
import { createPowerDnsSecretRegistry } from '../../api/src/powerdns-secret-registry.js';
import { createServerDnsIdentityRegistry } from '../../api/src/server-dns-identity-registry.js';
import { createServerRegistry } from '../../api/src/server-registry.js';
import { createWebsiteRegistry } from '../../api/src/website-registry.js';

function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const kid = computePublicKeyId(spkiDer);
  return { privateKey, publicKeyPem, kid };
}

function signRealEntitlementToken(privateKey, kid, {
  licenseId = 'lic_wave2a_roles_01',
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

async function loginInFreshContext(browser, publicOrigin, username, password) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(`${publicOrigin}/websites`, { waitUntil: 'networkidle' });
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await page.locator('.auth-role').waitFor({ timeout: 15_000 });
  return { context, page, pageErrors };
}

test('panel-session, AuthGate, UsersPage, WorkspaceApp and WorkspaceLayout wire Turkish role labels and unauthorized redirect state', () => {
  const sessionSrc = readFileSync(new URL('../src/panel-session.jsx', import.meta.url), 'utf8');
  const authGateSrc = readFileSync(new URL('../src/AuthGate.jsx', import.meta.url), 'utf8');
  const usersSrc = readFileSync(new URL('../src/workspace/UsersPage.jsx', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../src/workspace/WorkspaceApp.jsx', import.meta.url), 'utf8');
  const layoutSrc = readFileSync(new URL('../src/workspace/WorkspaceLayout.jsx', import.meta.url), 'utf8');

  assert.match(sessionSrc, /export function formatUserRoleLabel\(user\)/);
  assert.match(sessionSrc, /Sunucu Yöneticisi/);
  assert.match(sessionSrc, /Bayi/);
  assert.match(sessionSrc, /Müşteri/);
  assert.match(sessionSrc, /Site Yöneticisi/);
  assert.match(sessionSrc, /Salt Okunur/);
  assert.match(sessionSrc, /Kullanıcı/);
  assert.match(authGateSrc, /formatUserRoleLabel\(state\.session\.user\)/);
  assert.match(usersSrc, /formatUserRoleLabel\(user\)/);
  assert.match(appSrc, /accessDeniedRedirect: \{ from: location\.pathname \}/);
  assert.match(layoutSrc, /data-access-redirect-notice="true"/);
});

test('Real Playwright Chromium E2E (Zero Mocks): Turkish role labels, unauthorized redirect banner, foreign-site 404 isolation, and Turkish DNS/Updates UI', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-wave2a-roles-e2e-'));
  let apiServer = null;
  let webServer = null;
  let browser = null;
  let authStore = null;
  const previousEnvKeyFile = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
  const previousEnvKeyPem = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

  const ownerPassword = 'Wave2AOwnerPassword!2026';
  const resellerPassword = 'Wave2AResellerPass!2026';
  const customerPassword = 'Wave2ACustomerPass!2026';
  const siteManagerPassword = 'Wave2ASiteMgrPass!2026';
  const readOnlyPassword = 'Wave2AReadOnlyPass!2026';

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
      displayName: 'Wave2A Local Host',
    });
    const localServerId = localServer.id;

    const websiteRegistry = createWebsiteRegistry({
      filePath: path.join(tmpDir, 'websites.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    });
    await websiteRegistry.init();

    const domainRegistry = createDomainRegistry({
      filePath: path.join(tmpDir, 'domains.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
      getWebsite: (id) => websiteRegistry.getWebsite(id),
    });
    await domainRegistry.init();

    // Real persisted websites & domains (own + foreign) for strict isolation & ReadOnly draft verification
    const ownWebsite = await websiteRegistry.createWebsite({
      serverId: localServerId,
      name: 'own-site.example.test',
      runtimeType: 'proxy',
      proxyTarget: { host: '127.0.0.1', port: 41001 },
    });
    const ownDomain = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'own-site.example.test',
      targetType: 'proxy',
      target: { upstreamPort: 41001 },
      websiteId: ownWebsite.id,
    });

    const foreignWebsite = await websiteRegistry.createWebsite({
      serverId: localServerId,
      name: 'foreign-secret-site.example.test',
      runtimeType: 'proxy',
      proxyTarget: { host: '127.0.0.1', port: 41002 },
    });
    const foreignDomain = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'foreign-secret-site.example.test',
      targetType: 'proxy',
      target: { upstreamPort: 41002 },
      websiteId: foreignWebsite.id,
    });

    // Real Server DNS Identity with same-host ns1/ns2 -> produces REAL dns_nameserver_redundancy_missing warning
    const serverDnsIdentityRegistry = createServerDnsIdentityRegistry({
      filePath: path.join(tmpDir, 'dns-identity.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    });
    await serverDnsIdentityRegistry.init();
    const dnsSettings = {
      publicIpv4: '203.0.113.10',
      publicIpv6: null,
      ns1: { hostname: 'ns1.panel.example.test', ipv4: '203.0.113.10', ipv6: null, local: true },
      ns2: { hostname: 'ns2.panel.example.test', ipv4: '203.0.113.10', ipv6: null, local: true },
      soa: { rname: 'hostmaster.panel.example.test', refresh: 3600, retry: 900, expire: 1209600, minimum: 300, ttl: 300 },
      dnssecDefault: false,
      secondaryDns: [],
    };
    const dnsPlan = await serverDnsIdentityRegistry.preview({
      serverId: localServerId,
      settings: dnsSettings,
    });
    await serverDnsIdentityRegistry.update({
      serverId: localServerId,
      expectedRevision: dnsPlan.currentRevision,
      settings: dnsSettings,
      previewDigest: dnsPlan.previewDigest,
      confirmation: dnsPlan.confirmation,
    });

    const powerDnsSecretRegistry = createPowerDnsSecretRegistry({
      filePath: path.join(tmpDir, 'powerdns-secrets.json'),
      masterKey,
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    });
    await powerDnsSecretRegistry.init();

    const powerDnsAuthoritativeService = createPowerDnsAuthoritativeService({
      localServerId,
      serverRegistry,
      dnsIdentityRegistry: serverDnsIdentityRegistry,
      secretRegistry: powerDnsSecretRegistry,
    });

    const licenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicKeyFile: publicKeyPath,
      publicOrigin,
      instanceId: localServerId,
      masterKey,
      development: true,
    });

    // Activate real locally signed Ed25519 dev Premium license via real service
    const signedToken = signRealEntitlementToken(keys.privateKey, keys.kid, {
      licenseId: 'lic_wave2a_browser_01',
      entitlementVersion: 1,
      periodMonths: 12,
      domain: 'panel.example.test',
      instanceId: localServerId,
    });
    await licenseService.activate({ token: signedToken });

    // Create real legacy site_manager (bound ONLY to ownWebsite) and read_only account in real SQLite AuthStore
    const bootstrapOwner = await authStore.login({ username: 'owneradmin', password: ownerPassword });
    await authStore.users.create(
      bootstrapOwner.token,
      (session) => session,
      { username: 'auditor', password: readOnlyPassword, role: 'read_only', active: true },
    );
    await authStore.users.createSiteManager({
      username: 'legacyadmin',
      password: siteManagerPassword,
      websiteId: ownWebsite.id,
      websiteLookup: async (id) => Boolean(await websiteRegistry.getWebsite(id)),
    });
    authStore.revokeSession(bootstrapOwner.token);

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
        websiteRegistry,
        domainRegistry,
        serverDnsIdentityRegistry,
        powerDnsSecretRegistry,
        powerDnsAuthoritativeService,
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

    // --- 1. Owner: role label, real Reseller & Customer creation, UsersPage Turkish labels, DNS & Updates UI ---
    {
      const { context, page, pageErrors } = await loginInFreshContext(browser, publicOrigin, 'owneradmin', ownerPassword);
      try {
        assert.equal((await page.locator('.auth-role').innerText()).trim(), 'Sunucu Yöneticisi');

        // Create real Reseller & Customer through real authenticated API using real CSRF token
        const created = await page.evaluate(async ({ resPw, custPw }) => {
          const sess = await (await fetch('/api/auth/session', { credentials: 'same-origin' })).json();
          const csrf = sess?.data?.csrfToken ?? '';
          const rResp = await fetch('/api/panel/users/hosting/accounts/create-login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify({
              kind: 'reseller',
              username: 'pilotbayi',
              password: resPw,
              limits: { maxCustomers: 5, maxWebsites: 10 },
            }),
          });
          const rBody = await rResp.json();
          const resellerId = rBody?.data?.account?.id ?? rBody?.data?.id ?? rBody?.account?.id;
          const cResp = await fetch('/api/panel/users/hosting/accounts/create-login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify({
              kind: 'customer',
              username: 'pilotmusteri',
              password: custPw,
              resellerId,
            }),
          });
          const cBody = await cResp.json();
          return { rStatus: rResp.status, cStatus: cResp.status, resellerId, cBody };
        }, { resPw: resellerPassword, custPw: customerPassword });
        assert.equal(created.rStatus, 201);
        assert.equal(created.cStatus, 201);

        // /users Hesaplar section renders Turkish role labels (Sunucu Yöneticisi, Site Yöneticisi, Salt Okunur) and zero English Owner/Read Only
        await page.goto(`${publicOrigin}/users`, { waitUntil: 'networkidle' });
        const accountsSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Hesaplar' }) });
        await accountsSection.getByRole('cell', { name: 'Sunucu Yöneticisi' }).first().waitFor({ timeout: 10_000 });
        await accountsSection.getByRole('cell', { name: 'Salt Okunur' }).first().waitFor({ timeout: 10_000 });
        const usersSectionText = await accountsSection.innerText();
        assert.equal(usersSectionText.includes('Read Only'), false, 'UsersPage Hesaplar section must not show English "Read Only"');
        assert.equal(/\bOwner\b/.test(usersSectionText), false, 'UsersPage Hesaplar section must not show English "Owner"');

        // /settings?section=dns: clean Turkish headings, labels, and Turkish redundancy warning with collapsed Destek kodu
        await page.goto(`${publicOrigin}/settings?section=dns`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Ağ ve Yetkili DNS' }).waitFor({ timeout: 10_000 });
        await page.getByRole('heading', { name: 'PowerDNS Yerel ve Dış Erişim Durumu' }).waitFor({ timeout: 10_000 });
        await page.getByRole('heading', { name: 'Alan Adı Kayıt ve Delege Bilgisi' }).waitFor({ timeout: 10_000 });
        await page.getByText('Yedekli DNS eksik: ns1 ve ns2 aynı sunucu adresine yönleniyor', { exact: false }).waitFor({ timeout: 10_000 });

        const dnsText = await page.locator('main').innerText();
        for (const required of [
          'DNS kimlik sürümü',
          'Genel IPv4',
          'Genel IPv6',
          'SOA yetkili adresi',
          'Yeni bölgeler için varsayılan DNSSEC',
          'İkincil DNS aktarım hedefleri',
          'Yapılandırıldı',
          'API anahtarı',
          'Yerel UDP/53',
          'Yerel TCP/53',
          'Özyinelemeli çözümleyici',
          'Dış UDP/53',
          'Dış TCP/53',
          'Dış doğrulama noktası',
          'Yetkili DNS genel durumu',
          'Destek kodu',
        ]) {
          assert.equal(dnsText.includes(required), true, `Expected Turkish DNS label "${required}" on /settings?section=dns`);
        }
        for (const forbidden of [
          'Network / Authoritative DNS',
          'PowerDNS local / public health',
          'Registrar / delegation',
          'DNS identity revision',
          'Public IPv4',
          'SOA responsible name',
          'Secondary transfer targets',
          'Sunucu hostname authority değişmez',
          'ayrı evidence kaynaklarıdır',
          'Durable operation',
          'Local authoritative hazır',
          'Public erişim doğrulanmadı',
        ]) {
          assert.equal(dnsText.includes(forbidden), false, `Forbidden English/dev jargon "${forbidden}" found on /settings?section=dns`);
        }
        // Raw error code lives inside <details><summary>Destek kodu</summary><code>...</code></details>
        const supportDetails = page.locator('details.ws-support-code').filter({ hasText: 'Destek kodu' }).first();
        assert.equal(await supportDetails.locator('code').textContent(), 'dns_nameserver_redundancy_missing');

        // /settings?section=updates: clean Turkish APT update copy
        await page.goto(`${publicOrigin}/settings?section=updates`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'YunPanel Güncellemeleri', exact: true }).waitFor({ timeout: 10_000 });
        const updatesText = await page.locator('main').textContent();
        for (const required of [
          'APT Paketi',
          'YunPanel Güncellemeleri',
          'YunPanel paketi için güncel sürümü APT deposundan denetleyin.',
          'Kurulu sürüm',
          'Aday sürüm',
          'Henüz denetlenmedi',
          'Güncellemeleri denetle',
        ]) {
          assert.equal(
            updatesText.includes(required),
            true,
            `Expected Turkish update label "${required}" on /settings?section=updates`,
          );
        }
        for (const forbidden of [
          'APT package',
          'YunPanel updates',
          'Check the APT repository',
          'Installed',
          'Candidate',
          'Not checked',
          'Check updates',
        ]) {
          assert.equal(updatesText.includes(forbidden), false, `Forbidden English update text "${forbidden}" found on /settings?section=updates`);
        }

        // /websites/<ownDomain>/dns: clean Turkish zone labels and Kayıtları kontrol et / Yenile button
        await page.goto(`${publicOrigin}/websites/${ownDomain.id}/dns`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Yetkili DNS Bölgesi', exact: true }).waitFor({ timeout: 10_000 });
        await page.getByRole('button', { name: 'Kayıtları kontrol et / Yenile' }).first().waitFor({ timeout: 10_000 });
        const siteDnsText = await page.locator('main').innerText();
        for (const forbidden of [
          'Authoritative DNS zone',
          'Zone Template senkronizasyonu',
          'YunPanel ownership marker',
          'read-only görünür',
          'restart sonrası inspect-first recovery',
        ]) {
          assert.equal(siteDnsText.includes(forbidden), false, `Forbidden English/dev DNS text "${forbidden}" found on site DNS tab`);
        }

        assert.deepEqual(pageErrors, [], `Owner pageerrors: ${pageErrors.join('; ')}`);
      } finally {
        await context.close();
      }
    }

    // --- 2. Non-owner roles: Turkish .auth-role badge + unauthorized direct-URL redirect notice + foreign-site 404 isolation ---
    const roleCases = [
      {
        username: 'pilotbayi',
        password: resellerPassword,
        expectedRoleLabel: 'Bayi',
        unauthorizedPaths: ['/firewall', '/users', '/settings'],
        checkForeignSite: true,
      },
      {
        username: 'pilotmusteri',
        password: customerPassword,
        expectedRoleLabel: 'Müşteri',
        unauthorizedPaths: ['/firewall', '/users', '/settings'],
        checkForeignSite: true,
      },
      {
        username: 'legacyadmin',
        password: siteManagerPassword,
        expectedRoleLabel: 'Site Yöneticisi',
        unauthorizedPaths: ['/firewall', '/users', '/settings'],
        checkForeignSite: true,
        expectedOwnDomain: ownDomain.primaryDomain,
      },
      {
        username: 'auditor',
        password: readOnlyPassword,
        expectedRoleLabel: 'Salt Okunur',
        unauthorizedPaths: ['/firewall', '/users', '/settings'],
        checkReadOnlySite: ownDomain.id,
      },
    ];

    for (const tc of roleCases) {
      const { context, page, pageErrors } = await loginInFreshContext(browser, publicOrigin, tc.username, tc.password);
      try {
        const badgeText = (await page.locator('.auth-role').innerText()).trim();
        assert.equal(badgeText, tc.expectedRoleLabel, `Expected .auth-role "${tc.expectedRoleLabel}" for ${tc.username}, got "${badgeText}"`);

        // Direct navigation to each unauthorized owner-only URL redirects to /websites AND shows Turkish notice
        for (const blockedPath of tc.unauthorizedPaths) {
          await page.goto(`${publicOrigin}${blockedPath}`, { waitUntil: 'networkidle' });
          await page.waitForURL((url) => url.pathname === '/websites', { timeout: 10_000 });
          const redirectNotice = page.locator('[data-access-redirect-notice="true"]');
          await redirectNotice.waitFor({ timeout: 10_000 });
          const noticeText = await redirectNotice.innerText();
          assert.ok(noticeText.includes('erişim yetkiniz olmadığı'), `Expected Turkish redirect notice on ${blockedPath} for ${tc.username}`);
        }

        // Dismiss button clears the redirect notice cleanly
        const redirectNotice = page.locator('[data-access-redirect-notice="true"]');
        await redirectNotice.getByRole('button', { name: 'Yetki yönlendirme bildirimini kapat' }).click();
        assert.equal(await redirectNotice.count(), 0, `Dismiss must close redirect notice for ${tc.username}`);

        // Verify legacy site_manager sees own website and NOT foreign website
        if (tc.expectedOwnDomain) {
          await page.getByText(tc.expectedOwnDomain).first().waitFor({ timeout: 10_000 });
          const listText = await page.locator('main').innerText();
          assert.equal(listText.includes(foreignDomain.primaryDomain), false, `Foreign domain must not appear in list for ${tc.username}`);
        }

        // CRITICAL SECURITY INVARIANT: foreign website/domain URLs MUST still show non-leaking "Web sitesi bulunamadı"
        if (tc.checkForeignSite) {
          for (const foreignId of [foreignDomain.id, foreignWebsite.id]) {
            await page.goto(`${publicOrigin}/websites/${foreignId}`, { waitUntil: 'networkidle' });
            await page.getByRole('heading', { name: 'Web sitesi bulunamadı' }).waitFor({ timeout: 10_000 });
            const foreignPageText = await page.locator('main').innerText();
            assert.equal(foreignPageText.includes(foreignDomain.primaryDomain), false, `Foreign domain leaked for ${tc.username} on ${foreignId}`);
            assert.equal(await page.locator('[data-access-redirect-notice="true"]').count(), 0, 'Foreign-site 404 must not trigger access redirect notice');
          }
        }

        // Read Only pages: Turkish "Salt Okunur", zero "Read Only", no "Siteyi aç" on draft site, no raw draft/proxy enum
        if (tc.checkReadOnlySite) {
          const roListText = await page.locator('main').innerText();
          assert.equal(roListText.includes('Salt Okunur'), true);
          assert.equal(roListText.includes('Read Only'), false);

          await page.goto(`${publicOrigin}/websites/${tc.checkReadOnlySite}`, { waitUntil: 'networkidle' });
          await page.getByRole('heading', { name: ownDomain.primaryDomain }).waitFor({ timeout: 10_000 });
          assert.equal(await page.getByRole('link', { name: 'Siteyi aç' }).count(), 0, 'Draft site must not show misleading Siteyi aç link in ReadOnlySitePage');
          const roSiteText = await page.locator('main').innerText();
          assert.equal(roSiteText.includes('Salt Okunur'), true);
          assert.equal(roSiteText.includes('Read Only'), false);
          assert.equal(roSiteText.includes('Taslak'), true);
          assert.equal(roSiteText.includes('Uygulama proxy'), true);
          assert.equal(/\bdraft\b/i.test(roSiteText), false, 'ReadOnlySitePage must not show raw "draft" enum');
        }

        assert.deepEqual(pageErrors, [], `${tc.username} pageerrors: ${pageErrors.join('; ')}`);
      } finally {
        await context.close();
      }
    }
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
