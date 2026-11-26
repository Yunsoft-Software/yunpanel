import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/http/app.js';
import { createApplicationRegistry } from '../src/applications/application-registry.js';
import { createAiConversationService } from '../src/ai/ai-conversation-service.js';
import { createAiMcpAdapter } from '../src/ai/ai-mcp-adapter.js';
import { createAiProviderRegistry } from '../src/ai/ai-provider-registry.js';
import { createAiToolRegistry } from '../src/ai/ai-tool-registry.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai/ai-tool-catalog.js';
import { createApiKeyStore } from '../src/auth/api-key-store.js';
import { createAuthenticatedApi } from '../src/auth/auth-http.js';
import { createAuthStore, csrfForSession } from '../src/auth/auth-store.js';
import { createAutomationHandler } from '../src/http/automation-http.js';
import { createDnsHostingRegistry } from '../src/dns/dns-hosting-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker/docker-workload-registry.js';
import { createDomainRegistry } from '../src/domains/domain-registry.js';
import {
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  parseTrustedPublicKeys,
  YUNPANEL_PRODUCT_CODE,
  verifyYunpanelEntitlementToken,
} from '../src/panel/license-entitlement-verifier.js';
import {
  createLicenseEntitlementService,
  DEFAULT_SYSTEM_ENTITLEMENT_PUBLIC_KEY_FILE,
  defaultVendorEntitlementPublicKeyFile,
  LicenseEntitlementError,
  maskLicenseKey,
  VENDOR_ENTITLEMENT_PUBLIC_KEY_KID,
} from '../src/panel/license-entitlement-service.js';
import { createMailDomainRegistry } from '../src/mail/mail-domain-registry.js';
import { createServerRegistry } from '../src/runtime/server-registry.js';
import { createTenantSiteStore } from '../src/hosting/tenant-site-store.js';
import { createTerminalCapabilityRegistry } from '../src/terminal/terminal-capability-registry.js';
import { createWebsiteProvisioningRuntime } from '../src/provisioning/website-provisioning-runtime.js';
import { createWebsiteRegistry } from '../src/websites/website-registry.js';

const SERVICE_MODULE_URL = new URL('../src/panel/license-entitlement-service.js', import.meta.url).href;

function generateTestEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const kid = computePublicKeyId(spkiDer);
  return { publicKey, privateKey, publicKeyPem, privateKeyPem, kid };
}

function signTestEntitlementToken(privateKey, kid, overrides = {}) {
  const nowSec = overrides.nowSec ?? Math.floor(Date.now() / 1000);
  const periodMonths = overrides.periodMonths === undefined ? 1 : overrides.periodMonths;
  const durationSeconds = overrides.durationSeconds ?? (periodMonths === 12 ? 365 * 86400 : 30 * 86400);
  const exp = overrides.exp === undefined ? nowSec + durationSeconds : overrides.exp;
  const startsAtIso = overrides.startsAt ?? new Date((overrides.nbf ?? nowSec) * 1000).toISOString();
  const expiresAtIso = overrides.expiresAt === undefined
    ? (exp !== null ? new Date(exp * 1000).toISOString() : null)
    : overrides.expiresAt;
  const domain = overrides.domain ?? 'panel.example.test';

  const header = {
    alg: 'EdDSA',
    crv: 'Ed25519',
    typ: ENTITLEMENT_TOKEN_TYPE,
    kid,
    ...(overrides.headerOverrides ?? {}),
  };

  const payload = {
    iss: ENTITLEMENT_ISSUER,
    sub: overrides.sub ?? 'lic_yunpanel_001',
    licenseId: overrides.licenseId ?? overrides.sub ?? 'lic_yunpanel_001',
    jti: overrides.jti ?? crypto.randomUUID(),
    iat: overrides.iat ?? nowSec,
    nbf: overrides.nbf ?? nowSec,
    exp,
    productCode: overrides.productCode ?? YUNPANEL_PRODUCT_CODE,
    billingModel: overrides.billingModel ?? 'monthly_term',
    periodMonths,
    status: overrides.status ?? 'active',
    domain,
    normalizedDomain: domain,
    allowedHosts: overrides.allowedHosts ?? [domain, `www.${domain}`],
    stagingHosts: overrides.stagingHosts ?? [`staging.${domain}`, `dev.${domain}`, 'localhost', '127.0.0.1'],
    startsAt: startsAtIso,
    expiresAt: expiresAtIso,
    entitlementVersion: overrides.entitlementVersion ?? 1,
    activatedInstanceId: overrides.activatedInstanceId ?? null,
    edition: overrides.edition ?? 'premium',
    capabilities: overrides.capabilities ?? {
      singlePanelUser: true,
      singlePanelUserUnlimitedSites: true,
      webStackManagement: true,
      sslAndDnsManagement: true,
      backupsAndMonitoring: true,
      aiOperations: true,
      resellerAccounts: true,
      perSiteIsolatedUsers: true,
    },
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
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

test('independent FS/crypto review regressions: live multi-instance reload, anti-rollback, and deactivation visibility', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-lic-review-'));
  try {
    const statePath = path.join(tmpDir, 'state.json');
    const keys = generateTestEd25519KeyPair();
    const sharedConfig = {
      filePath: statePath,
      publicKeyPem: keys.publicKeyPem,
      publicKeyFile: '',
      publicOrigin: 'https://panel.example.test',
      instanceId: 'srv-review-01',
      development: false,
    };

    const a = createLicenseEntitlementService(sharedConfig);
    const b = createLicenseEntitlementService(sharedConfig);

    // 1. Activate v2 (30 days) on `a` -> `b` immediately observes Premium without restart
    const tokenV2 = signTestEntitlementToken(keys.privateKey, keys.kid, {
      sub: 'lic_shared_review',
      licenseId: 'lic_shared_review',
      entitlementVersion: 2,
      durationSeconds: 30 * 86400,
      activatedInstanceId: 'srv-review-01',
    });
    const activated = await a.activate({ token: tokenV2 });
    assert.equal(activated.tier, 'premium');
    assert.equal(activated.entitlementVersion, 2);
    assert.equal(a.getStatus().tier, 'premium');
    assert.equal(b.getStatus().tier, 'premium');
    assert.equal(b.hasCapability('aiOperations'), true);
    assert.equal(b.getStatus({ includeManagementDetails: true }).entitlementVersion, 2);

    // 2. Third instance `c` replays superseded v1 (10 days) for same licenseId -> rejected, v2 preserved
    const c = createLicenseEntitlementService(sharedConfig);
    const tokenV1 = signTestEntitlementToken(keys.privateKey, keys.kid, {
      sub: 'lic_shared_review',
      licenseId: 'lic_shared_review',
      entitlementVersion: 1,
      durationSeconds: 10 * 86400,
      activatedInstanceId: 'srv-review-01',
    });
    await assert.rejects(
      () => c.activate({ token: tokenV1 }),
      (err) => err instanceof LicenseEntitlementError
        && err.code === 'stale_license_token'
        && err.reason === 'SUPERSEDED_ENTITLEMENT_VERSION'
        && err.status === 409,
    );
    assert.equal(a.getStatus({ includeManagementDetails: true }).entitlementVersion, 2);
    assert.equal(b.getStatus({ includeManagementDetails: true }).entitlementVersion, 2);
    assert.equal(c.getStatus({ includeManagementDetails: true }).entitlementVersion, 2);

    // Same-version shorter-expiry rollback attempt is also rejected
    const tokenV2Shorter = signTestEntitlementToken(keys.privateKey, keys.kid, {
      sub: 'lic_shared_review',
      licenseId: 'lic_shared_review',
      entitlementVersion: 2,
      durationSeconds: 5 * 86400,
      activatedInstanceId: 'srv-review-01',
    });
    await assert.rejects(
      () => c.activate({ token: tokenV2Shorter }),
      (err) => err instanceof LicenseEntitlementError
        && err.code === 'stale_license_token'
        && err.reason === 'SUPERSEDED_ENTITLEMENT_TOKEN',
    );

    // 3. `c.deactivate` -> `a` and `b` immediately observe Free tier, and v1 replay remains blocked
    await c.deactivate({ notifyRemote: false });
    assert.equal(a.getStatus().tier, 'free');
    assert.equal(b.getStatus().tier, 'free');
    assert.equal(a.hasCapability('aiOperations'), false);
    assert.equal(b.hasCapability('resellerAccounts'), false);

    await assert.rejects(
      () => a.activate({ token: tokenV1 }),
      (err) => err instanceof LicenseEntitlementError
        && err.code === 'stale_license_token'
        && err.reason === 'SUPERSEDED_ENTITLEMENT_VERSION',
    );

    // Upgrading to v3 (yearly 12 months) succeeds and propagates across all instances
    const tokenV3Yearly = signTestEntitlementToken(keys.privateKey, keys.kid, {
      sub: 'lic_shared_review',
      licenseId: 'lic_shared_review',
      entitlementVersion: 3,
      periodMonths: 12,
      durationSeconds: 365 * 86400,
      activatedInstanceId: 'srv-review-01',
    });
    await b.activate({ token: tokenV3Yearly });
    assert.equal(a.getStatus().tier, 'premium');
    assert.equal(a.getStatus().periodMonths, 12);
    assert.equal(c.getStatus({ includeManagementDetails: true }).entitlementVersion, 3);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cross-process locking and standalone MCP process synchronization prevent lost updates and stale replays', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-lic-multiprocess-'));
  try {
    const statePath = path.join(tmpDir, 'entitlement.json');
    const pubKeyPath = path.join(tmpDir, 'entitlement-public.pem');
    const keys = generateTestEd25519KeyPair();
    writeFileSync(pubKeyPath, keys.publicKeyPem, { mode: 0o600 });

    const tokenV1 = signTestEntitlementToken(keys.privateKey, keys.kid, {
      sub: 'lic_mp_01',
      licenseId: 'lic_mp_01',
      entitlementVersion: 1,
      durationSeconds: 15 * 86400,
      activatedInstanceId: 'srv-mp-01',
    });
    const tokenV3 = signTestEntitlementToken(keys.privateKey, keys.kid, {
      sub: 'lic_mp_01',
      licenseId: 'lic_mp_01',
      entitlementVersion: 3,
      periodMonths: 12,
      durationSeconds: 365 * 86400,
      activatedInstanceId: 'srv-mp-01',
    });

    const workerScript = `
      import { createLicenseEntitlementService } from ${JSON.stringify(SERVICE_MODULE_URL)};
      const svc = createLicenseEntitlementService({
        filePath: process.env.TEST_LIC_FILE,
        publicKeyFile: process.env.TEST_PUB_FILE,
        publicOrigin: 'https://panel.example.test',
        instanceId: 'srv-mp-01',
        development: false,
      });
      try {
        const res = await svc.activate({ token: process.env.TEST_TOKEN });
        process.stdout.write(JSON.stringify({ ok: true, version: res.entitlementVersion }));
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, code: err.code, reason: err.reason }));
      }
    `;

    const runWorker = (token) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
        env: {
          ...process.env,
          TEST_LIC_FILE: statePath,
          TEST_PUB_FILE: pubKeyPath,
          TEST_TOKEN: token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`Worker exited ${code}: ${stderr}`));
        resolve(JSON.parse(stdout));
      });
    });

    // Launch two real OS processes concurrently against the same license store file
    const [res1, res3] = await Promise.all([runWorker(tokenV1), runWorker(tokenV3)]);
    assert.equal(res3.ok, true);
    assert.equal(res3.version, 3);
    // If v3 committed first, v1 was rejected as stale; if v1 committed first, v3 upgraded it to 3.
    if (!res1.ok) {
      assert.equal(res1.code, 'stale_license_token');
    }

    const observer = createLicenseEntitlementService({
      filePath: statePath,
      publicKeyFile: pubKeyPath,
      publicOrigin: 'https://panel.example.test',
      instanceId: 'srv-mp-01',
      development: false,
    });
    const finalStatus = observer.getStatus({ includeManagementDetails: true });
    assert.equal(finalStatus.valid, true);
    assert.equal(finalStatus.tier, 'premium');
    assert.equal(finalStatus.entitlementVersion, 3);
    assert.equal(finalStatus.periodMonths, 12);

    // Standalone MCP server using its own service instance observes live activation and deactivation
    const mcpService = createLicenseEntitlementService({
      filePath: statePath,
      publicKeyFile: pubKeyPath,
      publicOrigin: 'https://panel.example.test',
      instanceId: 'srv-mp-01',
      development: false,
    });
    const mcpAdapter = createAiMcpAdapter({
      registry: createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS }),
      licenseEntitlementService: mcpService,
    });
    const ownerAuth = {
      user: { id: 'owner-1', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    const toolsWhileActive = await mcpAdapter.listTools({ auth: ownerAuth });
    assert.ok(toolsWhileActive.length > 0);

    await observer.deactivate({ notifyRemote: false });
    await assert.rejects(
      () => mcpAdapter.listTools({ auth: ownerAuth }),
      (err) => err.code === 'forbidden' && err.data?.code === 'premium_license_required',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cryptographic contract verification, rejection matrix, and safe Free fallback on corrupt state or key errors', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-lic-crypto-'));
  try {
    const keys = generateTestEd25519KeyPair();
    const attackerKeys = generateTestEd25519KeyPair();
    const baseTimeMs = Date.parse('2026-11-15T00:00:00.000Z');
    const baseTimeSec = Math.floor(baseTimeMs / 1000);

    // Private key in configuration is strictly forbidden
    assert.throws(
      () => createLicenseEntitlementService({
        filePath: ':memory:',
        publicKeyPem: keys.privateKeyPem,
        publicKeyFile: '',
      }),
      (err) => err.code === 'license_private_key_forbidden',
    );

    // Corrupt JSON store and corrupt public key file safely preserve Free baseline without crashing reads
    const corruptStorePath = path.join(tmpDir, 'corrupt-store.json');
    const badPemPath = path.join(tmpDir, 'bad-public.pem');
    writeFileSync(corruptStorePath, '{not-valid-json', { mode: 0o600 });
    writeFileSync(badPemPath, '-----BEGIN PUBLIC KEY-----\nNOT_VALID_BASE64\n-----END PUBLIC KEY-----\n', { mode: 0o600 });

    const resilientSvc = createLicenseEntitlementService({
      filePath: corruptStorePath,
      publicKeyPem: '',
      publicKeyFile: badPemPath,
      publicOrigin: 'https://panel.example.test',
      development: false,
    });
    const degraded = resilientSvc.getStatus({ includeManagementDetails: true });
    assert.equal(degraded.valid, false);
    assert.equal(degraded.tier, 'free');
    assert.equal(degraded.capabilities.singlePanelUserUnlimitedSites, true);
    assert.equal(degraded.capabilities.aiOperations, false);
    assert.equal(resilientSvc.hasCapability('singlePanelUserUnlimitedSites'), true);
    assert.equal(resilientSvc.hasCapability('aiOperations'), false);

    // Repair key file; test unreadable permissions on non-root user
    writeFileSync(badPemPath, keys.publicKeyPem, { mode: 0o600 });
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      chmodSync(badPemPath, 0o000);
      try {
        const unreadableStatus = resilientSvc.getStatus({ includeManagementDetails: true });
        assert.equal(unreadableStatus.valid, false);
        assert.equal(unreadableStatus.tier, 'free');
      } finally {
        chmodSync(badPemPath, 0o600);
      }
    }

    // Valid monthly (1) and yearly (12) tokens
    const validMonthly = signTestEntitlementToken(keys.privateKey, keys.kid, {
      nowSec: baseTimeSec,
      periodMonths: 1,
      domain: 'panel.example.test',
      activatedInstanceId: 'inst-1',
    });
    const validYearly = signTestEntitlementToken(keys.privateKey, keys.kid, {
      nowSec: baseTimeSec,
      periodMonths: 12,
      entitlementVersion: 2,
      domain: 'panel.example.test',
      activatedInstanceId: 'inst-1',
    });

    const trustedMap = new Map([[keys.kid, { keyId: keys.kid, publicKey: keys.publicKey }]]);
    const vMonthly = verifyYunpanelEntitlementToken(validMonthly, {
      trustedKeys: trustedMap,
      expectedDomain: 'panel.example.test',
      expectedInstanceId: 'inst-1',
      now: baseTimeMs + 1000,
    });
    assert.equal(vMonthly.valid, true);
    assert.equal(vMonthly.billingPeriod, 'monthly');
    assert.equal(vMonthly.periodMonths, 1);

    const vYearly = verifyYunpanelEntitlementToken(validYearly, {
      trustedKeys: trustedMap,
      expectedDomain: 'www.panel.example.test',
      expectedInstanceId: 'inst-1',
      now: baseTimeMs + 1000,
    });
    assert.equal(vYearly.valid, true);
    assert.equal(vYearly.billingPeriod, 'yearly');
    assert.equal(vYearly.periodMonths, 12);

    // Same-site api.<domain> is NOT allowed for YunPanel (includeSameSiteApi: false)
    const vApiSub = verifyYunpanelEntitlementToken(validMonthly, {
      trustedKeys: trustedMap,
      expectedDomain: 'api.panel.example.test',
      expectedInstanceId: 'inst-1',
      now: baseTimeMs + 1000,
    });
    assert.equal(vApiSub.valid, false);
    assert.equal(vApiSub.reason, 'DOMAIN_MISMATCH');

    // Non-canonical base64url segment rejected
    const [h, p, s] = validMonthly.split('.');
    assert.equal(
      verifyYunpanelEntitlementToken(`${h}=.${p}.${s}`, { trustedKeys: trustedMap, now: baseTimeMs }).reason,
      'MALFORMED_TOKEN',
    );

    // Tampered payload rejected
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), periodMonths: 12 }),
      'utf8',
    ).toString('base64url');
    assert.equal(
      verifyYunpanelEntitlementToken(`${h}.${tamperedPayload}.${s}`, { trustedKeys: trustedMap, now: baseTimeMs }).reason,
      'INVALID_SIGNATURE',
    );

    // Wrong signing key / wrong kid rejected
    const attackerSignedSameKid = signTestEntitlementToken(attackerKeys.privateKey, keys.kid, { nowSec: baseTimeSec });
    assert.equal(
      verifyYunpanelEntitlementToken(attackerSignedSameKid, { trustedKeys: trustedMap, now: baseTimeMs }).reason,
      'INVALID_SIGNATURE',
    );
    const unknownKidToken = signTestEntitlementToken(attackerKeys.privateKey, attackerKeys.kid, { nowSec: baseTimeSec });
    assert.equal(
      verifyYunpanelEntitlementToken(unknownKidToken, { trustedKeys: trustedMap, now: baseTimeMs }).reason,
      'KEY_ID_MISMATCH',
    );

    // Wrong product (YunCMS) rejected with PRODUCT_MISMATCH
    const yuncmsToken = signTestEntitlementToken(keys.privateKey, keys.kid, {
      nowSec: baseTimeSec,
      productCode: 'yuncms_premium',
    });
    assert.equal(
      verifyYunpanelEntitlementToken(yuncmsToken, { trustedKeys: trustedMap, now: baseTimeMs }).reason,
      'PRODUCT_MISMATCH',
    );

    // Wrong issuer, wrong instance, future nbf, future iat, expired exp, revoked/refunded/suspended
    const badIssuer = signTestEntitlementToken(keys.privateKey, keys.kid, {
      nowSec: baseTimeSec,
      payloadOverrides: { iss: 'other-issuer' },
    });
    assert.equal(verifyYunpanelEntitlementToken(badIssuer, { trustedKeys: trustedMap, now: baseTimeMs }).reason, 'INVALID_ISSUER');

    assert.equal(
      verifyYunpanelEntitlementToken(validMonthly, {
        trustedKeys: trustedMap,
        expectedDomain: 'panel.example.test',
        expectedInstanceId: 'inst-other',
        now: baseTimeMs,
      }).reason,
      'INSTANCE_MISMATCH',
    );

    const futureNbf = signTestEntitlementToken(keys.privateKey, keys.kid, {
      nowSec: baseTimeSec,
      nbf: baseTimeSec + 3600,
    });
    assert.equal(verifyYunpanelEntitlementToken(futureNbf, { trustedKeys: trustedMap, now: baseTimeMs }).reason, 'TOKEN_NOT_YET_VALID');

    const futureIat = signTestEntitlementToken(keys.privateKey, keys.kid, {
      nowSec: baseTimeSec,
      iat: baseTimeSec + 120,
    });
    assert.equal(verifyYunpanelEntitlementToken(futureIat, { trustedKeys: trustedMap, now: baseTimeMs }).reason, 'INVALID_IAT');

    assert.equal(
      verifyYunpanelEntitlementToken(validMonthly, {
        trustedKeys: trustedMap,
        expectedDomain: 'panel.example.test',
        expectedInstanceId: 'inst-1',
        now: baseTimeMs + 31 * 86400 * 1000,
      }).reason,
      'LICENSE_EXPIRED',
    );

    for (const [status, expectedReason] of [
      ['revoked', 'LICENSE_REVOKED'],
      ['refunded', 'LICENSE_REFUNDED'],
      ['suspended', 'LICENSE_SUSPENDED'],
    ]) {
      const inactiveToken = signTestEntitlementToken(keys.privateKey, keys.kid, {
        nowSec: baseTimeSec,
        status,
      });
      const check = verifyYunpanelEntitlementToken(inactiveToken, { trustedKeys: trustedMap, now: baseTimeMs });
      assert.equal(check.valid, false);
      assert.equal(check.status, status);
      assert.equal(check.reason, expectedReason);
      assert.equal(check.capabilities.aiOperations, false);
    }

    // Forbidden .44 host and non-HTTPS remote URL guards
    const dot44Svc = createLicenseEntitlementService({
      filePath: ':memory:',
      publicKeyPem: keys.publicKeyPem,
      publicKeyFile: '',
      commerceBaseUrl: 'https://192.0.2.44/api/commerce',
      publicOrigin: 'https://panel.example.test',
      development: false,
    });
    await assert.rejects(
      () => dot44Svc.activate({ licenseKey: 'YUN-TEST-1234-5678' }),
      (err) => err.code === 'forbidden_host_dot44' && err.status === 403,
    );

    const httpRemoteSvc = createLicenseEntitlementService({
      filePath: ':memory:',
      publicKeyPem: keys.publicKeyPem,
      publicKeyFile: '',
      commerceBaseUrl: 'http://yunsoft.example.test/api/commerce',
      publicOrigin: 'https://panel.example.test',
      development: false,
    });
    await assert.rejects(
      () => httpRemoteSvc.activate({ licenseKey: 'YUN-TEST-1234-5678' }),
      (err) => err.code === 'insecure_commerce_url' && err.status === 400,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('real Commerce exchange, offline zero-remote verification, encrypted key persistence, renewal, and outage resilience', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-lic-exchange-'));
  let commerceServer = null;
  try {
    const keys = generateTestEd25519KeyPair();
    const untrustedKeys = generateTestEd25519KeyPair();
    let currentNowMs = Date.parse('2026-11-15T10:00:00.000Z');
    const remoteRequests = [];
    let commerceMode = 'monthly_v1';

    commerceServer = await listenHttpServer(async (req, res) => {
      const body = await readRequestJson(req);
      remoteRequests.push({ method: req.method, url: req.url, body });
      res.setHeader('content-type', 'application/json');

      if (commerceMode === 'outage_503') {
        res.writeHead(503);
        res.end(JSON.stringify({ error: { code: 'TEMPORARY_OUTAGE', message: 'Upstream maintenance' } }));
        return;
      }

      if (req.url === '/api/commerce/v1/entitlements/activate') {
        if (body.licenseKey === 'YUN-UNTRUSTED-RESP-KEY') {
          const fakeSigned = signTestEntitlementToken(untrustedKeys.privateKey, untrustedKeys.kid, {
            nowSec: Math.floor(currentNowMs / 1000),
            domain: body.domain,
            activatedInstanceId: body.instanceId,
          });
          res.writeHead(200);
          // Even if remote wraps in Directus `{ data: ... }` and includes attacker's publicKey, YunPanel must reject it!
          res.end(JSON.stringify({
            data: {
              activated: true,
              entitlementToken: fakeSigned,
              publicKey: { kid: untrustedKeys.kid, publicKeyPem: untrustedKeys.publicKeyPem },
            },
          }));
          return;
        }
        if (body.licenseKey !== 'YUN-REAL-PRO-2026-ABCD') {
          res.writeHead(404);
          res.end(JSON.stringify({ error: { code: 'LICENSE_NOT_FOUND', message: 'License key not found.' } }));
          return;
        }
        const token = signTestEntitlementToken(keys.privateKey, keys.kid, {
          nowSec: Math.floor(currentNowMs / 1000),
          sub: 'lic_commerce_99',
          licenseId: 'lic_commerce_99',
          entitlementVersion: 1,
          periodMonths: 1,
          domain: body.domain,
          activatedInstanceId: body.instanceId,
        });
        res.writeHead(200);
        res.end(JSON.stringify({
          data: {
            activated: true,
            entitlementToken: token,
          },
        }));
        return;
      }

      if (req.url === '/api/commerce/v1/entitlements/verify') {
        if (commerceMode === 'yearly_v2') {
          const renewed = signTestEntitlementToken(keys.privateKey, keys.kid, {
            nowSec: Math.floor(currentNowMs / 1000),
            sub: 'lic_commerce_99',
            licenseId: 'lic_commerce_99',
            entitlementVersion: 2,
            periodMonths: 12,
            domain: body.domain,
            activatedInstanceId: body.instanceId,
          });
          res.writeHead(200);
          res.end(JSON.stringify({
            data: {
              valid: true,
              tier: 'premium',
              entitlementToken: renewed,
            },
          }));
          return;
        }
        if (commerceMode === 'revoked_v3') {
          res.writeHead(200);
          res.end(JSON.stringify({
            data: {
              valid: false,
              tier: 'free',
              reason: 'LICENSE_REVOKED',
              entitlementToken: null,
              license: { status: 'revoked' },
            },
          }));
          return;
        }
      }

      if (req.url === '/api/commerce/v1/entitlements/deactivate') {
        res.writeHead(200);
        res.end(JSON.stringify({ data: { deactivated: true } }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    const storePath = path.join(tmpDir, 'license', 'entitlement.json');
    const masterKey = crypto.randomBytes(32).toString('hex');

    const createSvc = () => createLicenseEntitlementService({
      filePath: storePath,
      publicKeyPem: keys.publicKeyPem,
      publicKeyFile: '',
      commerceBaseUrl: `${commerceServer.baseUrl}/api/commerce`,
      publicOrigin: 'http://localhost:5173',
      instanceId: 'srv-local-dev-01',
      masterKey,
      development: true,
      now: () => currentNowMs,
    });

    const svc = createSvc();

    // Reject untrusted response publicKey injection
    await assert.rejects(
      () => svc.activate({ licenseKey: 'YUN-UNTRUSTED-RESP-KEY', domain: 'panel.yunsoft.test' }),
      (err) => err.code === 'invalid_license_token' && err.reason === 'KEY_ID_MISMATCH',
    );
    assert.equal(svc.getStatus().tier, 'free');

    // Activate valid monthly license key via Commerce exchange
    const monthlyStatus = await svc.activate({
      licenseKey: 'YUN-REAL-PRO-2026-ABCD',
      domain: 'panel.yunsoft.test',
    });
    assert.equal(monthlyStatus.valid, true);
    assert.equal(monthlyStatus.tier, 'premium');
    assert.equal(monthlyStatus.billingPeriod, 'monthly');
    assert.equal(monthlyStatus.periodMonths, 1);
    assert.equal(monthlyStatus.maskedLicenseKey, maskLicenseKey('YUN-REAL-PRO-2026-ABCD'));
    assert.equal(monthlyStatus.hasStoredLicenseKey, true);

    // Raw licenseKey must be AES-256-GCM encrypted on disk, never plaintext
    const persistedRaw = readFileSync(storePath, 'utf8');
    assert.ok(!persistedRaw.includes('YUN-REAL-PRO-2026-ABCD'), 'Raw license key must not appear in plaintext on disk');
    const persistedParsed = JSON.parse(persistedRaw);
    assert.equal(persistedParsed.plainLicenseKey, null);
    assert.equal(persistedParsed.encryptedLicenseKey.alg, 'aes-256-gcm');

    // Verify 100% offline status & capability checks make ZERO remote HTTP calls
    const countAfterActivate = remoteRequests.length;
    for (let i = 0; i < 10; i++) {
      assert.equal(svc.getStatus().tier, 'premium');
      assert.equal(svc.hasCapability('aiOperations'), true);
      assert.equal(svc.hasCapability('resellerAccounts'), true);
      assert.equal(svc.hasCapability('perSiteIsolatedUsers'), true);
    }
    assert.equal(remoteRequests.length, countAfterActivate);

    // Restart simulation: new service instance reads persisted token + encrypted key offline
    const restartedSvc = createSvc();
    assert.equal(restartedSvc.getStatus().tier, 'premium');
    assert.equal(remoteRequests.length, countAfterActivate);

    // Transient remote outage on refresh preserves valid local offline token
    commerceMode = 'outage_503';
    await assert.rejects(
      () => restartedSvc.refresh(),
      (err) => err.code === 'license_exchange_unreachable' && err.status === 502,
    );
    assert.equal(restartedSvc.getStatus().tier, 'premium');

    // Renewal to yearly (12 months, entitlementVersion 2) persists cleanly
    currentNowMs += 25 * 86400 * 1000;
    commerceMode = 'yearly_v2';
    const renewedYearly = await restartedSvc.refresh();
    assert.equal(renewedYearly.valid, true);
    assert.equal(renewedYearly.billingPeriod, 'yearly');
    assert.equal(renewedYearly.periodMonths, 12);
    assert.equal(renewedYearly.entitlementVersion, 2);
    assert.ok(renewedYearly.daysRemaining >= 360);

    // Remote revocation degrades non-destructively to Free baseline
    commerceMode = 'revoked_v3';
    const revoked = await restartedSvc.refresh();
    assert.equal(revoked.valid, false);
    assert.equal(revoked.tier, 'free');
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.capabilities.aiOperations, false);
    assert.equal(revoked.capabilities.singlePanelUserUnlimitedSites, true);

    // Deactivate notifies remote and clears local secrets
    const deactivated = await restartedSvc.deactivate({ notifyRemote: true });
    assert.equal(deactivated.remoteDeactivated, true);
    assert.equal(deactivated.tier, 'free');
    assert.equal(deactivated.hasStoredLicenseKey, false);
    assert.equal(deactivated.maskedLicenseKey, null);
  } finally {
    if (commerceServer) await commerceServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full HTTP/RBAC/CSRF feature gating across Free -> Premium -> Expired while preserving sites, Unix users, certs, and recovery', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-lic-http-'));
  let apiServer = null;
  let authStore = null;
  try {
    const keys = generateTestEd25519KeyPair();
    let clockMs = Date.parse('2026-11-15T12:00:00.000Z');
    const origin = 'http://127.0.0.1:4173';

    authStore = createAuthStore({
      filePath: path.join(tmpDir, 'auth.sqlite'),
      now: () => clockMs,
      masterKey: crypto.randomBytes(32).toString('hex'),
    });
    const setup = authStore.issueSetupToken();
    const ownerUser = await authStore.completeSetup({
      setupToken: setup.token,
      username: 'panelowner',
      password: 'StrongOwnerPassword!2026',
    });
    assert.equal(ownerUser.role, 'owner');

    const serverRegistry = createServerRegistry({
      filePath: path.join(tmpDir, 'servers.json'),
    });
    const localServer = await serverRegistry.createLocalServer({
      hostname: 'panel.example.test',
      displayName: 'Local Panel Host',
    });
    const localServerId = localServer.id;

    const applicationRegistry = createApplicationRegistry({
      filePath: path.join(tmpDir, 'applications.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    });
    const dockerWorkloadRegistry = createDockerWorkloadRegistry({
      filePath: path.join(tmpDir, 'docker-workloads.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    });
    const websiteRegistry = createWebsiteRegistry({
      filePath: path.join(tmpDir, 'websites.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
      getApplication: async (id) => applicationRegistry.getApplication(id),
      getDockerWorkload: async (id) => dockerWorkloadRegistry.getWorkload(id),
    });
    const domainRegistry = createDomainRegistry({
      filePath: path.join(tmpDir, 'domains.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
      getWebsite: async (id) => websiteRegistry.getWebsite(id),
      websiteBindingRequired: () => true,
    });
    const getWebDomain = async (id) => domainRegistry.getDomain(id);
    const dnsHostingRegistry = createDnsHostingRegistry({
      filePath: path.join(tmpDir, 'dns-hosting.json'),
      getWebDomain,
    });
    const mailDomainRegistry = createMailDomainRegistry({
      filePath: path.join(tmpDir, 'mail-domains.json'),
      getWebDomain,
    });
    const checksum = 'c'.repeat(64);
    const websiteProvisioningRuntime = createWebsiteProvisioningRuntime({
      filePath: path.join(tmpDir, 'provisioning.json'),
      identityManager: {
        apply: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
        inspect: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
        compensate: async () => ({ satisfied: true }),
        inspectCompensation: async () => ({ satisfied: true }),
      },
      passengerSiteManager: {
        apply: async () => ({ satisfied: false, reason: 'unused' }),
        inspect: async () => ({ satisfied: false, reason: 'unused' }),
      },
      nginxManager: {
        stageDomain: async (spec) => ({ configName: `yunpanel-${spec.primaryDomain}.conf`, checksum, bytes: 420 }),
        inspectStagedDomain: async (spec) => ({
          satisfied: true,
          result: { configName: `yunpanel-${spec.primaryDomain}.conf`, checksum, bytes: 420 },
        }),
        inspectActiveDomain: async ({ primaryDomain }) => ({
          satisfied: true,
          result: { configName: `yunpanel-${primaryDomain}.conf`, checksum, active: true },
        }),
        activateDomain: async ({ primaryDomain }) => ({
          configName: `yunpanel-${primaryDomain}.conf`, checksum, active: true,
        }),
        compensateDomain: async () => ({ satisfied: true }),
        inspectDomainCompensation: async () => ({ satisfied: true }),
      },
    });
    await Promise.all([
      applicationRegistry.init(),
      dockerWorkloadRegistry.init(),
      websiteRegistry.init(),
      domainRegistry.init(),
      dnsHostingRegistry.init(),
      mailDomainRegistry.init(),
      websiteProvisioningRuntime.init(),
    ]);
    websiteProvisioningRuntime.configureIsolationAudit({
      websiteRegistry,
      applicationRegistry,
      localServerId,
    });

    const licenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicKeyPem: keys.publicKeyPem,
      publicKeyFile: '',
      publicOrigin: origin,
      instanceId: localServerId,
      masterKey: crypto.randomBytes(32).toString('hex'),
      development: true,
      now: () => clockMs,
    });

    const sftpRecords = new Map();
    const websiteSftpKeyService = {
      list: async (websiteId) => Array.from(sftpRecords.values()).filter((k) => k.websiteId === websiteId),
      add: async ({ websiteId, label, publicKey }) => {
        const item = { id: `key-${sftpRecords.size + 1}`, websiteId, label, publicKey, revision: 1 };
        sftpRecords.set(item.id, item);
        return item;
      },
      revoke: async ({ websiteId, keyId }) => {
        const existing = sftpRecords.get(keyId);
        if (!existing || existing.websiteId !== websiteId) {
          const err = new Error('Key not found');
          err.status = 404;
          err.code = 'sftp_key_not_found';
          throw err;
        }
        sftpRecords.delete(keyId);
        return { id: keyId, revoked: true };
      },
      rotate: async ({ websiteId, keyId, label, publicKey }) => ({
        id: keyId, websiteId, label, publicKey, revision: 2,
      }),
      reconcile: async (websiteId) => ({ websiteId, reconciled: true }),
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

    const terminalCapabilityRegistry = createTerminalCapabilityRegistry();
    const apiKeyStore = createApiKeyStore({ filePath: path.join(tmpDir, 'api-keys.json') });
    const tenantSiteStore = createTenantSiteStore({ filePath: path.join(tmpDir, 'tenant-sites.json') });

    const listener = createAuthenticatedApi({
      store: authStore,
      publicOrigin: origin,
      development: true,
      ownerMfaRequired: false,
      automationHandler: createAutomationHandler({ apiKeyStore }),
      licenseEntitlementService: licenseService,
      createHandler: () => createApp({
        registry: serverRegistry,
        applicationRegistry,
        dockerWorkloadRegistry,
        websiteRegistry,
        domainRegistry,
        dnsHostingRegistry,
        mailDomainRegistry,
        localServerId,
        userAdminStore: authStore.users,
        authStore,
        aiToolRegistry,
        aiAudit: authStore.audit,
        aiProviderRegistry,
        aiConversationService,
        websiteSftpKeyService,
        terminalCapabilityRegistry,
        apiKeyStore,
        tenantSiteStore,
        websiteProvisioningRuntime,
        licenseEntitlementService: licenseService,
      }),
    });

    apiServer = await listenHttpServer(listener);

    async function loginUser(username, password) {
      const res = await fetch(`${apiServer.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(res.status, 200);
      const setCookies = res.headers.getSetCookie();
      const sessionCookie = setCookies.map((c) => c.split(';')[0]).find((c) => c.includes('yunpanel_session='));
      const rawToken = sessionCookie.slice(sessionCookie.indexOf('=') + 1);
      const csrf = csrfForSession(rawToken);
      return { cookie: sessionCookie, csrf, rawToken };
    }

    async function panelFetch(session, pathname, { method = 'GET', body, includeCsrf = true } = {}) {
      const headers = {
        Cookie: session.cookie,
      };
      if (!['GET', 'HEAD'].includes(method)) {
        headers.Origin = origin;
        if (includeCsrf) headers['x-csrf-token'] = session.csrf;
      }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(`${apiServer.baseUrl}${pathname}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = res.status === 204 ? null : await res.json();
      return { status: res.status, body: json };
    }

    const ownerSession = await loginUser('panelowner', 'StrongOwnerPassword!2026');

    // CSRF protection enforced on POST /api/license/activate
    const csrfBlocked = await panelFetch(ownerSession, '/api/panel/license/activate', {
      method: 'POST',
      includeCsrf: false,
      body: { token: 'abc' },
    });
    assert.equal(csrfBlocked.status, 403);

    // Phase 1: FREE BASELINE
    const initialLic = await panelFetch(ownerSession, '/api/panel/license');
    assert.equal(initialLic.status, 200);
    assert.equal(initialLic.body.data.tier, 'free');
    assert.equal(initialLic.body.data.status, 'free');
    assert.equal(initialLic.body.data.instanceId, localServerId);
    assert.equal(initialLic.body.data.capabilities.singlePanelUserUnlimitedSites, true);
    assert.equal(initialLic.body.data.capabilities.aiOperations, false);
    assert.equal(initialLic.body.data.capabilities.resellerAccounts, false);
    assert.equal(initialLic.body.data.capabilities.perSiteIsolatedUsers, false);

    // Free baseline allows single Owner to create multiple websites (unlimited sites!) with dedicated non-root site runtime users
    async function createOwnerWebsite(domainName, siteAdmin = undefined, activeSession = ownerSession) {
      const input = {
        operationId: crypto.randomUUID(),
        serverId: localServerId,
        name: `Site ${domainName}`,
        primaryDomain: domainName,
        parentDomainId: null,
        wwwMode: 'none',
        httpsMode: 'off',
        dns: { mode: 'external' },
        source: {
          kind: 'new_static',
          repositoryUrl: 'https://github.com/example/site-static',
          branch: 'main',
          build: { mode: 'none', outputDir: '.' },
          retention: 5,
        },
        ...(siteAdmin !== undefined ? { siteAdmin } : {}),
      };
      const preview = await panelFetch(activeSession, '/api/panel/sites/create-preview', {
        method: 'POST',
        body: { input },
      });
      if (preview.status !== 200) return preview;
      return panelFetch(activeSession, '/api/panel/sites', {
        method: 'POST',
        body: {
          input,
          previewDigest: preview.body.data.previewDigest,
          confirmation: preview.body.data.confirmation,
        },
      });
    }

    const site1Res = await createOwnerWebsite('alpha-free.example.test');
    assert.equal(site1Res.status, 201);
    const site1 = site1Res.body.data.website;
    assert.match(site1.unixUser, /^yunapp-[a-f0-9]{12}$/);

    const site2Res = await createOwnerWebsite('beta-free.example.test');
    assert.equal(site2Res.status, 201);
    const site2 = site2Res.body.data.website;
    assert.notEqual(site1.unixUser, site2.unixUser);

    // Free baseline allows Owner BOTH root server terminal AND dedicated Linux site-user terminal!
    const serverTermFree = await panelFetch(ownerSession, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'server', serverId: localServerId },
    });
    assert.equal(serverTermFree.status, 201);
    assert.equal(serverTermFree.body.data.target.user, 'root');

    const ownerSiteTermFree = await panelFetch(ownerSession, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: site1.id },
    });
    assert.equal(ownerSiteTermFree.status, 201);
    assert.equal(ownerSiteTermFree.body.data.target.user, site1.unixUser);

    // Free baseline allows single Owner full SFTP key maintenance (add/list/rotate/reconcile) on their own websites!
    const ownerAddSftpFree = await panelFetch(ownerSession, `/api/panel/websites/${site1.id}/sftp/keys`, {
      method: 'POST',
      body: {
        label: 'owner-free-laptop',
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGk7testkey owner@example',
      },
    });
    assert.equal(ownerAddSftpFree.status, 201);
    const ownerFreeKey = ownerAddSftpFree.body.data;

    const ownerRotateSftpFree = await panelFetch(
      ownerSession,
      `/api/panel/websites/${site1.id}/sftp/keys/${ownerFreeKey.id}/rotate`,
      {
        method: 'POST',
        body: {
          expectedRevision: 1,
          label: 'owner-free-rotated',
          publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGk7testkey2 owner@example',
        },
      },
    );
    assert.equal(ownerRotateSftpFree.status, 200);

    const ownerReconcileSftpFree = await panelFetch(
      ownerSession,
      `/api/panel/websites/${site1.id}/sftp/keys/reconcile`,
      { method: 'POST', body: {} },
    );
    assert.equal(ownerReconcileSftpFree.status, 200);

    const ownerIsoAuditFree = await panelFetch(
      ownerSession,
      `/api/panel/websites/${site1.id}/isolation-audit`,
    );
    assert.equal(ownerIsoAuditFree.status, 200);
    assert.equal(ownerIsoAuditFree.body.data.websiteId, site1.id);

    // Free baseline allows Owner's automation API key to provision proxy subdomain sites (no separate panel login created)
    const createdApiKey = await apiKeyStore.create({
      name: 'Provisioner',
      parentDomain: 'alpha-free.example.test',
      portMin: 32000,
      portMax: 32999,
      createdBy: ownerUser.id,
    });
    const tenantPutFree = await fetch(`${apiServer.baseUrl}/api/automation/tenant-sites/demo`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${createdApiKey.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ upstreamPort: 32001 }),
    });
    assert.ok([200, 202].includes(tenantPutFree.status), `Expected 200/202 for Owner automation site on Free, got ${tenantPutFree.status}`);

    // Free baseline gates all 3 Premium capabilities on backend APIs!
    const aiToolsFree = await panelFetch(ownerSession, '/api/ai/tools');
    assert.equal(aiToolsFree.status, 403);
    assert.equal(aiToolsFree.body.error.code, 'premium_license_required');
    assert.equal(aiToolsFree.body.error.capability, 'aiOperations');

    const aiConvFree = await panelFetch(ownerSession, '/api/ai/conversations', {
      method: 'POST',
      body: { title: 'Test' },
    });
    assert.equal(aiConvFree.status, 403);
    assert.equal(aiConvFree.body.error.code, 'premium_license_required');

    const createPanelUserFree = await panelFetch(ownerSession, '/api/panel/users', {
      method: 'POST',
      body: {
        username: 'sitemgr1',
        password: 'SiteManagerPassword!2026',
        role: 'site_manager',
        websiteIds: [site1.id],
      },
    });
    assert.equal(createPanelUserFree.status, 403);
    assert.equal(createPanelUserFree.body.error.code, 'premium_license_required');
    assert.equal(createPanelUserFree.body.error.capability, 'perSiteIsolatedUsers');

    const siteWithAdminFree = await createOwnerWebsite('gamma-admin.example.test', {
      email: 'gammaadmin@example.test',
      password: 'GammaAdminPassword!2026',
    });
    assert.equal(siteWithAdminFree.status, 403);
    assert.equal(siteWithAdminFree.body.error.capability, 'perSiteIsolatedUsers');

    const createResellerFree = await panelFetch(ownerSession, '/api/panel/users/hosting/accounts/create-login', {
      method: 'POST',
      body: {
        kind: 'reseller',
        username: 'reseller1',
        password: 'ResellerPassword!2026',
        limits: { maxCustomers: 10, maxWebsites: 25 },
      },
    });
    assert.equal(createResellerFree.status, 403);
    assert.equal(createResellerFree.body.error.code, 'premium_license_required');
    assert.equal(createResellerFree.body.error.capability, 'resellerAccounts');

    const registerResellerFree = await panelFetch(ownerSession, '/api/panel/users/hosting/accounts', {
      method: 'POST',
      body: {
        kind: 'reseller',
        userId: ownerUser.id,
        expectedUserRevision: 1,
        limits: { maxCustomers: 5, maxWebsites: 10 },
      },
    });
    assert.equal(registerResellerFree.status, 403);
    assert.equal(registerResellerFree.body.error.capability, 'resellerAccounts');

    // Phase 2: ACTIVATE MONTHLY PREMIUM LICENSE (periodMonths: 1)
    const monthlyToken = signTestEntitlementToken(keys.privateKey, keys.kid, {
      nowSec: Math.floor(clockMs / 1000),
      sub: 'lic_http_01',
      licenseId: 'lic_http_01',
      entitlementVersion: 1,
      periodMonths: 1,
      durationSeconds: 30 * 86400,
      domain: 'panel.example.test',
      activatedInstanceId: localServerId,
    });

    const activateRes = await panelFetch(ownerSession, '/api/panel/license/activate', {
      method: 'POST',
      body: { token: monthlyToken },
    });
    assert.equal(activateRes.status, 200);
    assert.equal(activateRes.body.data.valid, true);
    assert.equal(activateRes.body.data.tier, 'premium');
    assert.equal(activateRes.body.data.billingPeriod, 'monthly');
    assert.equal(activateRes.body.data.periodMonths, 1);

    // All 3 Premium feature families now work!
    const aiToolsPrem = await panelFetch(ownerSession, '/api/ai/tools');
    assert.equal(aiToolsPrem.status, 200);
    assert.ok(Array.isArray(aiToolsPrem.body.data));

    const createPanelUserPrem = await panelFetch(ownerSession, '/api/panel/users', {
      method: 'POST',
      body: {
        username: 'sitemgr1',
        password: 'SiteManagerPassword!2026',
        role: 'site_manager',
        websiteIds: [site1.id],
      },
    });
    assert.equal(createPanelUserPrem.status, 201);
    const siteManagerUser = createPanelUserPrem.body.data.user;

    const createReadOnlyPrem = await panelFetch(ownerSession, '/api/panel/users', {
      method: 'POST',
      body: {
        username: 'auditor1',
        password: 'ReadOnlyAuditorPassword!2026',
        role: 'read_only',
      },
    });
    assert.equal(createReadOnlyPrem.status, 201);

    const createResellerPrem = await panelFetch(ownerSession, '/api/panel/users/hosting/accounts/create-login', {
      method: 'POST',
      body: {
        kind: 'reseller',
        username: 'reseller1',
        password: 'ResellerPassword!2026',
        limits: { maxCustomers: 10, maxWebsites: 25 },
      },
    });
    assert.equal(createResellerPrem.status, 201);
    const resellerAccount = createResellerPrem.body.data.account;

    // RBAC & Tenant Scope Isolation during Premium:
    const siteMgrSession = await loginUser('sitemgr1', 'SiteManagerPassword!2026');
    const resellerSession = await loginUser('reseller1', 'ResellerPassword!2026');

    // Separate site_manager CAN use terminal & SFTP on assigned site1 during Premium...
    const siteMgrTermPrem = await panelFetch(siteMgrSession, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: site1.id },
    });
    assert.equal(siteMgrTermPrem.status, 201);
    assert.equal(siteMgrTermPrem.body.data.target.user, site1.unixUser);

    const siteMgrSftpAddPrem = await panelFetch(siteMgrSession, `/api/panel/websites/${site1.id}/sftp/keys`, {
      method: 'POST',
      body: {
        label: 'sitemgr-laptop',
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGk7testkey3 sitemgr@example',
      },
    });
    assert.equal(siteMgrSftpAddPrem.status, 201);
    const addedSftpKey = siteMgrSftpAddPrem.body.data;

    // ...but CANNOT access unassigned site2 or root server terminal (outer siteResourceBoundary rejects with site_scope_forbidden)!
    const siteMgrForeignTermPrem = await panelFetch(siteMgrSession, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: site2.id },
    });
    assert.equal(siteMgrForeignTermPrem.status, 403);
    assert.equal(siteMgrForeignTermPrem.body.error.code, 'site_scope_forbidden');

    const siteMgrRootTermPrem = await panelFetch(siteMgrSession, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'server', serverId: localServerId },
    });
    assert.equal(siteMgrRootTermPrem.status, 403);
    assert.equal(siteMgrRootTermPrem.body.error.code, 'site_scope_forbidden');

    const siteMgrForeignSftpPrem = await panelFetch(siteMgrSession, `/api/panel/websites/${site2.id}/sftp/keys`, {
      method: 'POST',
      body: {
        label: 'unauthorized-key',
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGk7testkey4 sitemgr@example',
      },
    });
    assert.equal(siteMgrForeignSftpPrem.status, 403);
    assert.equal(siteMgrForeignSftpPrem.body.error.code, 'site_scope_forbidden');

    // Reseller CAN create own customer during Premium, CANNOT access Direct Owner site1
    const resellerCreateCustPrem = await panelFetch(resellerSession, '/api/panel/users/hosting/accounts/self/customers', {
      method: 'POST',
      body: {
        username: 'rescust1',
        password: 'ResellerCustomerPassword!2026',
        quotas: { maxWebsites: 5, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 5 },
      },
    });
    assert.equal(resellerCreateCustPrem.status, 201);

    const resellerOwnerSiteDenied = await panelFetch(resellerSession, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: site1.id },
    });
    assert.equal(resellerOwnerSiteDenied.status, 403);
    assert.equal(resellerOwnerSiteDenied.body.error.code, 'site_scope_forbidden');

    // RBAC on /api/license: non-Owner gets minimal safe summary and is forbidden from POST mutations
    const siteMgrLicGet = await panelFetch(siteMgrSession, '/api/panel/license');
    assert.equal(siteMgrLicGet.status, 200);
    assert.equal(siteMgrLicGet.body.data.tier, 'premium');
    assert.equal(siteMgrLicGet.body.data.instanceId, undefined);
    assert.equal(siteMgrLicGet.body.data.maskedLicenseKey, undefined);

    const siteMgrDeactivate = await panelFetch(siteMgrSession, '/api/panel/license/deactivate', {
      method: 'POST',
      body: { confirmation: 'deactivate-license' },
    });
    assert.equal(siteMgrDeactivate.status, 403);

    const readOnlySession = await loginUser('auditor1', 'ReadOnlyAuditorPassword!2026');
    const readOnlyLicGet = await panelFetch(readOnlySession, '/api/panel/license');
    assert.equal(readOnlyLicGet.status, 200);
    assert.equal(readOnlyLicGet.body.data.tier, 'premium');
    assert.equal(readOnlyLicGet.body.data.instanceId, undefined);

    // Phase 3: NON-DESTRUCTIVE EXPIRATION (advance clock 31 days past monthly expiry)
    clockMs += 31 * 86400 * 1000;
    // Re-login after 31-day jump (since 12h session lifetime elapsed)
    const ownerAfterExpiry = await loginUser('panelowner', 'StrongOwnerPassword!2026');
    const siteMgrAfterExpiry = await loginUser('sitemgr1', 'SiteManagerPassword!2026');
    const resellerAfterExpiry = await loginUser('reseller1', 'ResellerPassword!2026');

    const expiredLic = await panelFetch(ownerAfterExpiry, '/api/panel/license');
    assert.equal(expiredLic.status, 200);
    assert.equal(expiredLic.body.data.valid, false);
    assert.equal(expiredLic.body.data.tier, 'free');
    assert.equal(expiredLic.body.data.status, 'expired');
    assert.equal(expiredLic.body.data.renewalRequired, true);
    assert.equal(expiredLic.body.data.capabilities.aiOperations, false);

    // Existing websites, dedicated Unix users, domains, reseller records, SFTP keys, and revocations remain 100% intact!
    const websitesAfterExpiry = await panelFetch(ownerAfterExpiry, '/api/panel/websites');
    assert.equal(websitesAfterExpiry.status, 200);
    const foundSite1 = websitesAfterExpiry.body.data.find((w) => w.id === site1.id);
    const foundSite2 = websitesAfterExpiry.body.data.find((w) => w.id === site2.id);
    assert.ok(foundSite1 && foundSite2, 'Existing websites must never be deleted on license expiry');
    assert.equal(foundSite1.unixUser, site1.unixUser, 'Site Unix user must never be altered or merged on license expiry');

    // CRITICAL BASELINE INVARIANT: Expired Owner STILL has full isolated site terminal AND full SFTP maintenance!
    const ownerSiteTermExpired = await panelFetch(ownerAfterExpiry, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: site1.id },
    });
    assert.equal(ownerSiteTermExpired.status, 201);
    assert.equal(ownerSiteTermExpired.body.data.target.user, site1.unixUser);

    const ownerAddSftpExpired = await panelFetch(ownerAfterExpiry, `/api/panel/websites/${site1.id}/sftp/keys`, {
      method: 'POST',
      body: {
        label: 'owner-recovery-key',
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGk7testkey5 owner@example',
      },
    });
    assert.equal(ownerAddSftpExpired.status, 201);

    const ownerIsoAuditExpired = await panelFetch(
      ownerAfterExpiry,
      `/api/panel/websites/${site1.id}/isolation-audit`,
    );
    assert.equal(ownerIsoAuditExpired.status, 200);
    assert.equal(ownerIsoAuditExpired.body.data.websiteId, site1.id);

    // Meanwhile, separate site_manager & reseller panel logins ARE gated on Premium while keeping RBAC scope isolation first!
    const siteMgrForeignExpired = await panelFetch(siteMgrAfterExpiry, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: site2.id },
    });
    assert.equal(siteMgrForeignExpired.status, 403);
    assert.equal(siteMgrForeignExpired.body.error.code, 'site_scope_forbidden');

    const siteMgrAssignedTermExpired = await panelFetch(siteMgrAfterExpiry, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: site1.id },
    });
    assert.equal(siteMgrAssignedTermExpired.status, 403);
    assert.equal(siteMgrAssignedTermExpired.body.error.code, 'premium_license_required');
    assert.equal(siteMgrAssignedTermExpired.body.error.capability, 'perSiteIsolatedUsers');

    const siteMgrAssignedSftpExpired = await panelFetch(siteMgrAfterExpiry, `/api/panel/websites/${site1.id}/sftp/keys`, {
      method: 'POST',
      body: {
        label: 'sitemgr-expired-key',
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGk7testkey6 sitemgr@example',
      },
    });
    assert.equal(siteMgrAssignedSftpExpired.status, 403);
    assert.equal(siteMgrAssignedSftpExpired.body.error.code, 'premium_license_required');
    assert.equal(siteMgrAssignedSftpExpired.body.error.capability, 'perSiteIsolatedUsers');

    const resellerCreateCustExpired = await panelFetch(resellerAfterExpiry, '/api/panel/users/hosting/accounts/self/customers', {
      method: 'POST',
      body: {
        username: 'rescust2',
        password: 'ResellerCustomerPassword!2026',
        quotas: { maxWebsites: 5, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 5 },
      },
    });
    assert.equal(resellerCreateCustExpired.status, 403);
    assert.equal(resellerCreateCustExpired.body.error.code, 'premium_license_required');
    assert.equal(resellerCreateCustExpired.body.error.capability, 'resellerAccounts');

    // Reseller inventory remains readable and can be safely deactivated by Owner on expired license
    const hostingListAfterExpiry = await panelFetch(ownerAfterExpiry, '/api/panel/users/hosting/accounts');
    assert.equal(hostingListAfterExpiry.status, 200);
    assert.ok(hostingListAfterExpiry.body.data.accounts.some((a) => a.id === resellerAccount.id));

    const suspendResellerOnExpired = await panelFetch(
      ownerAfterExpiry,
      `/api/panel/users/hosting/accounts/${resellerAccount.id}/status`,
      { method: 'POST', body: {} },
    );
    assert.equal(suspendResellerOnExpired.status, 405); // method check still intact

    const disableResellerPatch = await panelFetch(
      ownerAfterExpiry,
      `/api/panel/users/hosting/accounts/${resellerAccount.id}/status`,
      { method: 'PATCH', body: { active: false, revision: resellerAccount.revision } },
    );
    assert.equal(disableResellerPatch.status, 200);

    // Re-enabling reseller while license is expired IS gated (`inspectTargetAccount` resolves `kind: 'reseller'`)!
    const reenableResellerExpired = await panelFetch(
      ownerAfterExpiry,
      `/api/panel/users/hosting/accounts/${resellerAccount.id}/status`,
      { method: 'PATCH', body: { active: true, revision: disableResellerPatch.body.data.account.revision } },
    );
    assert.equal(reenableResellerExpired.status, 403);
    assert.equal(reenableResellerExpired.body.error.code, 'premium_license_required');
    assert.equal(reenableResellerExpired.body.error.capability, 'resellerAccounts');

    // Existing SFTP keys can still be listed and revoked during expired state!
    const sftpListExpired = await panelFetch(ownerAfterExpiry, `/api/panel/websites/${site1.id}/sftp/keys`);
    assert.equal(sftpListExpired.status, 200);
    assert.equal(sftpListExpired.body.data.length, 3);

    const revokeSftpExpired = await panelFetch(
      ownerAfterExpiry,
      `/api/panel/websites/${site1.id}/sftp/keys/${addedSftpKey.id}/revoke`,
      { method: 'POST', body: { expectedRevision: 1 } },
    );
    assert.equal(revokeSftpExpired.status, 200);

    // Existing panel user can be deactivated during expired state, while enabling/creating new ones is gated
    const disableSiteMgrExpired = await panelFetch(
      ownerAfterExpiry,
      `/api/panel/users/${siteManagerUser.id}`,
      { method: 'PATCH', body: { active: false, revision: siteManagerUser.revision } },
    );
    assert.equal(disableSiteMgrExpired.status, 200);

    const enableSiteMgrExpired = await panelFetch(
      ownerAfterExpiry,
      `/api/panel/users/${siteManagerUser.id}`,
      { method: 'PATCH', body: { active: true, revision: disableSiteMgrExpired.body.data.user.revision } },
    );
    assert.equal(enableSiteMgrExpired.status, 403);
    assert.equal(enableSiteMgrExpired.body.error.code, 'premium_license_required');

    // Single Owner can STILL create a new website without siteAdmin even while Premium is expired!
    const site3DuringExpired = await createOwnerWebsite('delta-baseline.example.test', undefined, ownerAfterExpiry);
    assert.equal(site3DuringExpired.status, 201);

    // Phase 4: RENEWAL WITH YEARLY TOKEN (periodMonths: 12, entitlementVersion: 2)
    const yearlyRenewalToken = signTestEntitlementToken(keys.privateKey, keys.kid, {
      nowSec: Math.floor(clockMs / 1000),
      sub: 'lic_http_01',
      licenseId: 'lic_http_01',
      entitlementVersion: 2,
      periodMonths: 12,
      durationSeconds: 365 * 86400,
      domain: 'panel.example.test',
      activatedInstanceId: localServerId,
    });
    const refreshYearly = await panelFetch(ownerAfterExpiry, '/api/panel/license/refresh', {
      method: 'POST',
      body: { token: yearlyRenewalToken },
    });
    assert.equal(refreshYearly.status, 200);
    assert.equal(refreshYearly.body.data.valid, true);
    assert.equal(refreshYearly.body.data.tier, 'premium');
    assert.equal(refreshYearly.body.data.billingPeriod, 'yearly');
    assert.equal(refreshYearly.body.data.periodMonths, 12);

    // Re-enabling reseller, site_manager, and their site terminal access work immediately after yearly renewal
    const reenableResellerAfterRenew = await panelFetch(
      ownerAfterExpiry,
      `/api/panel/users/hosting/accounts/${resellerAccount.id}/status`,
      { method: 'PATCH', body: { active: true, revision: disableResellerPatch.body.data.account.revision } },
    );
    assert.equal(reenableResellerAfterRenew.status, 200);

    const reenableSiteMgrAfterRenew = await panelFetch(
      ownerAfterExpiry,
      `/api/panel/users/${siteManagerUser.id}`,
      { method: 'PATCH', body: { active: true, revision: disableSiteMgrExpired.body.data.user.revision } },
    );
    assert.equal(reenableSiteMgrAfterRenew.status, 200);

    const siteMgrRenewedSession = await loginUser('sitemgr1', 'SiteManagerPassword!2026');
    const siteMgrTermAfterRenew = await panelFetch(siteMgrRenewedSession, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: site1.id },
    });
    assert.equal(siteMgrTermAfterRenew.status, 201);

    // Audit log recorded license events without leaking raw token
    const auditEvents = authStore.audit.list({ resourceType: 'license', resourceId: localServerId }).events;
    assert.ok(auditEvents.some((e) => e.action === 'license.activated' && e.outcome === 'succeeded'));
    assert.ok(auditEvents.some((e) => e.action === 'license.refreshed' && e.outcome === 'succeeded'));
    const serializedAudit = JSON.stringify(auditEvents);
    assert.ok(!serializedAudit.includes(monthlyToken));
    assert.ok(!serializedAudit.includes(yearlyRenewalToken));
  } finally {
    if (apiServer) await apiServer.close();
    if (authStore) authStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('default vendor trust anchor (kid=1cbcc4d3173d0c15), postinst non-destructive bootstrap, and source-dev env override work out of the box', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-lic-trust-bootstrap-'));
  let commerceServer = null;
  try {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const vendorPemPath = defaultVendorEntitlementPublicKeyFile();
    const vendorPem = readFileSync(vendorPemPath, 'utf8');

    // 1. Vendor public key file contains ONLY public SPKI material with exact kid 1cbcc4d3173d0c15
    assert.ok(!vendorPem.includes('PRIVATE KEY'), 'Vendor PEM must never contain private key material');
    assert.equal(VENDOR_ENTITLEMENT_PUBLIC_KEY_KID, '1cbcc4d3173d0c15');
    const parsedVendorMap = parseTrustedPublicKeys({ publicKeyFile: vendorPemPath });
    assert.deepEqual([...parsedVendorMap.keys()], ['1cbcc4d3173d0c15']);
    const spkiDer = crypto.createPublicKey(vendorPem).export({ format: 'der', type: 'spki' });
    assert.equal(computePublicKeyId(spkiDer), '1cbcc4d3173d0c15');

    // 2. Shell syntax & packaging payload checks for build-deb.sh and postinst
    execFileSync('/bin/sh', ['-n', path.join(repoRoot, 'packaging/debian/postinst')]);
    execFileSync('/bin/bash', ['-n', path.join(repoRoot, 'scripts/build-deb.sh')]);
    const buildDebSource = readFileSync(path.join(repoRoot, 'scripts/build-deb.sh'), 'utf8');
    assert.match(buildDebSource, /apps\/api\/src\/panel\/vendor-entitlement-public\.pem "\$package_root\/usr\/share\/yunpanel\/trust\/entitlement-public\.pem"/);
    assert.match(buildDebSource, /docs\/license-configuration\.md/);

    // 3. Real shell execution of postinst trust-anchor seeding & operator custom config preservation
    const postinstSource = readFileSync(path.join(repoRoot, 'packaging/debian/postinst'), 'utf8');
    assert.match(postinstSource, /if \[ ! -e \/etc\/yunpanel\/control-plane\/entitlement-public\.pem \]/);
    assert.match(postinstSource, /! grep -q '\^YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM=' "\$api_env"/);

    const fakeRoot = path.join(tmpDir, 'rootfs');
    const shareTrustDir = path.join(fakeRoot, 'usr/share/yunpanel/trust');
    const etcControlDir = path.join(fakeRoot, 'etc/yunpanel/control-plane');
    writeFileSync(path.join(tmpDir, 'seed.sh'), `#!/bin/sh
set -eu
ROOT="$1"
install -d -m 0700 "$ROOT/etc/yunpanel/control-plane"
if [ ! -e "$ROOT/etc/yunpanel/control-plane/entitlement-public.pem" ] && [ ! -L "$ROOT/etc/yunpanel/control-plane/entitlement-public.pem" ] && [ -f "$ROOT/usr/share/yunpanel/trust/entitlement-public.pem" ]; then
  install -m 0644 "$ROOT/usr/share/yunpanel/trust/entitlement-public.pem" "$ROOT/etc/yunpanel/control-plane/entitlement-public.pem"
fi
api_env="$ROOT/etc/yunpanel/control-plane/api.env"
if [ -f "$api_env" ]; then
  api_temp=$(mktemp "$ROOT/etc/yunpanel/control-plane/api.env.XXXXXX")
  cp "$api_env" "$api_temp"
  api_changed=0
  if ! grep -q '^YUNPANEL_LICENSE_STORE=' "$api_env"; then
    printf '%s\\n' 'YUNPANEL_LICENSE_STORE=/var/lib/yunpanel/control-plane/license/entitlement.json' >>"$api_temp"
    api_changed=1
  fi
  if ! grep -q '^YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE=' "$api_env" && ! grep -q '^YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM=' "$api_env"; then
    printf '%s\\n' "YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE=$ROOT/etc/yunpanel/control-plane/entitlement-public.pem" >>"$api_temp"
    api_changed=1
  fi
  if ! grep -q '^YUNPANEL_LICENSE_COMMERCE_URL=' "$api_env"; then
    printf '%s\\n' 'YUNPANEL_LICENSE_COMMERCE_URL=https://yunsoft.com/api/commerce' >>"$api_temp"
    api_changed=1
  fi
  if [ "$api_changed" -eq 1 ]; then
    install -m 0600 "$api_temp" "$api_env"
  fi
  rm -f "$api_temp"
fi
`, { mode: 0o700 });

    execFileSync('/bin/mkdir', ['-p', shareTrustDir, etcControlDir]);
    writeFileSync(path.join(shareTrustDir, 'entitlement-public.pem'), vendorPem, { mode: 0o644 });
    const apiEnvPath = path.join(etcControlDir, 'api.env');
    writeFileSync(apiEnvPath, 'YUNPANEL_PUBLIC_ORIGIN=https://panel.customer.example\n', { mode: 0o600 });

    // Fresh install seeds /etc/yunpanel/control-plane/entitlement-public.pem with kid=1cbcc4d3173d0c15
    execFileSync('/bin/sh', [path.join(tmpDir, 'seed.sh'), fakeRoot]);
    const seededKeyPath = path.join(etcControlDir, 'entitlement-public.pem');
    assert.deepEqual([...parseTrustedPublicKeys({ publicKeyFile: seededKeyPath }).keys()], ['1cbcc4d3173d0c15']);
    const seededApiEnv = readFileSync(apiEnvPath, 'utf8');
    assert.ok(seededApiEnv.includes(`YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE=${seededKeyPath}`));

    // Operator customizes /etc/yunpanel/control-plane/entitlement-public.pem -> upgrade MUST NOT overwrite it!
    const operatorKeys = generateTestEd25519KeyPair();
    writeFileSync(seededKeyPath, operatorKeys.publicKeyPem, { mode: 0o644 });
    execFileSync('/bin/sh', [path.join(tmpDir, 'seed.sh'), fakeRoot]);
    assert.equal(readFileSync(seededKeyPath, 'utf8'), operatorKeys.publicKeyPem);
    const operatorSvc = createLicenseEntitlementService({
      filePath: ':memory:',
      systemPublicKeyFile: seededKeyPath,
      publicOrigin: 'https://panel.customer.example',
      development: false,
    });
    assert.deepEqual(operatorSvc.getStatus({ includeManagementDetails: true }).trustedKeyIds, [operatorKeys.kid]);

    // Operator sets inline YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM in api.env -> postinst MUST NOT inject conflicting FILE var!
    writeFileSync(apiEnvPath, 'YUNPANEL_PUBLIC_ORIGIN=https://panel.customer.example\nYUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----..."\n', { mode: 0o600 });
    execFileSync('/bin/sh', [path.join(tmpDir, 'seed.sh'), fakeRoot]);
    const pemOnlyApiEnv = readFileSync(apiEnvPath, 'utf8');
    assert.ok(!pemOnlyApiEnv.includes('YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE='));

    // 4. Child-process native verification: default clean env loads kid=1cbcc4d3173d0c15 with zero 503;
    //    source-dev YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE overrides cleanly; missing custom file fails closed.
    const untrustedSigner = generateTestEd25519KeyPair();
    commerceServer = await listenHttpServer(async (req, res) => {
      const body = await readRequestJson(req);
      res.setHeader('content-type', 'application/json');
      const forgedToken = signTestEntitlementToken(untrustedSigner.privateKey, untrustedSigner.kid, {
        domain: body.domain,
        activatedInstanceId: body.instanceId,
      });
      res.writeHead(200);
      res.end(JSON.stringify({ data: { activated: true, entitlementToken: forgedToken } }));
    });

    const probeScript = `
      import { createLicenseEntitlementService } from ${JSON.stringify(SERVICE_MODULE_URL)};
      const svc = createLicenseEntitlementService({
        filePath: ':memory:',
        systemPublicKeyFile: process.env.TEST_SYS_KEY_FILE || ${JSON.stringify(path.join(tmpDir, 'absent-system-key.pem'))},
        commerceBaseUrl: process.env.TEST_COMMERCE_URL,
        publicOrigin: 'https://panel.customer.example',
        instanceId: 'srv-fresh-01',
        development: process.env.TEST_DEV === '1',
      });
      const status = svc.getStatus({ includeManagementDetails: true });
      let activateOutcome = null;
      if (process.env.TEST_TRY_TOKEN) {
        try {
          const res = await svc.activate({ token: process.env.TEST_TRY_TOKEN });
          activateOutcome = { ok: true, tier: res.tier, keyId: res.keyId };
        } catch (err) {
          activateOutcome = { ok: false, status: err.status, code: err.code, reason: err.reason };
        }
      } else if (process.env.TEST_TRY_KEY) {
        try {
          await svc.activate({ licenseKey: process.env.TEST_TRY_KEY });
          activateOutcome = { ok: true };
        } catch (err) {
          activateOutcome = { ok: false, status: err.status, code: err.code, reason: err.reason };
        }
      }
      process.stdout.write(JSON.stringify({
        verificationKeyConfigured: status.verificationKeyConfigured,
        trustedKeyIds: status.trustedKeyIds,
        activateOutcome,
      }));
    `;

    const runProbe = (extraEnv = {}) => new Promise((resolve, reject) => {
      const cleanEnv = { ...process.env };
      delete cleanEnv.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
      delete cleanEnv.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', probeScript],
        {
          env: {
            ...cleanEnv,
            TEST_COMMERCE_URL: commerceServer.baseUrl,
            ...extraEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`Probe exited ${code}: ${stderr}`));
        resolve(JSON.parse(stdout));
      });
    });

    // 4a. Default zero-config customer install (even before /etc/.../entitlement-public.pem exists) loads vendor kid=1cbcc4d3173d0c15 and never 503s!
    const defaultProdProbe = await runProbe();
    assert.equal(defaultProdProbe.verificationKeyConfigured, true);
    assert.deepEqual(defaultProdProbe.trustedKeyIds, ['1cbcc4d3173d0c15']);

    const defaultProbe = await runProbe({ TEST_DEV: '1', TEST_TRY_KEY: 'YUN-FRESH-CUSTOMER-0001' });
    assert.equal(defaultProbe.verificationKeyConfigured, true);
    assert.deepEqual(defaultProbe.trustedKeyIds, ['1cbcc4d3173d0c15']);
    assert.equal(defaultProbe.activateOutcome.ok, false);
    assert.equal(defaultProbe.activateOutcome.status, 422); // Reached Commerce & rejected untrusted kid, NOT 503!
    assert.equal(defaultProbe.activateOutcome.reason, 'KEY_ID_MISMATCH');

    // 4b. Even when YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE points to DEFAULT_SYSTEM_ENTITLEMENT_PUBLIC_KEY_FILE before seeding, vendor fallback prevents 503
    const defaultSystemPathMissingProbe = await runProbe({
      TEST_SYS_KEY_FILE: path.join(tmpDir, 'unseeded-default-system.pem'),
      YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE: path.join(tmpDir, 'unseeded-default-system.pem'),
    });
    assert.equal(defaultSystemPathMissingProbe.verificationKeyConfigured, true);
    assert.deepEqual(defaultSystemPathMissingProbe.trustedKeyIds, ['1cbcc4d3173d0c15']);
    assert.equal(DEFAULT_SYSTEM_ENTITLEMENT_PUBLIC_KEY_FILE, '/etc/yunpanel/control-plane/entitlement-public.pem');

    // 4c. Source-dev YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE env override trusts ONLY the configured dev key
    const devKeys = generateTestEd25519KeyPair();
    const devKeyFile = path.join(tmpDir, 'dev-commerce-public.pem');
    writeFileSync(devKeyFile, devKeys.publicKeyPem, { mode: 0o600 });
    const devToken = signTestEntitlementToken(devKeys.privateKey, devKeys.kid, {
      domain: 'panel.customer.example',
      activatedInstanceId: 'srv-fresh-01',
    });
    const devOverrideProbe = await runProbe({
      YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE: devKeyFile,
      TEST_TRY_TOKEN: devToken,
    });
    assert.equal(devOverrideProbe.verificationKeyConfigured, true);
    assert.deepEqual(devOverrideProbe.trustedKeyIds, [devKeys.kid]);
    assert.equal(devOverrideProbe.activateOutcome.ok, true);
    assert.equal(devOverrideProbe.activateOutcome.tier, 'premium');
    assert.equal(devOverrideProbe.activateOutcome.keyId, devKeys.kid);

    // 4d. Explicit custom YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE that is missing fails closed (503) instead of silently trusting vendor
    const missingCustomProbe = await runProbe({
      YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE: path.join(tmpDir, 'missing-custom-operator.pem'),
      TEST_TRY_KEY: 'YUN-CUSTOM-MISSING-0001',
    });
    assert.equal(missingCustomProbe.verificationKeyConfigured, false);
    assert.deepEqual(missingCustomProbe.trustedKeyIds, []);
    assert.equal(missingCustomProbe.activateOutcome.status, 503);
    assert.equal(missingCustomProbe.activateOutcome.code, 'license_public_key_not_configured');
  } finally {
    if (commerceServer) await commerceServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
