import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore, csrfForSession } from '../src/auth-store.js';
import {
  classifyEntitlementGrantKind,
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  PREMIUM_CAPABILITIES,
  verifyYunpanelEntitlementToken,
  YUNPANEL_PRODUCT_CODE,
} from '../src/license-entitlement-verifier.js';
import {
  createLicenseEntitlementService,
  LicenseEntitlementError,
} from '../src/license-entitlement-service.js';
import { createServerRegistry } from '../src/server-registry.js';
import {
  buildSetupOfferMetadata,
  DEFAULT_YUNSOFT_DOCS_URL,
  DEFAULT_YUNSOFT_PREMIUM_OFFER_URL,
  parseStrictYunsoftPublicUrl,
  resolveYunsoftPublicUrl,
} from '../src/yunsoft-links.js';

function generateTestEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const kid = computePublicKeyId(spkiDer);
  return { publicKey, privateKey, publicKeyPem, kid };
}

function signCampaignOrLicenseToken(privateKey, kid, overrides = {}) {
  const nowSec = overrides.nowSec ?? Math.floor(Date.now() / 1000);
  const billingModel = overrides.billingModel ?? 'monthly_term';
  const isPermanent = billingModel === 'permanent' || billingModel === 'lifetime';
  const periodMonths = overrides.periodMonths === undefined
    ? (isPermanent ? null : 3)
    : overrides.periodMonths;
  const durationSeconds = overrides.durationSeconds ?? ((periodMonths ?? 3) * 30 * 86400);
  const exp = overrides.exp === undefined
    ? (isPermanent ? null : nowSec + durationSeconds)
    : overrides.exp;
  const domain = overrides.domain ?? 'panel.ornek.test';

  const header = {
    alg: 'EdDSA',
    crv: 'Ed25519',
    typ: ENTITLEMENT_TOKEN_TYPE,
    kid,
  };

  const payload = {
    iss: ENTITLEMENT_ISSUER,
    sub: overrides.sub ?? 'lic_campaign_001',
    licenseId: overrides.licenseId ?? overrides.sub ?? 'lic_campaign_001',
    jti: overrides.jti ?? crypto.randomUUID(),
    iat: overrides.iat ?? nowSec,
    nbf: overrides.nbf ?? nowSec,
    exp,
    productCode: overrides.productCode ?? YUNPANEL_PRODUCT_CODE,
    billingModel,
    periodMonths,
    status: overrides.status ?? 'active',
    domain,
    normalizedDomain: domain,
    allowedHosts: overrides.allowedHosts ?? [domain, `www.${domain}`],
    stagingHosts: overrides.stagingHosts ?? [`staging.${domain}`, `dev.${domain}`, 'localhost', '127.0.0.1'],
    startsAt: new Date((overrides.nbf ?? nowSec) * 1000).toISOString(),
    expiresAt: overrides.expiresAt !== undefined
      ? overrides.expiresAt
      : (exp === null ? null : new Date(exp * 1000).toISOString()),
    entitlementVersion: overrides.entitlementVersion ?? 1,
    activatedInstanceId: overrides.activatedInstanceId ?? null,
    edition: overrides.edition ?? 'premium',
    capabilities: { ...PREMIUM_CAPABILITIES },
    ...(overrides.grantKind ? { grantKind: overrides.grantKind } : {}),
    ...(overrides.campaignCode ? { campaignCode: overrides.campaignCode } : {}),
    ...(overrides.payloadOverrides ?? {}),
  };

  const headerB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signatureB64 = crypto.sign(null, signingInput, privateKey).toString('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

async function listenHttpServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

test('yunsoft-links strictly rejects query params, fragments, credentials, emails, HTTP in prod, and .44 hosts', () => {
  assert.equal(parseStrictYunsoftPublicUrl('https://yunsoft.com/kampanya/premium-3-ay/').url, DEFAULT_YUNSOFT_PREMIUM_OFFER_URL);
  assert.equal(parseStrictYunsoftPublicUrl('https://yunsoft.com/docs/yunpanel/').url, DEFAULT_YUNSOFT_DOCS_URL);

  for (const [badUrl, expectedReason] of [
    ['https://yunsoft.com/kampanya/premium-3-ay?email=owner@ornek.test', 'QUERY_OR_HASH_FORBIDDEN'],
    ['https://yunsoft.com/kampanya/premium-3-ay?domain=panel.ornek.test', 'QUERY_OR_HASH_FORBIDDEN'],
    ['https://yunsoft.com/kampanya/premium-3-ay#owner', 'QUERY_OR_HASH_FORBIDDEN'],
    ['https://user:pass@yunsoft.com/kampanya/premium-3-ay', 'CREDENTIALS_FORBIDDEN'],
    ['https://yunsoft.com/kampanya/owner@ornek.test', 'PII_IN_PATH_FORBIDDEN'],
    ['https://yunsoft.com/kampanya/owner%40ornek.test', 'PII_IN_PATH_FORBIDDEN'],
    ['https://192.0.2.44/kampanya/premium-3-ay', 'FORBIDDEN_HOST_DOT44'],
    ['http://yunsoft.com/kampanya/premium-3-ay', 'INSECURE_URL_PROTOCOL'],
    ['http://127.0.0.1:4100/kampanya/premium-3-ay', 'INSECURE_URL_PROTOCOL'],
  ]) {
    const check = parseStrictYunsoftPublicUrl(badUrl, { development: false });
    assert.equal(check.ok, false, `Expected rejection for ${badUrl}`);
    assert.equal(check.reason, expectedReason);
    assert.equal(
      resolveYunsoftPublicUrl(badUrl, { fallbackUrl: DEFAULT_YUNSOFT_PREMIUM_OFFER_URL, development: false }),
      DEFAULT_YUNSOFT_PREMIUM_OFFER_URL,
    );
  }

  // Loopback HTTP is permitted ONLY in local development mode (still rejecting query/hash/PII)
  const devLoopback = parseStrictYunsoftPublicUrl('http://127.0.0.1:4100/kampanya/premium-3-ay', { development: true });
  assert.equal(devLoopback.ok, true);
  assert.equal(devLoopback.url, 'http://127.0.0.1:4100/kampanya/premium-3-ay');
  assert.equal(
    parseStrictYunsoftPublicUrl('http://127.0.0.1:4100/kampanya/premium-3-ay?email=a@b.test', { development: true }).ok,
    false,
  );

  const meta = buildSetupOfferMetadata({
    offerUrl: 'https://yunsoft.com/kampanya/premium-3-ay?email=leak@ornek.test',
    docsUrl: 'https://yunsoft.com/docs/yunpanel',
    development: false,
  });
  assert.equal(meta.enabled, true);
  assert.equal(meta.durationMonths, 3);
  assert.equal(meta.creditCardRequired, false);
  assert.equal(meta.managedBy, 'yunsoft-website');
  assert.deepEqual(meta.products, ['yunpanel', 'yuncms']);
  assert.equal(meta.offerUrl, DEFAULT_YUNSOFT_PREMIUM_OFFER_URL);
  assert.equal(meta.docsUrl, DEFAULT_YUNSOFT_DOCS_URL);
});

test('3-month promotional campaign, shared campaign product scoping, and paid/permanent entitlement protections', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-campaign-lic-'));
  let commerceServer = null;
  try {
    const keys = generateTestEd25519KeyPair();
    const trustedKeys = new Map([[keys.kid, { keyId: keys.kid, publicKey: keys.publicKey }]]);
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    const nowSec = Math.floor(nowMs / 1000);

    // 1. Verifier classification & fail-closed checks
    assert.equal(classifyEntitlementGrantKind({ billingModel: 'promotional_term' }), 'promotional');
    assert.equal(classifyEntitlementGrantKind({ billingModel: 'monthly_term', campaignCode: 'NEWSLETTER-3M' }), 'promotional');
    assert.equal(classifyEntitlementGrantKind({ billingModel: 'monthly_term' }), 'paid');
    assert.equal(classifyEntitlementGrantKind({ billingModel: 'permanent' }), 'permanent');
    assert.equal(classifyEntitlementGrantKind({ billingModel: 'lifetime' }), 'permanent');

    // Term promotional license WITHOUT exp is still strictly rejected
    const promoNoExp = signCampaignOrLicenseToken(keys.privateKey, keys.kid, {
      nowSec,
      billingModel: 'promotional_term',
      periodMonths: 3,
      exp: null,
      expiresAt: null,
      activatedInstanceId: 'srv-camp-01',
    });
    assert.equal(
      verifyYunpanelEntitlementToken(promoNoExp, {
        trustedKeys,
        expectedDomain: 'panel.ornek.test',
        expectedInstanceId: 'srv-camp-01',
        now: nowMs,
      }).reason,
      'MISSING_EXPIRATION_FOR_TERM_LICENSE',
    );

    // Unknown billing model still rejected
    const unknownModel = signCampaignOrLicenseToken(keys.privateKey, keys.kid, {
      nowSec,
      billingModel: 'unsupported_model',
      periodMonths: 3,
      activatedInstanceId: 'srv-camp-01',
    });
    assert.equal(
      verifyYunpanelEntitlementToken(unknownModel, {
        trustedKeys,
        expectedDomain: 'panel.ornek.test',
        expectedInstanceId: 'srv-camp-01',
        now: nowMs,
      }).reason,
      'INVALID_BILLING_MODEL',
    );

    // Real Website Commerce server managing a single campaign grant carrying YunPanel + YunCMS
    const receivedActivateBodies = [];
    commerceServer = await listenHttpServer(async (req, res) => {
      const body = await readRequestJson(req);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/commerce/v1/entitlements/activate') {
        receivedActivateBodies.push(body);
        if (body.licenseKey === 'YUN-CAMP-3M-SHARED') {
          const token = signCampaignOrLicenseToken(keys.privateKey, keys.kid, {
            nowSec,
            sub: 'camp_shared_001',
            licenseId: 'camp_shared_001',
            productCode: body.productCode,
            billingModel: 'promotional_term',
            periodMonths: 3,
            campaignCode: 'NEWSLETTER-3M-2026',
            domain: body.domain,
            activatedInstanceId: body.instanceId,
          });
          res.writeHead(200);
          res.end(JSON.stringify({ data: { activated: true, entitlementToken: token } }));
          return;
        }
        if (body.licenseKey === 'YUN-PAID-YEARLY-001') {
          const token = signCampaignOrLicenseToken(keys.privateKey, keys.kid, {
            nowSec,
            sub: 'lic_paid_yearly_001',
            licenseId: 'lic_paid_yearly_001',
            productCode: body.productCode,
            billingModel: 'monthly_term',
            periodMonths: 12,
            durationSeconds: 365 * 86400,
            domain: body.domain,
            activatedInstanceId: body.instanceId,
          });
          res.writeHead(200);
          res.end(JSON.stringify({ data: { activated: true, entitlementToken: token } }));
          return;
        }
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: { code: 'LICENSE_NOT_FOUND', message: 'License key not found.' } }));
    });

    const storePath = path.join(tmpDir, 'license', 'entitlement.json');
    const svc = createLicenseEntitlementService({
      filePath: storePath,
      publicKeyPem: keys.publicKeyPem,
      publicKeyFile: '',
      commerceBaseUrl: `${commerceServer.baseUrl}/api/commerce`,
      publicOrigin: 'https://panel.ornek.test',
      instanceId: 'srv-camp-01',
      masterKey: crypto.randomBytes(32).toString('hex'),
      development: true,
      now: () => nowMs,
    });

    // Free state offers the 3-month campaign referral
    const freeStatus = svc.getStatus({ includeManagementDetails: true });
    assert.equal(freeStatus.tier, 'free');
    assert.equal(freeStatus.premiumOffer.available, true);
    assert.equal(freeStatus.premiumOffer.durationMonths, 3);
    assert.equal(freeStatus.premiumOffer.creditCardRequired, false);
    assert.equal(freeStatus.premiumOffer.offerUrl, DEFAULT_YUNSOFT_PREMIUM_OFFER_URL);
    assert.equal(freeStatus.docsUrl, DEFAULT_YUNSOFT_DOCS_URL);

    // YunCMS token from the same campaign is strictly rejected by YunPanel
    const yuncmsCampaignToken = signCampaignOrLicenseToken(keys.privateKey, keys.kid, {
      nowSec,
      sub: 'camp_shared_001',
      productCode: 'yuncms_premium',
      billingModel: 'promotional_term',
      periodMonths: 3,
      campaignCode: 'NEWSLETTER-3M-2026',
      domain: 'panel.ornek.test',
      activatedInstanceId: 'srv-camp-01',
    });
    await assert.rejects(
      () => svc.activate({ token: yuncmsCampaignToken }),
      (err) => err instanceof LicenseEntitlementError
        && err.code === 'license_product_mismatch'
        && err.reason === 'PRODUCT_MISMATCH',
    );

    // Shared campaign key activates ONLY yunpanel_premium for this verified installation
    const promoStatus = await svc.activate({ licenseKey: 'YUN-CAMP-3M-SHARED' });
    assert.equal(receivedActivateBodies[0].productCode, YUNPANEL_PRODUCT_CODE);
    assert.equal(receivedActivateBodies[0].domain, 'panel.ornek.test');
    assert.equal(receivedActivateBodies[0].instanceId, 'srv-camp-01');
    assert.equal(promoStatus.valid, true);
    assert.equal(promoStatus.tier, 'premium');
    assert.equal(promoStatus.grantKind, 'promotional');
    assert.equal(promoStatus.isPromotional, true);
    assert.equal(promoStatus.isPermanent, false);
    assert.equal(promoStatus.billingPeriod, 'promotional');
    assert.equal(promoStatus.periodMonths, 3);
    assert.equal(promoStatus.campaignCode, 'NEWSLETTER-3M-2026');
    assert.equal(svc.hasCapability('aiOperations'), true);
    assert.equal(svc.hasCapability('resellerAccounts'), true);
    assert.equal(svc.hasCapability('perSiteIsolatedUsers'), true);

    // Ensure zero subscriber email list is persisted in entitlement.json
    const rawStore = readFileSync(storePath, 'utf8');
    assert.equal(rawStore.includes('@'), false, 'License store must never persist subscriber emails');

    // Upgrading from 3-month promotional campaign to Paid Yearly succeeds and hides promotional offer
    const paidStatus = await svc.activate({ licenseKey: 'YUN-PAID-YEARLY-001' });
    assert.equal(paidStatus.valid, true);
    assert.equal(paidStatus.grantKind, 'paid');
    assert.equal(paidStatus.billingPeriod, 'yearly');
    assert.equal(paidStatus.periodMonths, 12);
    assert.equal(paidStatus.premiumOffer.available, false);

    // Attempting to overwrite active Paid Yearly with a 3-month promotional campaign (key OR token OR refresh) is REJECTED!
    await assert.rejects(
      () => svc.activate({ licenseKey: 'YUN-CAMP-3M-SHARED' }),
      (err) => err instanceof LicenseEntitlementError
        && err.code === 'paid_or_permanent_entitlement_protected'
        && err.reason === 'PAID_ENTITLEMENT_PROTECTED'
        && err.status === 409,
    );
    const anotherPromoToken = signCampaignOrLicenseToken(keys.privateKey, keys.kid, {
      nowSec,
      sub: 'camp_second_999',
      licenseId: 'camp_second_999',
      billingModel: 'promotional_term',
      periodMonths: 3,
      campaignCode: 'NEWSLETTER-3M-2026',
      domain: 'panel.ornek.test',
      activatedInstanceId: 'srv-camp-01',
    });
    await assert.rejects(
      () => svc.activate({ token: anotherPromoToken }),
      (err) => err instanceof LicenseEntitlementError
        && err.code === 'paid_or_permanent_entitlement_protected'
        && err.reason === 'PAID_ENTITLEMENT_PROTECTED'
        && err.status === 409,
    );
    await assert.rejects(
      () => svc.refresh({ token: anotherPromoToken }),
      (err) => err instanceof LicenseEntitlementError
        && err.code === 'paid_or_permanent_entitlement_protected'
        && err.reason === 'PAID_ENTITLEMENT_PROTECTED'
        && err.status === 409,
    );
    // Paid Yearly remains completely intact
    assert.equal(svc.getStatus({ includeManagementDetails: true }).licenseId, 'lic_paid_yearly_001');
    assert.equal(svc.getStatus().periodMonths, 12);

    // Upgrading from Paid Yearly to Permanent succeeds
    const permanentToken = signCampaignOrLicenseToken(keys.privateKey, keys.kid, {
      nowSec,
      sub: 'lic_permanent_001',
      licenseId: 'lic_permanent_001',
      billingModel: 'permanent',
      periodMonths: null,
      exp: null,
      expiresAt: null,
      domain: 'panel.ornek.test',
      activatedInstanceId: 'srv-camp-01',
    });
    const permStatus = await svc.activate({ token: permanentToken });
    assert.equal(permStatus.valid, true);
    assert.equal(permStatus.tier, 'premium');
    assert.equal(permStatus.grantKind, 'permanent');
    assert.equal(permStatus.isPermanent, true);
    assert.equal(permStatus.billingPeriod, 'permanent');
    assert.equal(permStatus.expiresAt, null);
    assert.equal(permStatus.daysRemaining, null);
    assert.equal(permStatus.renewalRequired, false);
    assert.equal(permStatus.premiumOffer.available, false);

    // Attempting to overwrite active Permanent with EITHER promotional OR paid term token is REJECTED!
    await assert.rejects(
      () => svc.activate({ token: anotherPromoToken }),
      (err) => err instanceof LicenseEntitlementError
        && err.code === 'paid_or_permanent_entitlement_protected'
        && err.reason === 'PERMANENT_ENTITLEMENT_PROTECTED'
        && err.status === 409,
    );
    await assert.rejects(
      () => svc.activate({ licenseKey: 'YUN-PAID-YEARLY-001' }),
      (err) => err instanceof LicenseEntitlementError
        && err.code === 'paid_or_permanent_entitlement_protected'
        && err.reason === 'PERMANENT_ENTITLEMENT_PROTECTED'
        && err.status === 409,
    );
    assert.equal(svc.getStatus({ includeManagementDetails: true }).licenseId, 'lic_permanent_001');
    assert.equal(svc.getStatus().isPermanent, true);
  } finally {
    if (commerceServer) await commerceServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('first-time setup HTTP session exposes sanitized setupOffer without storing subscriber list or leaking PII', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-setup-offer-http-'));
  let apiServer = null;
  let authStore = null;
  try {
    const origin = 'http://127.0.0.1:4321';
    const authDbPath = path.join(tmpDir, 'auth.sqlite');
    authStore = createAuthStore({
      filePath: authDbPath,
      masterKey: crypto.randomBytes(32).toString('hex'),
    });
    const serverRegistry = createServerRegistry({ filePath: path.join(tmpDir, 'servers.json') });
    const localServer = await serverRegistry.createLocalServer({
      hostname: 'panel.ornek.test',
      displayName: 'Local Setup Host',
    });
    const keys = generateTestEd25519KeyPair();
    const licenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicKeyPem: keys.publicKeyPem,
      publicKeyFile: '',
      publicOrigin: origin,
      instanceId: localServer.id,
      development: true,
      // Attempt misconfigured URL with PII query param -> must sanitize back to safe static default!
      offerUrl: 'https://yunsoft.com/kampanya/premium-3-ay?email=secret@ornek.test',
      docsUrl: 'https://yunsoft.com/docs/yunpanel',
    });

    const listener = createAuthenticatedApi({
      store: authStore,
      publicOrigin: origin,
      development: true,
      ownerMfaRequired: false,
      licenseEntitlementService: licenseService,
      setupOfferUrl: 'https://yunsoft.com/kampanya/premium-3-ay?domain=panel.ornek.test',
      docsUrl: 'https://yunsoft.com/docs/yunpanel',
      createHandler: () => createApp({
        registry: serverRegistry,
        localServerId: localServer.id,
        userAdminStore: authStore.users,
        authStore,
        licenseEntitlementService: licenseService,
      }),
    });

    apiServer = await listenHttpServer(listener);

    // 1. Before setup: /api/auth/session returns 401 + setupRequired: true + sanitized static setupOffer
    const beforeRes = await fetch(`${apiServer.baseUrl}/api/auth/session`);
    assert.equal(beforeRes.status, 401);
    const beforeBody = await beforeRes.json();
    assert.equal(beforeBody.setupRequired, true);
    assert.equal(beforeBody.setupOffer.enabled, true);
    assert.equal(beforeBody.setupOffer.durationMonths, 3);
    assert.equal(beforeBody.setupOffer.creditCardRequired, false);
    assert.equal(beforeBody.setupOffer.managedBy, 'yunsoft-website');
    assert.equal(beforeBody.setupOffer.offerUrl, DEFAULT_YUNSOFT_PREMIUM_OFFER_URL);
    assert.equal(beforeBody.setupOffer.docsUrl, DEFAULT_YUNSOFT_DOCS_URL);
    assert.equal(JSON.stringify(beforeBody).includes('panel.ornek.test'), false);
    assert.equal(JSON.stringify(beforeBody).includes('@'), false);

    // 2. Complete setup via real POST /api/auth/setup (optional recovery email only; no newsletter list stored)
    const { token: setupToken } = authStore.issueSetupToken();
    const setupRes = await fetch(`${apiServer.baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupToken,
        username: 'kurulumowner',
        password: 'StrongSetupOwnerPassword!2026',
        email: 'kurtarma@ornek.test',
      }),
    });
    assert.equal(setupRes.status, 201);

    // 3. After setup: /api/auth/session returns setupRequired: false and omits setupOffer
    const afterRes = await fetch(`${apiServer.baseUrl}/api/auth/session`);
    assert.equal(afterRes.status, 401);
    const afterBody = await afterRes.json();
    assert.equal(afterBody.setupRequired, false);
    assert.equal(afterBody.setupOffer, undefined);

    // 4. Verify SQLite schema has zero newsletter/campaign/subscriber tables
    const inspectDb = new DatabaseSync(authDbPath, { readOnly: true });
    try {
      const tables = inspectDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      for (const name of tables) {
        assert.doesNotMatch(name, /newsletter|subscriber|campaign|marketing/i);
      }
    } finally {
      inspectDb.close();
    }

    // 5. Sign in as Owner and verify /api/panel/license includes sanitized offer & docs URLs
    const loginRes = await fetch(`${apiServer.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'kurulumowner',
        password: 'StrongSetupOwnerPassword!2026',
      }),
    });
    assert.equal(loginRes.status, 200);
    const sessionCookie = loginRes.headers
      .getSetCookie()
      .map((item) => item.split(';')[0])
      .find((item) => item.includes('yunpanel_session='));
    const rawToken = sessionCookie.slice(sessionCookie.indexOf('=') + 1);
    const csrf = csrfForSession(rawToken);

    const licRes = await fetch(`${apiServer.baseUrl}/api/panel/license`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(licRes.status, 200);
    const licBody = await licRes.json();
    assert.equal(licBody.data.premiumOffer.available, true);
    assert.equal(licBody.data.premiumOffer.offerUrl, DEFAULT_YUNSOFT_PREMIUM_OFFER_URL);
    assert.equal(licBody.data.docsUrl, DEFAULT_YUNSOFT_DOCS_URL);
    assert.equal(licBody.data.premiumOffer.offerUrl.includes('secret@ornek.test'), false);

    // Non-owner or invalid CSRF activation remains blocked
    const badCsrf = await fetch(`${apiServer.baseUrl}/api/panel/license/activate`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'invalid' }),
    });
    assert.equal(badCsrf.status, 403);
    assert.ok(csrf.length > 0);
  } finally {
    if (apiServer) await apiServer.close();
    if (authStore) authStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
