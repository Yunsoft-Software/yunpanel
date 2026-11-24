#!/usr/bin/env node
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { createPanelServer } from '../apps/web/server.js';
import { createApp } from '../apps/api/src/app.js';
import { createApplicationRegistry } from '../apps/api/src/application-registry.js';
import { createAuthenticatedApi } from '../apps/api/src/auth-http.js';
import { createAuthStore } from '../apps/api/src/auth-store.js';
import { createBackupOperationRegistry } from '../apps/api/src/backup-operation-registry.js';
import { createCertificateRegistry } from '../apps/api/src/certificate-registry.js';
import { createDatabaseBindingRegistry } from '../apps/api/src/database-binding-registry.js';
import { createDockerComposeProjectRegistry } from '../apps/api/src/docker-compose-project-registry.js';
import { createDomainRegistry } from '../apps/api/src/domain-registry.js';
import { createJobRegistry } from '../apps/api/src/job-registry.js';
import {
  computePublicKeyId,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  PREMIUM_CAPABILITIES,
} from '../apps/api/src/license-entitlement-verifier.js';
import { createLicenseEntitlementService } from '../apps/api/src/license-entitlement-service.js';
import { createMailDomainRegistry } from '../apps/api/src/mail-domain-registry.js';
import { createMailboxRegistry } from '../apps/api/src/mailbox-registry.js';
import { createPowerDnsAuthoritativeService } from '../apps/api/src/powerdns-authoritative-service.js';
import { createPowerDnsSecretRegistry } from '../apps/api/src/powerdns-secret-registry.js';
import { createRcloneRemoteRegistry } from '../apps/api/src/rclone-remote-registry.js';
import { createResticRepositoryRegistry } from '../apps/api/src/restic-repository-registry.js';
import { createServerDnsIdentityRegistry } from '../apps/api/src/server-dns-identity-registry.js';
import { createServerRegistry } from '../apps/api/src/server-registry.js';
import { createSiteFileManager } from '../apps/api/src/site-file-manager.js';
import { executeSiteFileOperation } from '../apps/api/src/site-file-worker.js';
import { createSiteMutationLock } from '../apps/api/src/site-mutation-lock.js';
import { createWebsitePhpToolsService } from '../apps/api/src/website-php-tools-service.js';
import { createWebsiteRegistry } from '../apps/api/src/website-registry.js';
import {
  createPhpCliToolManager,
  createPhpFpmSiteManager,
  createRcloneManager,
  createResticManager,
} from '@yunpanel/host-runtime';

const REPO_ROOT = process.cwd();
const VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const BUNDLE_DIR = path.join(REPO_ROOT, 'docs', `yunpanel-docs-${VERSION}`);
const ASSETS_TR_DIR = path.join(BUNDLE_DIR, 'assets', 'tr');
const LOCAL_REPORT_DIR = path.join(REPO_ROOT, '.local', 'website-docs');
const SOURCE_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const kid = computePublicKeyId(spkiDer);
  return { privateKey, publicKeyPem, kid };
}

function signEntitlementToken(privateKey, kid, {
  licenseId,
  billingModel = 'monthly_term',
  periodMonths = 12,
  campaignCode = null,
  domain = 'panel.ornek.example',
  instanceId,
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + periodMonths * 30 * 86400;
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
    tier: 'premium',
    status: 'active',
    billingModel,
    periodMonths,
    startsAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: new Date(exp * 1000).toISOString(),
    domain,
    normalizedDomain: domain,
    allowedHosts: [domain, `www.${domain}`],
    stagingHosts: ['localhost', '127.0.0.1'],
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

function createRealLocalFileManager({ websiteRegistry, localServerId, rootMap, passwdEntries }) {
  function mapPath(targetPath) {
    for (const [managed, realDir] of rootMap.entries()) {
      if (targetPath === managed) return realDir;
      if (targetPath.startsWith(`${managed}/`)) {
        return path.join(realDir, targetPath.slice(managed.length + 1));
      }
    }
    return targetPath;
  }
  function reversePath(realPathValue) {
    for (const [managed, realDir] of rootMap.entries()) {
      if (realPathValue === realDir) return managed;
      if (realPathValue.startsWith(`${realDir}/`)) {
        return `${managed}/${realPathValue.slice(realDir.length + 1)}`;
      }
    }
    return realPathValue;
  }
  const openedPaths = new Map();
  const deps = {
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
      if (p.startsWith('/proc/self/fd/')) {
        return openedPaths.get(Number(p.split('/').at(-1))) ?? '/unknown-descriptor';
      }
      const mapped = mapPath(p);
      if (mapped !== p) {
        const resolved = await fs.realpath(mapped);
        return reversePath(resolved);
      }
      return fs.realpath(p);
    },
    rename: (oldP, newP) => fs.rename(mapPath(oldP), mapPath(newP)),
    rm: (p, options) => fs.rm(mapPath(p), options),
    stat: (p) => fs.stat(mapPath(p)),
  };

  return createSiteFileManager({
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
    runWorker: async ({ request }) => executeSiteFileOperation(request, deps),
  });
}

async function setTheme(page, theme) {
  await page.evaluate((nextTheme) => {
    const pref = { theme: nextTheme, density: 'comfortable' };
    try {
      window.localStorage.setItem('yunpanel.ui.preferences.v1', JSON.stringify(pref));
    } catch {}
    document.documentElement.dataset.wsTheme = nextTheme;
  }, theme);
}

async function waitStable(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(350);
}

async function sha256File(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const webRoot = path.join(REPO_ROOT, 'apps', 'web', 'dist');
  if (!existsSync(path.join(webRoot, 'index.html'))) {
    throw new Error('apps/web/dist/index.html missing. Run npm run build first.');
  }

  await fs.mkdir(ASSETS_TR_DIR, { recursive: true });
  await fs.mkdir(LOCAL_REPORT_DIR, { recursive: true });

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-docs-capture-'));
  const servers = [];
  const stores = [];
  let browser = null;
  const previousEnvKeyFile = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
  const previousEnvKeyPem = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

  const ownerPassword = 'DocsDemoOwnerPass!2026';
  const resellerPassword = 'DocsDemoResellerPass!2026';
  const customerPassword = 'DocsDemoCustomerPass!2026';
  const siteMgrPassword = 'DocsDemoSiteMgrPass!2026';
  const readOnlyPassword = 'DocsDemoReadOnlyPass!2026';

  const captured = [];
  const localeChecks = [];
  const pageErrors = [];

  try {
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;

    const keys = generateEd25519KeyPair();
    const publicKeyPath = path.join(tmpDir, 'entitlement-public.pem');
    writeFileSync(publicKeyPath, keys.publicKeyPem, { mode: 0o600 });
    process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = publicKeyPath;

    const proxyToken = crypto.randomBytes(32).toString('base64url');
    const masterKey = crypto.randomBytes(32).toString('hex');

    // --- Instance A: Main Full-Stack Panel (Premium for full feature screens, switchable to Free/Campaign for license screens) ---
    const webPort = await reserveLoopbackPort();
    const publicOrigin = `http://127.0.0.1:${webPort}`;

    const authStore = createAuthStore({ filePath: path.join(tmpDir, 'auth.sqlite'), masterKey });
    stores.push(authStore);
    const initialSetup = authStore.issueSetupToken();
    await authStore.completeSetup({
      setupToken: initialSetup.token,
      username: 'yonetici',
      password: ownerPassword,
      email: 'yonetici@ornek.example',
    });

    const serverRegistry = createServerRegistry({ filePath: path.join(tmpDir, 'servers.json') });
    const localServer = await serverRegistry.createLocalServer({
      hostname: 'panel.ornek.example',
      displayName: 'Ornek Sunucu 01',
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

    const certificateRegistry = createCertificateRegistry({ filePath: path.join(tmpDir, 'certs.json') });
    await certificateRegistry.init();
    const jobRegistry = createJobRegistry({ filePath: path.join(tmpDir, 'jobs.json') });
    await jobRegistry.init();

    const serverDnsIdentityRegistry = createServerDnsIdentityRegistry({
      filePath: path.join(tmpDir, 'dns-identity.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    });
    await serverDnsIdentityRegistry.init();
    const dnsSettings = {
      publicIpv4: '203.0.113.10',
      publicIpv6: null,
      ns1: { hostname: 'ns1.ornek.example', ipv4: '203.0.113.10', ipv6: null, local: true },
      ns2: { hostname: 'ns2.ornek.example', ipv4: '203.0.113.11', ipv6: null, local: false },
      soa: { rname: 'hostmaster.ornek.example', refresh: 3600, retry: 900, expire: 1209600, minimum: 300, ttl: 300 },
      dnssecDefault: false,
      secondaryDns: [],
    };
    const dnsPlan = await serverDnsIdentityRegistry.preview({ serverId: localServerId, settings: dnsSettings });
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

    const mailDomainRegistry = createMailDomainRegistry({
      filePath: path.join(tmpDir, 'mail-domains.json'),
      getWebDomain: async (id) => domainRegistry.getDomain(id),
    });
    await mailDomainRegistry.init();
    const mailboxRegistry = createMailboxRegistry({
      filePath: path.join(tmpDir, 'mailboxes.json'),
      getMailDomain: async (id) => mailDomainRegistry.getMailDomain(id),
    });
    await mailboxRegistry.init();

    const databaseBindingRegistry = createDatabaseBindingRegistry({
      filePath: path.join(tmpDir, 'db-bindings.json'),
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
      getWebsite: async (id) => websiteRegistry.getWebsite(id),
      getApplication: async (id) => applicationRegistry.getApplication(id),
    });
    await databaseBindingRegistry.init();

    const dockerComposeProjectRegistry = createDockerComposeProjectRegistry({
      filePath: path.join(tmpDir, 'docker-compose.json'),
      masterKey,
      serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    });
    await dockerComposeProjectRegistry.init();

    const resticManager = createResticManager();
    const rcloneManager = createRcloneManager();
    const resticRepositoryRegistry = createResticRepositoryRegistry({
      filePath: path.join(tmpDir, 'restic-repos.json'),
      resticManager,
      masterKey,
    });
    await resticRepositoryRegistry.init();
    const rcloneRemoteRegistry = createRcloneRemoteRegistry({
      filePath: path.join(tmpDir, 'rclone-remotes.json'),
      rcloneManager,
      masterKey,
    });
    await rcloneRemoteRegistry.init();
    const backupOperationRegistry = createBackupOperationRegistry({
      filePath: path.join(tmpDir, 'backup-ops.json'),
    });
    await backupOperationRegistry.init();
    const siteMutationLock = createSiteMutationLock({ root: path.join(tmpDir, 'locks') });
    const websitePhpToolsService = createWebsitePhpToolsService({
      websiteRegistry,
      applicationRegistry,
      phpCliToolManager: createPhpCliToolManager(),
      phpFpmSiteManager: createPhpFpmSiteManager(),
      withApplicationLock: siteMutationLock.withApplicationLock,
    });

    // License service starts with 3-month Campaign Premium active for rich feature screenshots,
    // and we also have a dedicated Free license service instance for the Free license screenshot!
    const licenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license', 'entitlement.json'),
      publicKeyFile: publicKeyPath,
      publicOrigin,
      instanceId: localServerId,
      masterKey,
      development: true,
    });
    const campaignToken = signEntitlementToken(keys.privateKey, keys.kid, {
      licenseId: 'camp_docs_3m_01',
      billingModel: 'promotional_term',
      periodMonths: 3,
      campaignCode: 'YUNSOFT-3M-2026',
      domain: 'panel.ornek.example',
      instanceId: localServerId,
    });
    await licenseService.activate({ token: campaignToken });

    // Demo non-sensitive websites: root PHP site + blog subdomain + Node.js API site
    const phpApp = await applicationRegistry.createPhpApplication({
      serverId: localServerId,
      name: 'ornek-kurumsal-php',
    });
    const phpWebsite = await websiteRegistry.createWebsite({
      serverId: localServerId,
      name: 'ornek.example',
      applicationId: phpApp.id,
    });
    const phpDomain = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'ornek.example',
      targetType: 'php',
      target: { applicationId: phpApp.id },
      websiteId: phpWebsite.id,
    });

    const subPhpApp = await applicationRegistry.createPhpApplication({
      serverId: localServerId,
      name: 'blog-ornek-php',
    });
    const subPhpWebsite = await websiteRegistry.createWebsite({
      serverId: localServerId,
      name: 'blog.ornek.example',
      applicationId: subPhpApp.id,
    });
    const subPhpDomain = await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'blog.ornek.example',
      parentDomainId: phpDomain.id,
      targetType: 'php',
      target: { applicationId: subPhpApp.id },
      websiteId: subPhpWebsite.id,
    });

    const nodeApp = await applicationRegistry.createNodeApplication({
      serverId: localServerId,
      name: 'api-servisi-node',
      repositoryUrl: 'https://github.com/yunsoft-example/demo-api',
      branch: 'main',
      runtime: { port: 41050, healthPath: '/health' },
    });
    const nodeWebsite = await websiteRegistry.createWebsite({
      serverId: localServerId,
      name: 'api.ornek.example',
      applicationId: nodeApp.id,
    });
    await domainRegistry.createDomain({
      serverId: localServerId,
      primaryDomain: 'api.ornek.example',
      parentDomainId: phpDomain.id,
      targetType: 'proxy',
      target: { upstreamPort: 41050 },
      websiteId: nodeWebsite.id,
    });

    // Seed sanitized Mail domain (ornek.example)
    await mailDomainRegistry.createMailDomain({
      domainName: 'ornek.example',
      webDomainId: phpDomain.id,
      managementMode: 'local',
    });

    // Real sanitized files on disk for ornek.example (with subdomains/blog hierarchy)
    await fs.mkdir(path.join(tmpDir, 'sites', phpWebsite.id), { recursive: true });
    const phpRealDir = await fs.realpath(path.join(tmpDir, 'sites', phpWebsite.id));
    await fs.mkdir(path.join(phpRealDir, 'public'), { recursive: true });
    await fs.mkdir(path.join(phpRealDir, 'subdomains', 'blog'), { recursive: true });
    await fs.writeFile(
      path.join(phpRealDir, 'index.html'),
      '<!doctype html>\n<html lang="tr">\n  <head>\n    <meta charset="utf-8" />\n    <title>Ornek Kurumsal Site</title>\n  </head>\n  <body>\n    <h1>YunPanel ile Barindiriliyor</h1>\n  </body>\n</html>\n',
      'utf8',
    );
    await fs.writeFile(path.join(phpRealDir, 'style.css'), 'body { margin: 0; font-family: system-ui, sans-serif; }\n', 'utf8');
    await fs.writeFile(path.join(phpRealDir, 'subdomains', 'blog', 'index.php'), '<?php\necho "Ornek Blog";\n', 'utf8');

    const rootMap = new Map([[phpWebsite.documentRoot, phpRealDir]]);
    const passwdEntries = [`${phpWebsite.unixUser}:x:1001:1001:Ornek PHP:${phpRealDir}:/usr/sbin/nologin`];
    const siteFileManager = createRealLocalFileManager({ websiteRegistry, localServerId, rootMap, passwdEntries });

    // Demo roles (sanitized)
    const ownerLogin = await authStore.login({ username: 'yonetici', password: ownerPassword });
    const reqMgmt = (session) => session;
    const resellerAcc = await authStore.users.hostingAccounts.createOwnerLogin(ownerLogin.token, reqMgmt, {
      kind: 'reseller',
      username: 'bayi-ornek',
      password: resellerPassword,
      limits: { maxCustomers: 10, maxWebsites: 25 },
    });
    const customerAcc = await authStore.users.hostingAccounts.createOwnerLogin(ownerLogin.token, reqMgmt, {
      kind: 'customer',
      username: 'musteri-ornek',
      password: customerPassword,
      resellerId: resellerAcc.id,
      quotas: { maxWebsites: 5, maxDatabases: 10, maxDiskMb: 2048, maxTrafficMb: 50000 },
    });
    authStore.users.hostingAccounts.allocateCustomerSite(ownerLogin.token, reqMgmt, {
      customerId: customerAcc.id,
      site: phpWebsite,
    });
    authStore.users.hostingAccounts.allocateCustomerSite(ownerLogin.token, reqMgmt, {
      customerId: customerAcc.id,
      site: subPhpWebsite,
    });
    await authStore.users.create(ownerLogin.token, reqMgmt, {
      username: 'salt-okunur',
      password: readOnlyPassword,
      role: 'read_only',
      active: true,
    });
    await authStore.users.createSiteManager({
      username: 'site-uzmani',
      password: siteMgrPassword,
      websiteId: phpWebsite.id,
      websiteLookup: async (id) => Boolean(await websiteRegistry.getWebsite(id)),
    });
    authStore.revokeSession(ownerLogin.token);

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
        certificateRegistry,
        jobRegistry,
        siteFileManager,
        serverDnsIdentityRegistry,
        powerDnsSecretRegistry,
        powerDnsAuthoritativeService,
        mailDomainRegistry,
        mailboxRegistry,
        databaseBindingRegistry,
        dockerComposeProjectRegistry,
        resticRepositoryRegistry,
        resticManager,
        rcloneRemoteRegistry,
        rcloneManager,
        backupOperationRegistry,
        siteMutationLock,
        websitePhpToolsService,
        authorizeWebsiteActor: async (actor) => actor,
        userAdminStore: authStore.users,
        authStore,
        licenseEntitlementService: licenseService,
      }),
    });
    const apiServer = await listenServer(http.createServer(apiListener));
    servers.push(apiServer);

    const webServer = await listenServer(
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
    servers.push(webServer);

    // --- Instance B: Fresh First-Time Setup Server (setupRequired=true) ---
    const setupWebPort = await reserveLoopbackPort();
    const setupOrigin = `http://127.0.0.1:${setupWebPort}`;
    const setupStore = createAuthStore({ filePath: path.join(tmpDir, 'setup-auth.sqlite'), masterKey });
    stores.push(setupStore);
    setupStore.issueSetupToken();
    const setupApi = await listenServer(http.createServer(createAuthenticatedApi({
      store: setupStore,
      publicOrigin: setupOrigin,
      development: true,
      ownerMfaRequired: true,
      proxyToken,
      trustedProxyIps: '127.0.0.1',
      createHandler: () => createApp({ authStore: setupStore }),
    })));
    servers.push(setupApi);
    const setupWeb = await listenServer(createPanelServer({
      allowedClientIps: '127.0.0.1',
      apiHost: '127.0.0.1',
      apiPort: setupApi.port,
      publicOrigin: setupOrigin,
      proxyToken,
      trustedProxyIps: '127.0.0.1',
      webRoot,
    }), setupWebPort);
    servers.push(setupWeb);

    // --- Instance C: Free-Tier License Panel (to capture Free license screen with 3-month Premium offer) ---
    const freeWebPort = await reserveLoopbackPort();
    const freeOrigin = `http://127.0.0.1:${freeWebPort}`;
    const freeAuthStore = createAuthStore({ filePath: path.join(tmpDir, 'free-auth.sqlite'), masterKey });
    stores.push(freeAuthStore);
    const freeSetup = freeAuthStore.issueSetupToken();
    await freeAuthStore.completeSetup({
      setupToken: freeSetup.token,
      username: 'yonetici',
      password: ownerPassword,
    });
    const freeLicenseService = createLicenseEntitlementService({
      filePath: path.join(tmpDir, 'license-free', 'entitlement.json'),
      publicKeyFile: publicKeyPath,
      publicOrigin: freeOrigin,
      instanceId: localServerId,
      masterKey,
      development: true,
    });
    const freeApi = await listenServer(http.createServer(createAuthenticatedApi({
      store: freeAuthStore,
      publicOrigin: freeOrigin,
      development: true,
      ownerMfaRequired: false,
      proxyToken,
      trustedProxyIps: '127.0.0.1',
      licenseEntitlementService: freeLicenseService,
      createHandler: () => createApp({
        registry: serverRegistry,
        localServerId,
        userAdminStore: freeAuthStore.users,
        authStore: freeAuthStore,
        licenseEntitlementService: freeLicenseService,
      }),
    })));
    servers.push(freeApi);
    const freeWeb = await listenServer(createPanelServer({
      allowedClientIps: '127.0.0.1',
      apiHost: '127.0.0.1',
      apiPort: freeApi.port,
      publicOrigin: freeOrigin,
      proxyToken,
      trustedProxyIps: '127.0.0.1',
      webRoot,
    }), freeWebPort);
    servers.push(freeWeb);

    browser = await chromium.launch({ headless: true });

    async function capturePng(page, { id, fileName, route, theme, role, alt, caption, fullPage = true }) {
      await waitStable(page);
      const metrics = await page.evaluate(() => ({
        overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        h1: document.querySelector('h1')?.textContent?.trim() || null,
        h2: document.querySelector('h2')?.textContent?.trim() || null,
      }));
      const outPath = path.join(ASSETS_TR_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage });
      const digest = await sha256File(outPath);
      captured.push({
        id,
        product: 'yunpanel',
        version: VERSION,
        locale: 'tr',
        file: `assets/tr/${fileName}`,
        sha256: digest,
        alt,
        caption,
        capturedFrom: `route=${route} role=${role} theme=${theme} viewport=1366x840 browserLocale=tr-TR uiLanguage=tr commit=${SOURCE_COMMIT}`,
        sanitized: true,
        metrics,
      });
      console.log(`captured ${fileName} overflowX=${metrics.overflowX} sha256=${digest.slice(0, 12)}`);
    }

    async function verifyBrowserLocale(browserLocale, routesToVerify) {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 840 }, locale: browserLocale });
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(e.message));

      // 1. Setup screen check
      await p.goto(`${setupOrigin}/`, { waitUntil: 'networkidle' });
      await p.getByRole('heading', { name: 'Owner hesabını oluşturun' }).waitFor({ timeout: 10_000 });
      const setupMetrics = await p.evaluate(() => ({
        overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        heading: document.querySelector('#auth-heading')?.textContent?.trim() || null,
        hasOfferCard: Boolean(document.querySelector('[data-setup-premium-offer="true"]')),
      }));
      localeChecks.push({ browserLocale, route: '/ (setup)', uiLanguage: 'tr', ...setupMetrics, errors: [...errs] });

      // 2. Sign in to main panel and check common screens
      await p.goto(`${publicOrigin}/websites`, { waitUntil: 'networkidle' });
      await p.locator('input[name="username"]').fill('yonetici');
      await p.locator('input[name="password"]').fill(ownerPassword);
      await p.getByRole('button', { name: 'Giriş yap', exact: true }).click();
      await p.getByRole('navigation', { name: 'Panel bölümleri' }).waitFor({ timeout: 15_000 });

      for (const route of routesToVerify) {
        await p.goto(`${publicOrigin}${route}`, { waitUntil: 'networkidle' });
        await waitStable(p);
        const m = await p.evaluate(() => ({
          overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          heading: document.querySelector('h1')?.textContent?.trim() || document.querySelector('h2')?.textContent?.trim() || null,
        }));
        localeChecks.push({ browserLocale, route, uiLanguage: 'tr', ...m, errors: [...errs] });
      }
      await ctx.close();
      if (errs.length > 0) {
        pageErrors.push({ browserLocale, errs });
      }
    }

    // === 1. Capture First-Time Setup (dark & light) and Login ===
    {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 840 }, locale: 'tr-TR' });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => pageErrors.push({ screen: 'setup', message: e.message }));

      await p.goto(`${setupOrigin}/`, { waitUntil: 'networkidle' });
      await p.getByRole('heading', { name: 'Owner hesabını oluşturun' }).waitFor({ timeout: 10_000 });
      await setTheme(p, 'dark');
      await capturePng(p, {
        id: 'first-time-setup-dark',
        fileName: '01-first-time-setup-dark.png',
        route: '/ (setupRequired=true)',
        theme: 'dark',
        role: 'anonymous',
        alt: 'YunPanel ilk kurulum ekrani ve istege bagli 3 aylik ucretsiz Premium teklifi (koyu tema)',
        caption: 'YunPanel 0.3.0 ilk kurulumda Owner hesabi olusturma formu ve istege bagli 3 aylik ucretsiz Premium yonlendirmesi.',
      });

      await setTheme(p, 'light');
      await capturePng(p, {
        id: 'first-time-setup-light',
        fileName: '02-first-time-setup-light.png',
        route: '/ (setupRequired=true)',
        theme: 'light',
        role: 'anonymous',
        alt: 'YunPanel ilk kurulum ekrani ve istege bagli 3 aylik ucretsiz Premium teklifi (acik tema)',
        caption: 'YunPanel 0.3.0 ilk kurulum ekraninin acik tema gorunumu.',
      });

      await p.goto(`${publicOrigin}/login`, { waitUntil: 'networkidle' });
      await setTheme(p, 'dark');
      await capturePng(p, {
        id: 'login-screen',
        fileName: '03-login.png',
        route: '/login',
        theme: 'dark',
        role: 'anonymous',
        alt: 'YunPanel giris ekrani',
        caption: 'YunPanel 0.3.0 guvenli yonetici giris ekrani.',
      });
      await ctx.close();
    }

    // === 2. Capture Main Authenticated Owner Screens ===
    {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 840 }, locale: 'tr-TR' });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => pageErrors.push({ screen: 'owner', message: e.message }));

      await p.goto(`${publicOrigin}/websites`, { waitUntil: 'networkidle' });
      await setTheme(p, 'dark');
      await p.locator('input[name="username"]').fill('yonetici');
      await p.locator('input[name="password"]').fill(ownerPassword);
      await p.getByRole('button', { name: 'Giriş yap', exact: true }).click();
      await p.getByRole('navigation', { name: 'Panel bölümleri' }).waitFor({ timeout: 15_000 });
      await setTheme(p, 'dark');

      await capturePng(p, {
        id: 'websites-hierarchy',
        fileName: '04-websites-hierarchy.png',
        route: '/websites',
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel Web Siteleri ana ekrani ve alan adi hiyerarsisi',
        caption: 'Web Siteleri listesinde ana alan adi, alt alan adlari ve hizli arac erisimi.',
      });

      await p.goto(`${publicOrigin}/websites/new`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'new-website-form',
        fileName: '05-new-website.png',
        route: '/websites/new',
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel yeni web sitesi olusturma ekrani',
        caption: 'Yeni site ve alt alan adi olusturma sihirbazi.',
      });

      await p.goto(`${publicOrigin}/websites/${phpDomain.id}`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'site-detail-overview',
        fileName: '06-site-overview.png',
        route: `/websites/${phpDomain.id}`,
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel site genel bakis ve arac kartlari',
        caption: 'Site detay ekraninda sik kullanilan araclar ve gelistirici araclari.',
      });

      await p.goto(`${publicOrigin}/users`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'users-and-roles',
        fileName: '07-users-and-roles.png',
        route: '/users',
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel kullanicilar ve roller yonetim ekrani',
        caption: 'Owner, Bayi, Musteri, Site Yoneticisi ve Salt Okunur panel hesap listesi.',
      });

      await p.goto(`${publicOrigin}/websites/${phpDomain.id}/ssl`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'site-ssl',
        fileName: '08-site-ssl.png',
        route: `/websites/${phpDomain.id}/ssl`,
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel SSL/TLS sertifika yonetim ekrani',
        caption: 'Site bazli SSL/TLS sertifika durumu ve yenileme ekrani.',
      });

      await p.goto(`${publicOrigin}/websites/${phpDomain.id}/dns`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'site-dns',
        fileName: '09-site-dns.png',
        route: `/websites/${phpDomain.id}/dns`,
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel DNS kayitlari ekrani',
        caption: 'Site DNS bolge yonetimi ve kayit ekrani.',
      });

      await p.goto(`${publicOrigin}/websites/${phpDomain.id}/files?file=index.html`, { waitUntil: 'networkidle' });
      await p.locator('textarea').waitFor({ timeout: 10_000 }).catch(() => {});
      await capturePng(p, {
        id: 'site-files-editor',
        fileName: '11-files-editor.png',
        route: `/websites/${phpDomain.id}/files?file=index.html`,
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel site dosya yoneticisi ve kod editoru',
        caption: 'Site Dosya Yoneticisi icinde subdomains klasoru ve dahili kod editoru.',
      });

      await p.goto(`${publicOrigin}/docker`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'docker-compose-market',
        fileName: '12-docker-compose.png',
        route: '/docker',
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel Docker, Compose Stack ve Uygulama Marketi ekrani',
        caption: 'Docker Compose projeleri, port proxy ve tek tikla uygulama katalogu.',
      });

      await p.goto(`${publicOrigin}/databases`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'databases-workspace',
        fileName: '13-databases.png',
        route: '/databases',
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel Veritabanlari yonetim ekrani',
        caption: 'MariaDB veritabani envanteri ve phpMyAdmin erisim arayuzu.',
      });

      await p.goto(`${publicOrigin}/mail`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'mail-workspace',
        fileName: '14-mail-domains.png',
        route: '/mail',
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel Posta yonetim ekrani',
        caption: 'Posta alan adlari, posta kutulari ve DKIM/teslimat yonetimi.',
      });

      await p.goto(`${publicOrigin}/websites/${phpDomain.id}/backup`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'site-backup',
        fileName: '15-site-backup.png',
        route: `/websites/${phpDomain.id}/backup`,
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel Yedekleme ve Geri Yukleme ekrani',
        caption: 'Site bazli Restic yedekleme, zamanlama ve geri yukleme arayuzu.',
      });

      await p.goto(`${publicOrigin}/settings?section=license`, { waitUntil: 'networkidle' });
      await p.getByText('Kampanya · 3 ay').waitFor({ timeout: 10_000 });
      await capturePng(p, {
        id: 'license-campaign-active',
        fileName: '17-license-campaign-active.png',
        route: '/settings?section=license (campaign active)',
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel Lisans ekrani aktif 3 aylik kampanya Premium durumu',
        caption: '3 aylik kampanya Premium hakki etkinlestirilmis lisans ozeti ve yetenek tablosu.',
      });

      await p.goto(`${publicOrigin}/tools-settings`, { waitUntil: 'networkidle' });
      await capturePng(p, {
        id: 'tools-settings-overview',
        fileName: '18-tools-settings.png',
        route: '/tools-settings',
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel Araclar ve Ayarlar dizini',
        caption: 'Sunucu, guvenlik, guncellemeler, lisans ve tanilama araclarinin merkezi dizini.',
      });

      await ctx.close();
    }

    // === 3. Capture Free-Tier License Screen (with 3-month Premium offer & Docs link) ===
    {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 840 }, locale: 'tr-TR' });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => pageErrors.push({ screen: 'free-license', message: e.message }));

      await p.goto(`${freeOrigin}/settings?section=license`, { waitUntil: 'networkidle' });
      await setTheme(p, 'dark');
      await p.locator('input[name="username"]').fill('yonetici');
      await p.locator('input[name="password"]').fill(ownerPassword);
      await p.getByRole('button', { name: 'Giriş yap', exact: true }).click();
      await p.getByRole('heading', { name: 'Lisans durumu' }).waitFor({ timeout: 15_000 });
      await p.locator('[data-license-premium-offer="true"]').waitFor({ timeout: 10_000 });
      await setTheme(p, 'dark');
      await capturePng(p, {
        id: 'license-free-offer',
        fileName: '16-license-free-offer.png',
        route: '/settings?section=license (free tier)',
        theme: 'dark',
        role: 'owner',
        alt: 'YunPanel Lisans ekrani ucretsiz surum ve 3 aylik ucretsiz Premium teklifi',
        caption: 'Ucretsiz surumde lisans durumu, 3 aylik ucretsiz Premium teklifi ve etkinlestirme formu.',
      });
      await ctx.close();
    }

    // === 4. Cross-Locale Browser Verification (tr-TR AND en-US on common screens) ===
    const commonRoutes = [
      '/websites',
      '/websites/new',
      `/websites/${phpDomain.id}`,
      '/users',
      `/websites/${phpDomain.id}/ssl`,
      `/websites/${phpDomain.id}/dns`,
      `/websites/${phpDomain.id}/wordpress`,
      `/websites/${phpDomain.id}/files`,
      '/docker',
      '/databases',
      '/mail',
      `/websites/${phpDomain.id}/backup`,
      '/settings?section=license',
      '/tools-settings',
    ];
    await verifyBrowserLocale('tr-TR', commonRoutes);
    await verifyBrowserLocale('en-US', commonRoutes);

    const report = {
      product: 'yunpanel',
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      capturedAt: new Date().toISOString(),
      uiSupportedLocales: ['tr'],
      browserLocalesVerified: ['tr-TR', 'en-US'],
      pageErrors,
      screenshots: captured,
      localeChecks,
    };

    const reportPath = path.join(LOCAL_REPORT_DIR, `capture-report-${VERSION}.json`);
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`DONE: ${captured.length} PNGs, ${localeChecks.length} locale checks, ${pageErrors.length} pageErrors -> ${reportPath}`);
    if (pageErrors.length > 0) {
      process.exitCode = 1;
    }
    const overflows = [...captured.filter((s) => s.metrics.overflowX > 0), ...localeChecks.filter((c) => c.overflowX > 0)];
    if (overflows.length > 0) {
      console.error('Horizontal overflow detected:', JSON.stringify(overflows, null, 2));
      process.exitCode = 1;
    }
  } finally {
    if (previousEnvKeyFile === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE = previousEnvKeyFile;
    if (previousEnvKeyPem === undefined) delete process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM;
    else process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM = previousEnvKeyPem;
    if (browser) await browser.close();
    for (const s of servers) await s.close();
    for (const st of stores) st.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
