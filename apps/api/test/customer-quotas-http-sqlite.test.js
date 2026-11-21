import assert from 'node:assert/strict';
import crypto, { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { nginxConfigFileName } from '@yunpanel/config-templates';
import { inspectNativeDiskQuotaSupport } from '@yunpanel/host-runtime';
import { createApp } from '../src/app.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import {
  createCustomerDatabaseQuotaCoordinator,
  validateCustomerQuotaEnforcement,
} from '../src/customer-quotas.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDatabaseBindingRegistry } from '../src/database-binding-registry.js';
import { createWebsiteTrafficCoordinator } from '../src/website-traffic-coordinator.js';
import { executeSiteFileOperation } from '../src/site-file-worker.js';
import {
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  YUNPANEL_PRODUCT_CODE,
} from '../src/license-entitlement-verifier.js';
import { createLicenseEntitlementService } from '../src/license-entitlement-service.js';

const PASSWORD = 'Stage2-Quota-Password!2026';
const PUBLIC_ORIGIN = 'http://127.0.0.1:4173';
const APP_STORAGE_PREFIX = '/var/lib/yunpanel/apps';

function makeTempDir(t, prefix = 'yunpanel-quotas-http-sqlite-') {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ownerPolicy(session) {
  return session;
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

async function createSignedPremiumLicense(dir, instanceId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const kid = computePublicKeyId(publicKey.export({ format: 'der', type: 'spki' }));
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + 30 * 86400;
  const header = { alg: 'EdDSA', crv: 'Ed25519', typ: ENTITLEMENT_TOKEN_TYPE, kid };
  const payload = {
    iss: ENTITLEMENT_ISSUER,
    sub: 'lic_stage2_quotas_test',
    licenseId: 'lic_stage2_quotas_test',
    jti: randomUUID(),
    iat: nowSec,
    nbf: nowSec - 60,
    exp,
    productCode: YUNPANEL_PRODUCT_CODE,
    billingModel: 'monthly_term',
    periodMonths: 1,
    status: 'active',
    domain: 'panel.local.test',
    normalizedDomain: 'panel.local.test',
    allowedHosts: ['panel.local.test', '127.0.0.1', 'localhost'],
    stagingHosts: ['127.0.0.1', 'localhost'],
    startsAt: new Date((nowSec - 60) * 1000).toISOString(),
    expiresAt: new Date(exp * 1000).toISOString(),
    entitlementVersion: 1,
    activatedInstanceId: instanceId,
    edition: 'premium',
    capabilities: {
      singlePanelUser: true,
      singlePanelUserUnlimitedSites: true,
      webStackManagement: true,
      sslAndDnsManagement: true,
      backupsAndMonitoring: true,
      aiOperations: true,
      resellerAccounts: true,
      perSiteIsolatedUsers: true,
    },
  };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signatureB64 = crypto.sign(null, Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), privateKey).toString('base64url');
  const token = `${headerB64}.${payloadB64}.${signatureB64}`;

  const service = createLicenseEntitlementService({
    filePath: path.join(dir, 'license-entitlement.json'),
    publicKeyPem,
    publicKeyFile: '',
    publicOrigin: PUBLIC_ORIGIN,
    instanceId,
    development: true,
  });
  const activated = await service.activate({ token });
  assert.equal(activated.tier, 'premium');
  return service;
}

async function loginSession(baseUrl, { username, password, proxyToken }) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-yunpanel-proxy-token': proxyToken,
      'x-yunpanel-client-ip': '127.0.0.1',
      origin: PUBLIC_ORIGIN,
    },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login failed for ${username}: ${await res.clone().text()}`);
  const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookies.map((header) => header.split(';')[0]).join('; ');
  const payload = await res.json();
  const csrfToken = payload?.data?.csrfToken;
  assert.ok(cookie && csrfToken, `expected real session cookie + csrfToken for ${username}`);
  return {
    cookie,
    csrfToken,
    user: payload.data.user,
    getHeaders: () => ({
      cookie,
      'x-yunpanel-proxy-token': proxyToken,
      'x-yunpanel-client-ip': '127.0.0.1',
    }),
    mutateHeaders: (contentType = 'application/json') => ({
      cookie,
      'x-csrf-token': csrfToken,
      origin: PUBLIC_ORIGIN,
      'x-yunpanel-proxy-token': proxyToken,
      'x-yunpanel-client-ip': '127.0.0.1',
      ...(contentType ? { 'content-type': contentType } : {}),
    }),
  };
}

function createTempDiskSiteFileManager({ appStorageRoot, websiteRegistry }) {
  const toDisk = (pathname) => (pathname.startsWith(`${APP_STORAGE_PREFIX}/`)
    ? path.join(appStorageRoot, path.relative(APP_STORAGE_PREFIX, pathname))
    : pathname);
  const readCanonicalPath = async (pathname) => {
    const resolved = await fsp.realpath(toDisk(pathname));
    return resolved.startsWith(`${appStorageRoot}/`)
      ? path.join(APP_STORAGE_PREFIX, path.relative(appStorageRoot, resolved))
      : resolved;
  };
  const opened = new Map();
  const filesystem = {
    chmod: (pathname, mode) => fsp.chmod(toDisk(pathname), mode),
    link: (prev, next) => fsp.link(toDisk(prev), toDisk(next)),
    mkdir: (pathname, options) => fsp.mkdir(toDisk(pathname), options),
    readFile: (pathname, options) => fsp.readFile(toDisk(pathname), options),
    rename: (prev, next) => fsp.rename(toDisk(prev), toDisk(next)),
    rm: (pathname, options) => fsp.rm(toDisk(pathname), options),
    stat: (pathname, options) => fsp.stat(toDisk(pathname), options),
    lstat: (pathname) => fsp.lstat(toDisk(pathname)),
    readdir: (pathname, options) => fsp.readdir(toDisk(pathname), options),
    open: async (pathname, ...args) => {
      const handle = await fsp.open(toDisk(pathname), ...args);
      opened.set(handle.fd, pathname);
      return handle;
    },
    realpath: (pathname) => (pathname.startsWith('/proc/self/fd/')
      ? readCanonicalPath(opened.get(Number(path.basename(pathname))))
      : readCanonicalPath(pathname)),
  };
  const appLocks = new Map();
  return Object.freeze({
    async execute(websiteId, operation) {
      const website = await websiteRegistry.getWebsite(websiteId);
      if (!website) throw Object.assign(new Error('Website not found'), { code: 'website_not_found', status: 404 });
      const root = `${APP_STORAGE_PREFIX}/${website.applicationId.toLowerCase()}/current/public`;
      const prev = appLocks.get(website.applicationId) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(() => executeSiteFileOperation({ ...operation, root }, filesystem));
      appLocks.set(website.applicationId, run);
      try { return await run; }
      finally { if (appLocks.get(website.applicationId) === run) appLocks.delete(website.applicationId); }
    },
  });
}

async function setupRealStores(t) {
  const dir = makeTempDir(t);
  const proxyToken = randomBytes(32).toString('base64url');
  const masterKey = randomBytes(32).toString('hex');
  const authDir = path.join(dir, 'auth');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const authPath = path.join(authDir, 'auth.sqlite');

  const authStore = createAuthStore({ filePath: authPath, masterKey });
  t.after(() => authStore.close());
  const { token: setupToken } = authStore.issueSetupToken();
  await authStore.completeSetup({ setupToken, username: 'owneradmin', password: PASSWORD });
  const ownerLogin = await authStore.login({ username: 'owneradmin', password: PASSWORD });

  const serverRegistry = createServerRegistry({ filePath: path.join(dir, 'servers.json') });
  const localServer = await serverRegistry.createLocalServer({ hostname: 'panel.local.test', displayName: 'Local Host' });
  const serverId = localServer.id;
  const serverExists = async (id) => Boolean(await serverRegistry.getServer(id));

  const applicationRegistry = createApplicationRegistry({ filePath: path.join(dir, 'applications.json'), serverExists });
  await applicationRegistry.init();

  const websiteRegistry = createWebsiteRegistry({
    filePath: path.join(dir, 'websites.json'),
    serverExists,
    getApplication: (id) => applicationRegistry.getApplication(id),
  });
  await websiteRegistry.init();

  const domainRegistry = createDomainRegistry({
    filePath: path.join(dir, 'domains.json'),
    serverExists,
    getApplication: (id) => applicationRegistry.getApplication(id),
    getWebsite: (id) => websiteRegistry.getWebsite(id),
  });
  await domainRegistry.init();

  const databaseBindingRegistry = createDatabaseBindingRegistry({
    filePath: path.join(dir, 'db-bindings.json'),
    serverExists,
    getWebsite: (id) => websiteRegistry.getWebsite(id),
    getApplication: (id) => applicationRegistry.getApplication(id),
  });
  await databaseBindingRegistry.init();

  const licenseEntitlementService = await createSignedPremiumLicense(dir, serverId);
  const appStorageRoot = path.join(dir, 'apps-storage');
  mkdirSync(appStorageRoot, { recursive: true });

  async function createPhpWebsite(name, { targetServerId = serverId, withDir = false } = {}) {
    const app = await applicationRegistry.createPhpApplication({ serverId: targetServerId, name });
    const website = await websiteRegistry.createWebsite({
      serverId: targetServerId,
      name,
      applicationId: app.id,
      runtimeType: 'php',
    });
    let releasePublicDir = null;
    if (withDir) {
      releasePublicDir = path.join(appStorageRoot, app.id, 'current', 'public');
      mkdirSync(releasePublicDir, { recursive: true });
    }
    return { app, website, releasePublicDir };
  }

  return {
    dir,
    authPath,
    proxyToken,
    authStore,
    ownerToken: ownerLogin.token,
    serverId,
    serverRegistry,
    applicationRegistry,
    websiteRegistry,
    domainRegistry,
    databaseBindingRegistry,
    licenseEntitlementService,
    appStorageRoot,
    createPhpWebsite,
  };
}

test('1. SQLite legacy 7-column auth_customer_quotas migration upgrades idempotently with enforcement disabled by default', async (t) => {
  const dir = makeTempDir(t);
  const authDir = path.join(dir, 'auth');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const authPath = path.join(authDir, 'auth.sqlite');
  const masterKey = randomBytes(32).toString('hex');

  const bootstrap = createAuthStore({ filePath: authPath, masterKey });
  const { token: setupToken } = bootstrap.issueSetupToken();
  await bootstrap.completeSetup({ setupToken, username: 'owner-legacy', password: PASSWORD });
  const ownerLogin = await bootstrap.login({ username: 'owner-legacy', password: PASSWORD });
  const legacyCustomer = await bootstrap.hostingAccounts.createOwnerLogin(ownerLogin.token, ownerPolicy, {
    kind: 'customer',
    username: 'cust-legacy',
    password: PASSWORD,
    quotas: { maxWebsites: 2, maxDiskMb: 500, maxTrafficMb: 1000, maxDatabases: 1 },
  });
  bootstrap.close();

  const db = new DatabaseSync(authPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    DROP TABLE IF EXISTS auth_hosting_database_allocations;
    DROP TABLE auth_customer_quotas;
    CREATE TABLE auth_customer_quotas (
      customer_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_hosting_accounts(user_id) ON DELETE CASCADE,
      max_websites INTEGER CHECK(max_websites IS NULL OR (typeof(max_websites) = 'integer' AND max_websites >= 0)),
      max_disk_mb INTEGER CHECK(max_disk_mb IS NULL OR (typeof(max_disk_mb) = 'integer' AND max_disk_mb >= 0)),
      max_traffic_mb INTEGER CHECK(max_traffic_mb IS NULL OR (typeof(max_traffic_mb) = 'integer' AND max_traffic_mb >= 0)),
      max_databases INTEGER CHECK(max_databases IS NULL OR (typeof(max_databases) = 'integer' AND max_databases >= 0)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO auth_customer_quotas VALUES (?, 2, 500, 1000, 1, 1000, 1000)').run(legacyCustomer.id);
  db.close();

  const authStore = createAuthStore({ filePath: authPath, masterKey });
  t.after(() => authStore.close());

  const inspectDb = new DatabaseSync(authPath);
  t.after(() => inspectDb.close());
  const cols = new Set(inspectDb.prepare('PRAGMA table_info(auth_customer_quotas)').all().map((c) => c.name));
  assert.ok(cols.has('enforce_disk_quota'));
  assert.ok(cols.has('enforce_traffic_quota'));
  assert.equal(
    inspectDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_hosting_database_allocations'").get()?.name,
    'auth_hosting_database_allocations',
  );

  const row = inspectDb.prepare('SELECT enforce_disk_quota, enforce_traffic_quota FROM auth_customer_quotas WHERE customer_id = ?').get(legacyCustomer.id);
  assert.equal(row.enforce_disk_quota, 0);
  assert.equal(row.enforce_traffic_quota, 0);

  const custLogin = await authStore.login({ username: 'cust-legacy', password: PASSWORD });
  assert.deepEqual(custLogin.session.user.hosting.quotaEnforcement, {
    websites: true,
    databases: true,
    disk: false,
    traffic: false,
  });
  assert.deepEqual(authStore.hostingAccounts.listEnforcedTrafficCustomers(), []);

  assert.throws(
    () => validateCustomerQuotaEnforcement({ disk: true }, { quotas: { maxDiskMb: null, maxTrafficMb: 100 } }),
    (err) => err.code === 'invalid_customer_quotas' && err.status === 400,
  );
  assert.throws(
    () => validateCustomerQuotaEnforcement({ traffic: true }, { quotas: { maxDiskMb: 100, maxTrafficMb: null } }),
    (err) => err.code === 'invalid_customer_quotas' && err.status === 400,
  );
  assert.throws(
    () => validateCustomerQuotaEnforcement({ disk: 'yes' }, { quotas: { maxDiskMb: 100, maxTrafficMb: 100 } }),
    (err) => err.code === 'invalid_customer_quotas' && err.status === 400,
  );
  assert.throws(
    () => validateCustomerQuotaEnforcement({ unknown: true }, { quotas: { maxDiskMb: 100, maxTrafficMb: 100 } }),
    (err) => err.code === 'invalid_customer_quotas' && err.status === 400,
  );
  assert.deepEqual(
    validateCustomerQuotaEnforcement({ disk: false, traffic: false }, { quotas: { maxDiskMb: null, maxTrafficMb: null } }),
    { disk: false, traffic: false },
  );
});

test('2. Real createApp HTTP PATCH /quotas with Cookie/CSRF + signed Premium license: opt-in enable/rollback, null auto-reset, listEnforcedTrafficCustomers & Free Owner preservation', async (t) => {
  const env = await setupRealStores(t);
  const quotaEvents = [];

  const customer = await env.authStore.hostingAccounts.createOwnerLogin(env.ownerToken, ownerPolicy, {
    kind: 'customer',
    username: 'cust-optin',
    password: PASSWORD,
    quotas: { maxWebsites: 3, maxDiskMb: 256, maxTrafficMb: 1024, maxDatabases: 2 },
  });
  const { website: custSite } = await env.createPhpWebsite('optin-cust.test');
  const { website: ownerSite } = await env.createPhpWebsite('optin-owner.test');
  env.authStore.hostingAccounts.allocateCustomerSite(env.ownerToken, ownerPolicy, { customerId: customer.id, site: custSite });

  const listener = createAuthenticatedApi({
    store: env.authStore,
    publicOrigin: PUBLIC_ORIGIN,
    development: true,
    ownerMfaRequired: false,
    proxyToken: env.proxyToken,
    trustedProxyIps: '127.0.0.1',
    licenseEntitlementService: env.licenseEntitlementService,
    onCustomerQuotaUpdated: async (event) => { quotaEvents.push(event); },
    createHandler: () => createApp({
      registry: env.serverRegistry,
      localServerId: env.serverId,
      applicationRegistry: env.applicationRegistry,
      websiteRegistry: env.websiteRegistry,
      domainRegistry: env.domainRegistry,
      databaseBindingRegistry: env.databaseBindingRegistry,
      userAdminStore: env.authStore.users,
      authStore: env.authStore,
      licenseEntitlementService: env.licenseEntitlementService,
    }),
  });
  const server = await listenServer(http.createServer(listener));
  t.after(() => server.close());

  const owner = await loginSession(server.baseUrl, { username: 'owneradmin', password: PASSWORD, proxyToken: env.proxyToken });
  const cust = await loginSession(server.baseUrl, { username: 'cust-optin', password: PASSWORD, proxyToken: env.proxyToken });

  const patchQuotas = async (actor, body) => {
    const res = await fetch(`${server.baseUrl}/api/users/hosting/accounts/${customer.id}/quotas`, {
      method: 'PATCH',
      headers: actor.mutateHeaders(),
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  // Customer cannot self-modify quotas (403)
  const deniedSelf = await patchQuotas(cust, {
    revision: customer.revision,
    quotas: { maxWebsites: 99, maxDiskMb: 9999, maxTrafficMb: 9999, maxDatabases: 99 },
  });
  assert.equal(deniedSelf.status, 403);

  // Owner enables disk + traffic enforcement
  const enableRes = await patchQuotas(owner, {
    revision: customer.revision,
    quotas: { maxWebsites: 3, maxDiskMb: 256, maxTrafficMb: 1024, maxDatabases: 2 },
    quotaEnforcement: { disk: true, traffic: true },
  });
  assert.equal(enableRes.status, 200);
  assert.deepEqual(enableRes.json.data.account.quotaEnforcement, {
    websites: true,
    databases: true,
    disk: true,
    traffic: true,
  });
  assert.equal(quotaEvents.length, 1);
  assert.equal(quotaEvents[0].customerId, customer.id);
  assert.deepEqual(env.authStore.hostingAccounts.listEnforcedTrafficCustomers(), [{
    customerId: customer.id,
    maxTrafficMb: 1024,
    websiteIds: [custSite.id],
  }]);

  // Suspending panel login (hostSitesSuspended: false) MUST NOT remove the customer from enforced traffic blocking
  const suspendRes = await fetch(`${server.baseUrl}/api/users/hosting/accounts/${customer.id}/status`, {
    method: 'PATCH',
    headers: owner.mutateHeaders(),
    body: JSON.stringify({ revision: enableRes.json.data.account.revision, active: false }),
  });
  assert.equal(suspendRes.status, 200);
  assert.deepEqual(env.authStore.hostingAccounts.listEnforcedTrafficCustomers(), [{
    customerId: customer.id,
    maxTrafficMb: 1024,
    websiteIds: [custSite.id],
  }]);
  const resumeRes = await fetch(`${server.baseUrl}/api/users/hosting/accounts/${customer.id}/status`, {
    method: 'PATCH',
    headers: owner.mutateHeaders(),
    body: JSON.stringify({ revision: (await suspendRes.json()).data.account.revision, active: true }),
  });
  assert.equal(resumeRes.status, 200);
  const rev2 = (await resumeRes.json()).data.account.revision;

  // Reject disk: true when maxDiskMb is null
  const badRes = await patchQuotas(owner, {
    revision: rev2,
    quotas: { maxWebsites: 3, maxDiskMb: null, maxTrafficMb: 1024, maxDatabases: 2 },
    quotaEnforcement: { disk: true, traffic: true },
  });
  assert.equal(badRes.status, 400);
  assert.equal(badRes.json.error.code, 'invalid_customer_quotas');

  // Clearing maxDiskMb without explicit quotaEnforcement auto-resets disk: false, preserves traffic: true
  const clearDiskRes = await patchQuotas(owner, {
    revision: rev2,
    quotas: { maxWebsites: 3, maxDiskMb: null, maxTrafficMb: 1024, maxDatabases: 2 },
  });
  assert.equal(clearDiskRes.status, 200);
  assert.deepEqual(clearDiskRes.json.data.account.quotaEnforcement, {
    websites: true,
    databases: true,
    disk: false,
    traffic: true,
  });

  // Explicit rollback (traffic: false) removes customer from listEnforcedTrafficCustomers
  const rollbackRes = await patchQuotas(owner, {
    revision: clearDiskRes.json.data.account.revision,
    quotas: { maxWebsites: 3, maxDiskMb: null, maxTrafficMb: 1024, maxDatabases: 2 },
    quotaEnforcement: { traffic: false },
  });
  assert.equal(rollbackRes.status, 200);
  assert.deepEqual(env.authStore.hostingAccounts.listEnforcedTrafficCustomers(), []);

  // Free Owner site has no customer quotas enforced
  const ownerSiteRes = await fetch(`${server.baseUrl}/api/websites/${ownerSite.id}/consumption`, {
    headers: owner.getHeaders(),
  });
  assert.equal(ownerSiteRes.status, 200);
  const ownerCons = (await ownerSiteRes.json()).data;
  assert.equal(ownerCons.customerId, null);
  assert.equal(ownerCons.metrics.databases.enforcedLimit, null);
  assert.equal(ownerCons.metrics.diskSpaceMb.enforcedLimit, null);
  assert.equal(ownerCons.metrics.trafficMb.enforcedLimit, null);
});

test('3. SQLite database quota coordinator with real databaseBindingRegistry: multi-server counting, concurrent two-site TOCTOU lock & unbind capacity restore', async (t) => {
  const env = await setupRealStores(t);

  const { token: enrollToken } = await env.serverRegistry.issueEnrollmentToken();
  const enrolled = await env.serverRegistry.enrollServer({
    token: enrollToken,
    hostname: 'worker-node-2.local.test',
    displayName: 'Remote Node 2',
  });
  const server2 = enrolled.server ?? enrolled;

  const customer = await env.authStore.hostingAccounts.createOwnerLogin(env.ownerToken, ownerPolicy, {
    kind: 'customer',
    username: 'cust-db-coord',
    password: PASSWORD,
    quotas: { maxWebsites: 5, maxDiskMb: 512, maxTrafficMb: 2048, maxDatabases: 1 },
  });

  const { website: siteA } = await env.createPhpWebsite('coord-site-a.test');
  const { website: siteB } = await env.createPhpWebsite('coord-site-b.test');
  const { website: siteServer2 } = await env.createPhpWebsite('coord-site-s2.test', { targetServerId: server2.id });
  const { website: ownerSite } = await env.createPhpWebsite('coord-owner-site.test');

  env.authStore.hostingAccounts.allocateCustomerSite(env.ownerToken, ownerPolicy, { customerId: customer.id, site: siteA });
  env.authStore.hostingAccounts.allocateCustomerSite(env.ownerToken, ownerPolicy, { customerId: customer.id, site: siteB });
  env.authStore.hostingAccounts.allocateCustomerSite(env.ownerToken, ownerPolicy, { customerId: customer.id, site: siteServer2 });

  const coordinator = createCustomerDatabaseQuotaCoordinator({
    hostingAccounts: env.authStore.hostingAccounts,
    databaseBindingRegistry: env.databaseBindingRegistry,
  });

  const bindViaCoordinator = (website, databaseName) => coordinator.reserveAndRun({
    websiteId: website.id,
    serverId: website.serverId,
    databaseName,
    operationId: `db-bind:${randomUUID()}`,
  }, () => env.databaseBindingRegistry.bindDatabase({
    serverId: website.serverId,
    databaseName,
    websiteId: website.id,
    applicationId: website.applicationId,
    confirmation: `bind-database:${website.serverId}:${databaseName}:${website.id}`,
  }));

  // 1. Concurrent two-site race (siteA + siteB under maxDatabases=1) -> strictly ONE succeeds, ONE throws 409 customer_quota_exceeded
  const settled = await Promise.allSettled([
    bindViaCoordinator(siteA, 'race_db_a'),
    bindViaCoordinator(siteB, 'race_db_b'),
  ]);
  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  const rejected = settled.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'strictly ONE concurrent DB bind across two sites must succeed');
  assert.equal(rejected.length, 1, 'strictly ONE concurrent DB bind must fail');
  assert.equal(rejected[0].reason.code, 'customer_quota_exceeded');
  assert.equal(rejected[0].reason.status, 409);

  // 2. Unbind restores capacity cleanly
  const winningBinding = fulfilled[0].value;
  await env.databaseBindingRegistry.unbindDatabase(winningBinding.id, {
    expectedRevision: winningBinding.revision,
    confirmation: `unbind-database:${winningBinding.id}:${winningBinding.revision}`,
  });

  // 3. Multi-server counting: binding on server2 MUST block binding on local server1 under maxDatabases=1!
  const remoteBinding = await bindViaCoordinator(siteServer2, 'remote_s2_db');
  assert.equal(remoteBinding.serverId, server2.id);

  await assert.rejects(
    () => bindViaCoordinator(siteA, 'local_s1_db'),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // Unbinding the remote server DB restores local capacity
  await env.databaseBindingRegistry.unbindDatabase(remoteBinding.id, {
    expectedRevision: remoteBinding.revision,
    confirmation: `unbind-database:${remoteBinding.id}:${remoteBinding.revision}`,
  });
  const localBinding = await bindViaCoordinator(siteA, 'local_s1_db');
  assert.equal(localBinding.databaseName, 'local_s1_db');

  // 4. Owner sites remain exempt from customer database limits
  const ownerBind1 = await bindViaCoordinator(ownerSite, 'owner_free_1');
  const ownerBind2 = await bindViaCoordinator(ownerSite, 'owner_free_2');
  assert.equal(ownerBind1.databaseName, 'owner_free_1');
  assert.equal(ownerBind2.databaseName, 'owner_free_2');
});

test('4. Real createApp HTTP site-file-http managed disk write quota: concurrent cross-site race, sparse & hard-link bypass blocked, re-edit, DELETE, shared_root_overlap 503, rollback & Owner exemption', async (t) => {
  const env = await setupRealStores(t);
  const customer = await env.authStore.hostingAccounts.createOwnerLogin(env.ownerToken, ownerPolicy, {
    kind: 'customer',
    username: 'cust-disk-http',
    password: PASSWORD,
    quotas: { maxWebsites: 3, maxDiskMb: 1, maxTrafficMb: null, maxDatabases: null },
  });

  const { website: siteA, releasePublicDir: siteAPub } = await env.createPhpWebsite('disk-site-a.test', { withDir: true });
  const { website: siteB } = await env.createPhpWebsite('disk-site-b.test', { withDir: true });
  const { website: ownerSite } = await env.createPhpWebsite('disk-owner-site.test', { withDir: true });

  env.authStore.hostingAccounts.allocateCustomerSite(env.ownerToken, ownerPolicy, { customerId: customer.id, site: siteA });
  env.authStore.hostingAccounts.allocateCustomerSite(env.ownerToken, ownerPolicy, { customerId: customer.id, site: siteB });

  const siteFileManager = createTempDiskSiteFileManager({
    appStorageRoot: env.appStorageRoot,
    websiteRegistry: env.websiteRegistry,
  });

  const listener = createAuthenticatedApi({
    store: env.authStore,
    publicOrigin: PUBLIC_ORIGIN,
    development: true,
    ownerMfaRequired: false,
    proxyToken: env.proxyToken,
    trustedProxyIps: '127.0.0.1',
    licenseEntitlementService: env.licenseEntitlementService,
    createHandler: () => createApp({
      registry: env.serverRegistry,
      localServerId: env.serverId,
      applicationRegistry: env.applicationRegistry,
      websiteRegistry: env.websiteRegistry,
      domainRegistry: env.domainRegistry,
      databaseBindingRegistry: env.databaseBindingRegistry,
      siteFileManager,
      userAdminStore: env.authStore.users,
      authStore: env.authStore,
      licenseEntitlementService: env.licenseEntitlementService,
      siteConsumptionPathContractOptions: { applicationRoot: env.appStorageRoot },
      siteConsumptionAllowCurrentUserWithoutSetpriv: true,
    }),
  });
  const server = await listenServer(http.createServer(listener));
  t.after(() => server.close());

  const owner = await loginSession(server.baseUrl, { username: 'owneradmin', password: PASSWORD, proxyToken: env.proxyToken });
  const cust = await loginSession(server.baseUrl, { username: 'cust-disk-http', password: PASSWORD, proxyToken: env.proxyToken });

  const upload = (actor, websiteId, filePath, buf) => fetch(
    `${server.baseUrl}/api/websites/${websiteId}/files/upload?path=${encodeURIComponent(filePath)}`,
    { method: 'PUT', headers: actor.mutateHeaders('application/octet-stream'), body: buf },
  );

  const deleteFile = (actor, websiteId, filePath) => fetch(
    `${server.baseUrl}/api/websites/${websiteId}/files`,
    {
      method: 'DELETE',
      headers: actor.mutateHeaders(),
      body: JSON.stringify({ path: filePath, confirmation: `delete:${websiteId}:${filePath}` }),
    },
  );

  // Default opt-in disabled -> upload > 1 MiB passes
  assert.equal((await upload(cust, siteA.id, 'pre-optin.bin', Buffer.alloc(1200 * 1024, 0x41))).status, 201);
  assert.equal((await deleteFile(cust, siteA.id, 'pre-optin.bin')).status, 200);

  // Enable opt-in disk enforcement via real PATCH /quotas
  const enableDisk = await fetch(`${server.baseUrl}/api/users/hosting/accounts/${customer.id}/quotas`, {
    method: 'PATCH',
    headers: owner.mutateHeaders(),
    body: JSON.stringify({
      revision: customer.revision,
      quotas: { maxWebsites: 3, maxDiskMb: 1, maxTrafficMb: null, maxDatabases: null },
      quotaEnforcement: { disk: true },
    }),
  });
  assert.equal(enableDisk.status, 200);
  const revAfterEnable = (await enableDisk.json()).data.account.revision;

  // Concurrent two-site HTTP PUT /files/upload race (700 KiB + 700 KiB > 1 MiB) -> strictly ONE 201, ONE 409
  const chunk700k = Buffer.alloc(700 * 1024, 0x42);
  const [raceA, raceB] = await Promise.all([
    upload(cust, siteA.id, 'race-a.bin', chunk700k),
    upload(cust, siteB.id, 'race-b.bin', chunk700k),
  ]);
  const [bodyA, bodyB] = await Promise.all([raceA.json(), raceB.json()]);
  const results = [
    { status: raceA.status, body: bodyA, siteId: siteA.id, filePath: 'race-a.bin' },
    { status: raceB.status, body: bodyB, siteId: siteB.id, filePath: 'race-b.bin' },
  ];
  const winner = results.find((r) => r.status === 201);
  const loser = results.find((r) => r.status === 409);
  assert.ok(winner && loser, `expected one 201 and one 409, got ${raceA.status}, ${raceB.status}`);
  assert.equal(loser.body.error.code, 'customer_disk_quota_exceeded');
  assert.equal((await deleteFile(cust, winner.siteId, winner.filePath)).status, 200);

  // Same-file re-edit under quota (same size, shrink, net delta within limit) succeeds; over-limit growth fails 409
  assert.equal((await upload(cust, siteA.id, 'base-fill.bin', Buffer.alloc(820 * 1024, 0x43))).status, 201);
  const text100k = 'A'.repeat(100 * 1024);
  assert.equal((await upload(cust, siteA.id, 'notes.txt', Buffer.from(text100k, 'utf8'))).status, 201);
  const sha1 = createHash('sha256').update(text100k, 'utf8').digest('hex');

  const sameSizeEdit = await fetch(`${server.baseUrl}/api/websites/${siteA.id}/files/text`, {
    method: 'PUT',
    headers: cust.mutateHeaders(),
    body: JSON.stringify({ path: 'notes.txt', content: 'B'.repeat(100 * 1024), expectedSha256: sha1 }),
  });
  assert.equal(sameSizeEdit.status, 200);
  const sha2 = (await sameSizeEdit.json()).data.sha256;

  const shrinkEdit = await fetch(`${server.baseUrl}/api/websites/${siteA.id}/files/text`, {
    method: 'PUT',
    headers: cust.mutateHeaders(),
    body: JSON.stringify({ path: 'notes.txt', content: 'C'.repeat(40 * 1024), expectedSha256: sha2 }),
  });
  assert.equal(shrinkEdit.status, 200);
  const sha3 = (await shrinkEdit.json()).data.sha256;

  const deltaWithinEdit = await fetch(`${server.baseUrl}/api/websites/${siteA.id}/files/text`, {
    method: 'PUT',
    headers: cust.mutateHeaders(),
    body: JSON.stringify({ path: 'notes.txt', content: 'D'.repeat(140 * 1024), expectedSha256: sha3 }),
  });
  assert.equal(deltaWithinEdit.status, 200);
  const sha4 = (await deltaWithinEdit.json()).data.sha256;

  // Growing notes.txt to 220 KiB alongside 820 KiB base-fill.bin exceeds 1024 KiB -> 409 customer_disk_quota_exceeded
  const overGrowthEdit = await fetch(`${server.baseUrl}/api/websites/${siteA.id}/files/text`, {
    method: 'PUT',
    headers: cust.mutateHeaders(),
    body: JSON.stringify({ path: 'notes.txt', content: 'E'.repeat(220 * 1024), expectedSha256: sha4 }),
  });
  assert.equal(overGrowthEdit.status, 409);
  assert.equal((await overGrowthEdit.json()).error.code, 'customer_disk_quota_exceeded');
  assert.equal((await deleteFile(cust, siteA.id, 'notes.txt')).status, 200);
  assert.equal((await deleteFile(cust, siteA.id, 'base-fill.bin')).status, 200);

  // Sparse 4 MiB file overwrite MUST be blocked (409)
  const sparsePath = path.join(siteAPub, 'sparse.bin');
  const sparseHandle = await fsp.open(sparsePath, 'w');
  await sparseHandle.truncate(4 * 1024 * 1024);
  await sparseHandle.close();

  const sparseOverwrite = await upload(cust, siteA.id, 'sparse.bin', Buffer.alloc(2 * 1024 * 1024, 0x55));
  assert.equal(sparseOverwrite.status, 409);
  assert.equal((await sparseOverwrite.json()).error.code, 'customer_disk_quota_exceeded');
  assert.equal((await deleteFile(cust, siteA.id, 'sparse.bin')).status, 200);

  // Hard-linked pair overwrite MUST be blocked (409)
  const hardA = path.join(siteAPub, 'hard-a.bin');
  const hardB = path.join(siteAPub, 'hard-b.bin');
  writeFileSync(hardA, Buffer.alloc(600 * 1024, 0x61));
  await fsp.link(hardA, hardB);

  const hardLinkOverwrite = await upload(cust, siteA.id, 'hard-a.bin', Buffer.alloc(600 * 1024, 0x62));
  assert.equal(hardLinkOverwrite.status, 409);
  assert.equal((await hardLinkOverwrite.json()).error.code, 'customer_disk_quota_exceeded');

  // DELETE succeeds while over quota and frees capacity
  assert.equal((await deleteFile(cust, siteA.id, 'hard-b.bin')).status, 200);
  assert.equal((await deleteFile(cust, siteA.id, 'hard-a.bin')).status, 200);
  assert.equal((await upload(cust, siteA.id, 'after-delete.bin', Buffer.alloc(200 * 1024, 0x63))).status, 201);
  assert.equal((await deleteFile(cust, siteA.id, 'after-delete.bin')).status, 200);

  // Shared/nested site root (shared_root_overlap) fails closed HTTP 503 customer_disk_quota_unmeasurable
  await env.domainRegistry.createDomain({
    serverId: env.serverId,
    primaryDomain: 'overlap-root.example.test',
    targetType: 'static',
    target: { root: siteAPub },
  });
  const overlapUpload = await upload(cust, siteA.id, 'blocked-overlap.bin', Buffer.alloc(16 * 1024, 0x64));
  assert.equal(overlapUpload.status, 503);
  assert.equal((await overlapUpload.json()).error.code, 'customer_disk_quota_unmeasurable');

  // Rollback (disk: false) re-allows uploads; Owner site is exempt
  const rollbackDisk = await fetch(`${server.baseUrl}/api/users/hosting/accounts/${customer.id}/quotas`, {
    method: 'PATCH',
    headers: owner.mutateHeaders(),
    body: JSON.stringify({
      revision: revAfterEnable,
      quotas: { maxWebsites: 3, maxDiskMb: 1, maxTrafficMb: null, maxDatabases: null },
      quotaEnforcement: { disk: false },
    }),
  });
  assert.equal(rollbackDisk.status, 200);
  assert.equal((await upload(cust, siteA.id, 'post-rollback.bin', Buffer.alloc(1200 * 1024, 0x65))).status, 201);
  assert.equal((await upload(owner, ownerSite.id, 'owner-large.bin', Buffer.alloc(2 * 1024 * 1024, 0x70))).status, 201);
});

test('5. Real createApp HTTP GET /consumption contract: enforced databases, managed_write_guard disk scope even when nativeHardQuotaSupported=true, and legacy vhost trafficGuardReady=false honesty', async (t) => {
  const env = await setupRealStores(t);
  const sitesDir = path.join(env.dir, 'sites-enabled');
  mkdirSync(sitesDir, { recursive: true });

  // Real temp /proc/mounts file with prjquota so inspectNativeDiskQuotaSupport genuinely parses nativeHardQuotaSupported=true
  const tempProcMounts = path.join(env.dir, 'proc-mounts');
  writeFileSync(tempProcMounts, '/dev/vda1 / ext4 rw,relatime,prjquota 0 0\n', 'utf8');

  const customer = await env.authStore.hostingAccounts.createOwnerLogin(env.ownerToken, ownerPolicy, {
    kind: 'customer',
    username: 'cust-contract',
    password: PASSWORD,
    quotas: { maxWebsites: 3, maxDiskMb: 500, maxTrafficMb: 2048, maxDatabases: 2 },
  });
  const { website: site } = await env.createPhpWebsite('legacy-contract.example.test', { withDir: true });
  env.authStore.hostingAccounts.allocateCustomerSite(env.ownerToken, ownerPolicy, { customerId: customer.id, site });

  // Create an active pre-upgrade applied vhost file (NO $yunpanel_traffic_blocked guard) for read-only discovery
  const domain = await env.domainRegistry.createDomain({
    serverId: env.serverId,
    primaryDomain: 'legacy-contract.example.test',
    targetType: 'php',
    target: { applicationId: site.applicationId },
    websiteId: site.id,
  });
  const configName = `yunpanel-${nginxConfigFileName(domain.primaryDomain)}`;
  const legacyVhost = [
    'server {',
    '  listen 80;',
    `  server_name ${domain.primaryDomain};`,
    '  access_log /var/log/nginx/legacy-contract.example.test.access.log;',
    '}',
    '',
  ].join('\n');
  writeFileSync(path.join(sitesDir, configName), legacyVhost, 'utf8');
  const checksum = createHash('sha256').update(legacyVhost).digest('hex');
  await env.domainRegistry.markStaged(domain.id, { checksum, configName });
  await env.domainRegistry.markApplied(domain.id, { checksum });

  const websiteTrafficCoordinator = createWebsiteTrafficCoordinator({
    domainRegistry: env.domainRegistry,
    websiteRegistry: env.websiteRegistry,
    hostingAccounts: env.authStore.hostingAccounts,
    sitesDir,
  });

  const listener = createAuthenticatedApi({
    store: env.authStore,
    publicOrigin: PUBLIC_ORIGIN,
    development: true,
    ownerMfaRequired: false,
    proxyToken: env.proxyToken,
    trustedProxyIps: '127.0.0.1',
    licenseEntitlementService: env.licenseEntitlementService,
    createHandler: () => createApp({
      registry: env.serverRegistry,
      localServerId: env.serverId,
      applicationRegistry: env.applicationRegistry,
      websiteRegistry: env.websiteRegistry,
      domainRegistry: env.domainRegistry,
      databaseBindingRegistry: env.databaseBindingRegistry,
      userAdminStore: env.authStore.users,
      authStore: env.authStore,
      licenseEntitlementService: env.licenseEntitlementService,
      websiteTrafficCoordinator,
      diskQuotaCapabilityLookup: () => inspectNativeDiskQuotaSupport({
        targetPath: '/var/www/yunpanel',
        procMountsPath: tempProcMounts,
      }),
      siteConsumptionPathContractOptions: { applicationRoot: env.appStorageRoot },
      siteConsumptionAllowCurrentUserWithoutSetpriv: true,
    }),
  });
  const server = await listenServer(http.createServer(listener));
  t.after(() => server.close());

  const owner = await loginSession(server.baseUrl, { username: 'owneradmin', password: PASSWORD, proxyToken: env.proxyToken });
  const cust = await loginSession(server.baseUrl, { username: 'cust-contract', password: PASSWORD, proxyToken: env.proxyToken });

  // Enable opt-in disk + traffic enforcement on customer
  const enableRes = await fetch(`${server.baseUrl}/api/users/hosting/accounts/${customer.id}/quotas`, {
    method: 'PATCH',
    headers: owner.mutateHeaders(),
    body: JSON.stringify({
      revision: customer.revision,
      quotas: { maxWebsites: 3, maxDiskMb: 500, maxTrafficMb: 2048, maxDatabases: 2 },
      quotaEnforcement: { disk: true, traffic: true },
    }),
  });
  assert.equal(enableRes.status, 200);

  const consRes = await fetch(`${server.baseUrl}/api/websites/${site.id}/consumption`, {
    headers: cust.getHeaders(),
  });
  assert.equal(consRes.status, 200);
  const { data: report } = await consRes.json();

  // 1. Databases shows enforcedLimit = maxDatabases
  assert.equal(report.metrics.databases.definedLimit, 2);
  assert.equal(report.metrics.databases.enforcedLimit, 2);
  assert.equal(report.metrics.databases.enforced, true);
  assert.equal(report.metrics.databases.enforcementScope, 'customer_account_databases');

  // 2. Disk ALWAYS shows managed_write_guard scope even when nativeHardQuotaSupported=true
  assert.equal(report.metrics.diskSpaceMb.definedLimit, 500);
  assert.equal(report.metrics.diskSpaceMb.enforcedLimit, 500);
  assert.equal(report.metrics.diskSpaceMb.enforced, true);
  assert.equal(report.metrics.diskSpaceMb.enforcementMode, 'managed_write_guard');
  assert.equal(report.metrics.diskSpaceMb.enforcementScope, 'managed_write_guard');
  assert.equal(report.metrics.diskSpaceMb.nativeHardQuotaSupported, true);
  assert.equal(report.metrics.diskSpaceMb.nativeQuotaCapability, 'native_quota_available');

  // 3. Pre-upgrade legacy vhost (trafficGuardReady=false) MUST NOT populate enforcedLimit
  assert.equal(report.metrics.trafficMb.definedLimit, 2048);
  assert.equal(report.metrics.trafficMb.enforcedLimit, null);
  assert.equal(report.metrics.trafficMb.enforced, false);
  assert.equal(report.metrics.trafficMb.trafficEnforcementRequested, true);
  assert.equal(report.metrics.trafficMb.trafficGuardReady, false);
  assert.equal(report.metrics.trafficMb.blocked, false);
  assert.equal(report.metrics.trafficMb.accountingMode, 'legacy_applied_access_log');
  assert.equal(report.metrics.trafficMb.includesStaticAssets, false);
});
