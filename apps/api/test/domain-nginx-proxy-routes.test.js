import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDockerComposeObserver,
  createDockerComposeValidator,
} from '@yunpanel/host-runtime';
import { createOperationEnvelope, OPERATIONS } from '@yunpanel/protocol';
import {
  renderPassengerSiteConfig,
  renderPhpSiteConfig,
  renderStaticSiteConfig,
} from '@yunpanel/config-templates';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createApplicationRuntimeBindingRegistry } from '../src/application-runtime-binding-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { createApp as createCoreApp } from '../src/core-app.js';
import { createDockerComposeApiHandler } from '../src/docker-compose-api-handler.js';
import { createDockerComposeEnvironmentRegistry } from '../src/docker-compose-environment-registry.js';
import { createDockerComposeOperationsService } from '../src/docker-compose-operations.js';
import {
  createDockerComposeProjectRegistry,
  DockerComposeProjectRegistryError,
} from '../src/docker-compose-project-registry.js';
import { createDockerComposeRemoval } from '../src/docker-compose-removal.js';
import { DockerPleskCatalogError, resolveDockerProxyRule } from '../src/docker-plesk-catalog.js';
import { createDockerRegistryCredentialRegistry } from '../src/docker-registry-credential-registry.js';
import {
  createDomainHandler,
  createDomainUpdateHandler,
  createDomainUpdatePreviewHandler,
} from '../src/domain-http.js';
import { domainNginxSettingsForTarget } from '../src/domain-nginx-settings.js';
import {
  assertOwnerProxyRouteAccess,
  assertProjectUpdatePreservesProxyRoutes,
  isOwnerManagementAuth,
  requireOwnerDockerAccess,
} from '../src/domain-proxy-routes.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDomainStageTargetJobRegistry } from '../src/domain-stage-target-job-registry.js';
import { hostingWebsiteDigest } from '../src/hosting-site-allocation-store.js';
import { createJobRegistry } from '../src/job-registry.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';
import { createApp as createManagementApp } from '../src/management-app.js';
import { createOwnerMfaPolicy } from '../src/owner-mfa-policy.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const ORIGIN = 'http://127.0.0.1:5173';
const PASSWORD = 'test-slice-a-strong-password-2026!';

async function resolveRealDockerCommand() {
  for (const candidate of ['/usr/bin/docker', '/usr/local/bin/docker']) {
    try {
      await access(candidate);
      return { binary: candidate, composeBinary: null };
    } catch {
      // check next path
    }
  }
  try {
    await access('/opt/homebrew/lib/docker/cli-plugins/docker-compose');
    return {
      binary: '/opt/homebrew/bin/docker',
      composeBinary: '/opt/homebrew/lib/docker/cli-plugins/docker-compose',
    };
  } catch {
    return null;
  }
}

const REAL_DOCKER = await resolveRealDockerCommand();

function createRealComposeValidator(rootDir) {
  assert.ok(REAL_DOCKER, 'Real docker compose binary must be available for Compose validation tests');
  return createDockerComposeValidator({
    root: path.join(rootDir, 'compose-validation'),
    accessFn: (candidate) => (candidate === '/usr/local/bin/docker' ? access(REAL_DOCKER.composeBinary ?? REAL_DOCKER.binary) : access(candidate)),
    execFn: (_file, args, options) => new Promise((resolve, reject) => {
      const bin = REAL_DOCKER.composeBinary && args[0] === 'compose' ? REAL_DOCKER.composeBinary : REAL_DOCKER.binary;
      const execArgs = REAL_DOCKER.composeBinary && args[0] === 'compose' ? args.slice(1) : args;
      execFile(
        bin,
        execArgs,
        { ...options, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    }),
  });
}

async function createRealFixture(t, {
  ownerMfaRequired = false,
  siteMutationLockOverride = undefined,
  seedProjectsFile = null,
} = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-proxy-routes-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const masterKey = randomBytes(32);

  // Real SQLite AuthStore
  const authStore = createAuthStore({
    filePath: path.join(rootDir, 'auth.sqlite'),
    masterKey,
  });
  t.after(() => authStore.close());

  const setup = authStore.issueSetupToken();
  await authStore.completeSetup({ setupToken: setup.token, username: 'owner', password: PASSWORD });
  const ownerSetupLogin = await authStore.login({ username: 'owner', password: PASSWORD });
  const ownerPolicy = createOwnerMfaPolicy({ store: authStore, required: false }).requireManagement;

  // Real ServerRegistry
  const serverRegistry = createServerRegistry({ filePath: path.join(rootDir, 'servers.json') });
  await serverRegistry.init();
  const localServer = await serverRegistry.createLocalServer({ hostname: 'panel.example.com', displayName: 'Local Panel' });
  const serverId = localServer.id;

  const siteMutationLock = siteMutationLockOverride !== undefined
    ? siteMutationLockOverride
    : createSiteMutationLock({ root: path.join(rootDir, 'locks') });
  const baseJobRegistry = createJobRegistry({
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });

  let domainRegistryRef = null;
  let jobRegistryRef = null;

  const projectsFilePath = path.join(rootDir, 'docker-projects.json');
  const validateDockerCompose = createRealComposeValidator(rootDir);
  if (typeof seedProjectsFile === 'function') {
    await seedProjectsFile({
      rootDir,
      projectsFilePath,
      masterKey,
      serverId,
      validateDockerCompose,
    });
  }

  const projectRegistry = createDockerComposeProjectRegistry({
    filePath: projectsFilePath,
    masterKey,
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    beforeUpdateProject: ({ current, next }) => assertProjectUpdatePreservesProxyRoutes({
      project: current,
      nextServices: next.services,
      domainRegistry: domainRegistryRef,
      jobRegistry: jobRegistryRef,
      ErrorClass: DockerComposeProjectRegistryError,
    }),
  });
  await projectRegistry.init();

  const environmentRegistry = createDockerComposeEnvironmentRegistry({
    filePath: path.join(rootDir, 'docker-env.json'),
    masterKey,
    projectExists: async (id) => Boolean(await projectRegistry.getProject(id)),
  });
  await environmentRegistry.init();

  const credentialRegistry = createDockerRegistryCredentialRegistry({
    filePath: path.join(rootDir, 'docker-creds.json'),
    masterKey,
    projectExists: async (id) => Boolean(await projectRegistry.getProject(id)),
  });
  await credentialRegistry.init();

  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(rootDir, 'applications.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();

  const runtimeBindingRegistry = createApplicationRuntimeBindingRegistry({
    filePath: path.join(rootDir, 'runtime-bindings.json'),
  });
  await runtimeBindingRegistry.init();

  const websiteRegistry = createWebsiteRegistry({
    filePath: path.join(rootDir, 'websites.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getApplication: async (id) => applicationRegistry.getApplication(id),
    getDockerComposeProject: async (id) => projectRegistry.getProject(id),
  });
  await websiteRegistry.init();

  const domainRegistry = createDomainRegistry({
    filePath: path.join(rootDir, 'domains.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
    siteMutationLock,
  });
  await domainRegistry.init();
  domainRegistryRef = domainRegistry;

  const jobRegistry = createDomainStageTargetJobRegistry({
    registry: baseJobRegistry,
    domainRegistry,
    websiteRegistry,
    dockerComposeProjectRegistry: projectRegistry,
    applicationRegistry,
    runtimeBindingRegistry,
    siteMutationLock,
  });
  jobRegistryRef = jobRegistry;

  // Real host-runtime observer (validateDockerCompose already created above)
  const observer = createDockerComposeObserver();

  const removal = createDockerComposeRemoval({
    projectRegistry,
    environmentRegistry,
    credentialRegistry,
    websiteRegistry,
    domainRegistry,
    jobRegistry,
    observer,
  });
  const operationsService = createDockerComposeOperationsService({
    projectRegistry,
    environmentRegistry,
    credentialRegistry,
    jobRegistry,
    inspectRemoval: removal.inspect,
  });

  // Create real static application, website & domain
  const application = await applicationRegistry.createApplication({
    serverId,
    name: 'App Static',
    repositoryUrl: 'https://github.com/yunpanel/static-site.git',
    branch: 'main',
    build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
  });
  const website = await websiteRegistry.createWebsite({
    serverId,
    name: 'App Site',
    runtimeType: 'static',
    applicationId: application.id,
  });
  const domain = await domainRegistry.createDomain({
    serverId,
    websiteId: website.id,
    primaryDomain: 'app.example.com',
    aliases: ['www.app.example.com'],
    targetType: 'static',
    target: { root: website.documentRoot, spaFallback: true },
    httpsMode: 'off',
  });

  // Create real reseller, customer (attached to website via real siteAllocations), site_manager, read_only
  const resellerUser = await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'reseller',
    password: PASSWORD,
    role: 'site_manager',
    websiteIds: [],
  });
  authStore.users.hostingAccounts.registerReseller(ownerSetupLogin.token, ownerPolicy, {
    userId: resellerUser.id,
    expectedUserRevision: resellerUser.revision,
    limits: { maxCustomers: 5, maxWebsites: 5 },
  });

  const customerUser = await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'customer',
    password: PASSWORD,
    role: 'site_manager',
    websiteIds: [],
  });
  authStore.users.hostingAccounts.registerCustomer(ownerSetupLogin.token, ownerPolicy, {
    userId: customerUser.id,
    expectedUserRevision: customerUser.revision,
    resellerId: resellerUser.id,
  });
  const siteAllocPayload = {
    operationId: '33333333-3333-4333-8333-333333333333',
    websiteId: website.id,
    customerId: customerUser.id,
    serverId,
    intentDigest: 'a'.repeat(64),
    websiteDigest: hostingWebsiteDigest(website),
  };
  authStore.users.hostingAccounts.siteAllocations.reserve(ownerSetupLogin.token, ownerPolicy, siteAllocPayload);
  authStore.users.hostingAccounts.siteAllocations.complete(ownerSetupLogin.token, ownerPolicy, siteAllocPayload, website);

  await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'site_manager',
    password: PASSWORD,
    role: 'site_manager',
    websiteIds: [website.id],
  });
  await authStore.users.create(ownerSetupLogin.token, ownerPolicy, {
    username: 'read_only',
    password: PASSWORD,
    role: 'read_only',
  });

  // Real createAuthenticatedApi + real createDockerComposeApiHandler + real createManagementApp
  const origin = ownerMfaRequired ? 'https://panel.example.test' : ORIGIN;
  const listener = createAuthenticatedApi({
    store: authStore,
    publicOrigin: origin,
    development: !ownerMfaRequired,
    ownerMfaRequired,
    createHandler: () => createDockerComposeApiHandler({
      runtime: {
        projectRegistry,
        environmentRegistry,
        credentialRegistry,
        operationsService,
        observer,
        validateDockerCompose,
      },
      domainRegistry,
      jobRegistry,
      siteMutationLock,
      localServerId: serverId,
      baseHandler: createManagementApp({
        registry: serverRegistry,
        domainRegistry,
        websiteRegistry,
        applicationRegistry,
        runtimeBindingRegistry,
        jobRegistry,
        dockerComposeProjectRegistry: projectRegistry,
        userAdminStore: authStore.users,
        siteMutationLock,
        localServerId: serverId,
      }),
    }),
  });

  const server = http.createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function loginAs(username) {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    assert.equal(loginRes.status, 200, `Expected login 200 for ${username}`);
    const setCookies = loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get('set-cookie')].filter(Boolean);
    const cookieHeader = setCookies.map((entry) => entry.split(';')[0]).join('; ');
    assert.ok(cookieHeader.includes('yunpanel_session='), `Expected session cookie for ${username}`);
    const sessionRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie: cookieHeader },
    });
    assert.equal(sessionRes.status, 200);
    const sessionBody = await sessionRes.json();
    const csrfToken = sessionBody.data.csrfToken;
    assert.ok(csrfToken, `Expected CSRF token for ${username}`);
    return {
      username,
      cookie: cookieHeader,
      csrfToken,
      async api(method, urlPath, body) {
        const headers = {
          cookie: cookieHeader,
          origin,
          ...(method !== 'GET' && method !== 'HEAD' ? { 'x-csrf-token': csrfToken } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        };
        const res = await fetch(`${baseUrl}${urlPath}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, json };
      },
    };
  }

  return {
    rootDir,
    serverId,
    serverRegistry,
    baseUrl,
    website,
    domain,
    websiteRegistry,
    applicationRegistry,
    runtimeBindingRegistry,
    domainRegistry,
    projectRegistry,
    jobRegistry,
    baseJobRegistry,
    operationsService,
    removal,
    siteMutationLock,
    validateDockerCompose,
    loginAs,
  };
}

const COMPOSE_INITIAL = [
  'services:',
  '  api:',
  '    image: node:22-alpine',
  '    ports:',
  '      - "127.0.0.1:13000:3000/tcp"',
  '  worker:',
  '    image: redis:7-alpine',
  '    ports:',
  '      - "127.0.0.1:16379:6379/tcp"',
  '',
].join('\n');

test('Owner resolves proxy rule by domainId via real auth/CSRF, updates domain with proxyRoutes + disjoint protectedPaths, stages via real protocol, and renders exact Nginx config', async (t) => {
  const fx = await createRealFixture(t);
  const owner = await fx.loginAs('owner');

  // 1. Create Compose project validated by real docker compose config --format json
  const created = await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'backend_api',
    document: COMPOSE_INITIAL,
  });
  assert.equal(created.status, 201);
  const project = created.json.data.project;

  // 2. Resolve proxy rule using domainId (verifies domainRegistry wiring into createDockerComposeApiHandler)
  const resolved = await owner.api('POST', '/api/docker/proxy-rules/resolve', {
    domainId: fx.domain.id,
    projectId: project.id,
    serviceName: 'api',
    innerPort: 3000,
    urlPath: '/api',
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json.data.hostname, 'app.example.com');
  assert.equal(resolved.json.data.upstreamHost, '127.0.0.1');
  assert.equal(resolved.json.data.upstreamPort, 13000);

  const proxyRoute = {
    path: '/api',
    projectId: project.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  };

  // 3. Preview and apply update with proxyRoutes + disjoint protectedPaths (/admin/)
  const changes = {
    nginxSettings: {
      ...fx.domain.nginxSettings,
      protectedPaths: [{ path: '/admin/', key: '0123456789abcdef' }],
      proxyRoutes: [proxyRoute],
    },
  };
  const previewRes = await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes });
  assert.equal(previewRes.status, 200);
  const preview = previewRes.json.data;
  assert.ok(preview.impact.nginxSettings.changedFields.includes('proxyRoutes'));

  const patchRes = await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(patchRes.status, 200);
  assert.deepEqual(patchRes.json.data.domain.nginxSettings.proxyRoutes, [proxyRoute]);

  // 4. Enqueue domain.stage and verify claimed protocol envelope + rendered Nginx config
  const stageRes = await owner.api('POST', `/api/domains/${fx.domain.id}/stage`, {});
  assert.equal(stageRes.status, 202);
  const claimed = await fx.baseJobRegistry.claimNext(fx.serverId);
  assert.equal(claimed.envelope.operation, OPERATIONS.DOMAIN_STAGE);
  assert.deepEqual(claimed.envelope.payload.nginxSettings.proxyRoutes, [proxyRoute]);

  const rendered = renderStaticSiteConfig({
    primaryDomain: claimed.envelope.payload.primaryDomain,
    aliases: claimed.envelope.payload.aliases,
    root: claimed.envelope.payload.target.root,
    spaFallback: claimed.envelope.payload.target.spaFallback,
    canonicalRedirect: claimed.envelope.payload.canonicalRedirect,
    httpsRedirect: claimed.envelope.payload.httpsRedirect,
    nginxSettings: claimed.envelope.payload.nginxSettings,
  });
  assert.match(rendered, /location = \/api \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:13000;/);
  assert.match(rendered, /location \^~ \/api\/ \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:13000;/);
  assert.match(rendered, /location \^~ \/\.well-known\/acme-challenge\//);
  assert.match(rendered, /location \/ \{/);
  assert.match(rendered, /"~\^\/admin\/" "Restricted";/);
  assert.equal(rendered.includes('"~^/api/"'), false);
});

test('real SQLite/HTTP RBAC matrix denies reseller, customer, site_manager, read_only, and MFA-locked Owner on /api/docker/* and proxyRoutes mutations while preserving read_only workloads and non-Owner unrelated settings edits', async (t) => {
  const fx = await createRealFixture(t);
  const owner = await fx.loginAs('owner');
  const reseller = await fx.loginAs('reseller');
  const customer = await fx.loginAs('customer');
  const siteManager = await fx.loginAs('site_manager');
  const readOnly = await fx.loginAs('read_only');

  const project = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'rbac_api',
    document: COMPOSE_INITIAL,
  })).json.data.project;

  // 1. All non-Owner roles denied /api/docker/*
  for (const actor of [reseller, customer, siteManager, readOnly]) {
    for (const [method, url, body] of [
      ['GET', '/api/docker/projects', undefined],
      ['GET', `/api/docker/projects/${project.id}/storage-backup`, undefined],
      ['GET', '/api/docker/catalog', undefined],
      ['GET', '/api/docker/one-click-apps', undefined],
      ['POST', '/api/docker/proxy-rules/resolve', { hostname: 'app.example.com', projectId: project.id, serviceName: 'api', innerPort: 3000, urlPath: '/api' }],
    ]) {
      const res = await actor.api(method, url, body);
      assert.equal(res.status, 403, `Expected 403 for ${actor.username} on ${method} ${url}, got ${res.status}`);
    }
  }

  // 2. read_only retains GET /api/docker/workloads; site_management roles denied
  const roWorkloads = await readOnly.api('GET', '/api/docker/workloads');
  assert.equal(roWorkloads.status, 200);
  for (const actor of [reseller, customer, siteManager]) {
    assert.equal((await actor.api('GET', '/api/docker/workloads')).status, 403);
  }

  // 3. Non-Owner cannot create domain with proxyRoutes or mutate proxyRoutes on existing domain
  const proxyRoute = {
    path: '/api',
    projectId: project.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  };
  for (const actor of [reseller, customer, siteManager]) {
    const createDenied = await actor.api('POST', '/api/domains', {
      serverId: fx.serverId,
      websiteId: fx.website.id,
      primaryDomain: `${actor.username.replace('_', '-')}.app.example.com`,
      parentDomainId: fx.domain.id,
      targetType: 'static',
      target: { root: fx.website.documentRoot, spaFallback: true },
      nginxSettings: { proxyRoutes: [proxyRoute] },
    });
    assert.equal(createDenied.status, 403, `Expected 403 create for ${actor.username}`);
    assert.equal(createDenied.json.error.code, 'proxy_routes_owner_only');

    const previewDenied = await actor.api('POST', `/api/domains/${fx.domain.id}/update-preview`, {
      changes: { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [proxyRoute] } },
    });
    assert.equal(previewDenied.status, 403, `Expected 403 update-preview for ${actor.username}`);
    assert.equal(previewDenied.json.error.code, 'proxy_routes_owner_only');
  }

  // 4. Owner adds proxyRoute; customer can still edit clientMaxBodySizeMb while keeping proxyRoutes intact,
  //    but cannot remove/alter proxyRoutes
  const addChanges = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [proxyRoute] } };
  const ownerPreview = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: addChanges })).json.data;
  const ownerPatch = await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: addChanges,
    previewDigest: ownerPreview.previewDigest,
    confirmation: ownerPreview.confirmation,
  });
  assert.equal(ownerPatch.status, 200);
  const updatedDomain = ownerPatch.json.data.domain;

  const custRemove = await customer.api('POST', `/api/domains/${fx.domain.id}/update-preview`, {
    changes: { nginxSettings: { ...updatedDomain.nginxSettings, proxyRoutes: [] } },
  });
  assert.equal(custRemove.status, 403);
  assert.equal(custRemove.json.error.code, 'proxy_routes_owner_only');

  const custOtherChanges = { nginxSettings: { ...updatedDomain.nginxSettings, clientMaxBodySizeMb: 48 } };
  const custPrev = await customer.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: custOtherChanges });
  assert.equal(custPrev.status, 200);
  const custPatch = await customer.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: custOtherChanges,
    previewDigest: custPrev.json.data.previewDigest,
    confirmation: custPrev.json.data.confirmation,
  });
  assert.equal(custPatch.status, 200);
  assert.equal(custPatch.json.data.domain.nginxSettings.clientMaxBodySizeMb, 48);
  assert.deepEqual(custPatch.json.data.domain.nginxSettings.proxyRoutes, [proxyRoute]);

  // 5. MFA-locked Owner (ownerMfaRequired: true without MFA enrolled) is also denied /api/docker/*
  const mfaFx = await createRealFixture(t, { ownerMfaRequired: true });
  const mfaLockedOwner = await mfaFx.loginAs('owner');
  assert.equal((await mfaLockedOwner.api('GET', '/api/docker/projects')).status, 403);
});

test('overlapping protectedPaths + proxyRoutes, binding mismatch, drift at stage, and tightened resolveDockerProxyRule fail closed', async (t) => {
  const fx = await createRealFixture(t);
  const owner = await fx.loginAs('owner');
  const project = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'drift_api',
    document: COMPOSE_INITIAL,
  })).json.data.project;

  const validRoute = {
    path: '/api',
    projectId: project.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  };

  // Overlapping protectedPaths (/api/) + proxyRoutes (/api) rejected with 400
  const overlapRes = await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, {
    changes: {
      nginxSettings: {
        ...fx.domain.nginxSettings,
        protectedPaths: [{ path: '/api/', key: '0123456789abcdef' }],
        proxyRoutes: [validRoute],
      },
    },
  });
  assert.equal(overlapRes.status, 400);
  assert.equal(overlapRes.json.error.code, 'nginx_proxy_route_protected_path_conflict');

  // Mismatched upstreamPort rejected with 409
  const mismatchRes = await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, {
    changes: { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [{ ...validRoute, upstreamPort: 19999 }] } },
  });
  assert.equal(mismatchRes.status, 409);
  assert.equal(mismatchRes.json.error.code, 'docker_proxy_route_binding_mismatch');

  // Non-existent project rejected with 404
  const missingProjRes = await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, {
    changes: {
      nginxSettings: {
        ...fx.domain.nginxSettings,
        proxyRoutes: [{ ...validRoute, projectId: '99999999-9999-4999-8999-999999999999' }],
      },
    },
  });
  assert.equal(missingProjRes.status, 404);
  assert.equal(missingProjRes.json.error.code, 'managed_compose_project_not_found');

  // Tightened resolveDockerProxyRule checks (reserved paths, privileged port, ambiguous port, IPv6 loopback)
  for (const badPath of ['/.well-known', '/.well-known/acme-challenge', '/.git', '/api/.env', '/autodiscover', '/AutoDiscover/autodiscover.xml', '/mail/config-v1.1.xml', '/api/']) {
    const res = await owner.api('POST', '/api/docker/proxy-rules/resolve', {
      hostname: 'app.example.com',
      projectId: project.id,
      serviceName: 'api',
      innerPort: 3000,
      urlPath: badPath,
    });
    assert.equal(res.status, 400, `Expected 400 for urlPath=${badPath}`);
    assert.equal(res.json.error.code, 'invalid_proxy_url_path');
  }
  const privRes = await owner.api('POST', '/api/docker/proxy-rules/resolve', {
    hostname: 'app.example.com',
    serviceName: 'api',
    innerPort: 80,
    outerPort: 80,
    urlPath: '/api',
  });
  assert.equal(privRes.status, 409);
  assert.equal(privRes.json.error.code, 'docker_proxy_port_privileged');

  const ambiguousProject = {
    id: project.id,
    serverId: fx.serverId,
    projectName: 'ambig_app',
    services: [{
      name: 'api',
      publishedPorts: [
        { hostIp: '127.0.0.1', publishedPort: 13000, targetPort: 3000, protocol: 'tcp' },
        { hostIp: '::1', publishedPort: 13001, targetPort: 3000, protocol: 'tcp' },
      ],
    }],
  };
  await assert.rejects(
    resolveDockerProxyRule({
      hostname: 'app.example.com',
      project: ambiguousProject,
      serviceName: 'api',
      innerPort: 3000,
      urlPath: '/api',
    }),
    (err) => err instanceof DockerPleskCatalogError && err.code === 'docker_proxy_port_ambiguous' && err.status === 409,
  );
  const resolvedV6 = await resolveDockerProxyRule({
    hostname: 'app.example.com',
    project: {
      ...ambiguousProject,
      services: [{ name: 'api', publishedPorts: [{ hostIp: '::', publishedPort: 13000, targetPort: 3000, protocol: 'tcp' }] }],
    },
    serviceName: 'api',
    innerPort: 3000,
    urlPath: '/api',
  });
  assert.equal(resolvedV6.upstreamHost, '::1');
  assert.equal(resolvedV6.upstreamPort, 13000);

  // Stage-time drift check: save valid route, then update a second unguarded registry pointing to drifted port -> enqueueStage rejects 409!
  const okPreview = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, {
    changes: { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [validRoute] } },
  })).json.data;
  const okPatch = await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [validRoute] } },
    previewDigest: okPreview.previewDigest,
    confirmation: okPreview.confirmation,
  });
  assert.equal(okPatch.status, 200);

  // Real separate Compose project registry on disk with the same projectId but drifted port (13999)
  const driftedProjectRegistry = createDockerComposeProjectRegistry({
    filePath: path.join(fx.rootDir, 'drifted-projects.json'),
    masterKey: randomBytes(32),
    serverExists: async (id) => id === fx.serverId,
  });
  await driftedProjectRegistry.init();
  const driftedDoc = 'services:\n  api:\n    image: node:22-alpine\n    ports:\n      - "127.0.0.1:13999:3000/tcp"\n';
  const driftedValidation = await fx.validateDockerCompose({ projectName: 'drift_api', document: driftedDoc, interpolate: false });
  await driftedProjectRegistry.createProject({
    projectId: project.id,
    serverId: fx.serverId,
    projectName: 'drift_api',
    document: driftedDoc,
    validation: driftedValidation,
  });

  const driftedStageRegistry = createDomainStageTargetJobRegistry({
    registry: fx.baseJobRegistry,
    domainRegistry: fx.domainRegistry,
    websiteRegistry: fx.websiteRegistry,
    dockerComposeProjectRegistry: driftedProjectRegistry,
    applicationRegistry: fx.applicationRegistry,
    runtimeBindingRegistry: fx.runtimeBindingRegistry,
    siteMutationLock: fx.siteMutationLock,
  });
  await assert.rejects(
    driftedStageRegistry.enqueue({
      serverId: fx.serverId,
      type: 'domain.stage',
      operation: OPERATIONS.DOMAIN_STAGE,
      payload: {
        primaryDomain: fx.domain.primaryDomain,
        aliases: fx.domain.aliases,
        targetType: 'static',
        target: fx.domain.target,
        nginxSettings: okPatch.json.data.domain.nginxSettings,
        canonicalRedirect: false,
        httpsRedirect: false,
      },
      resourceType: 'domain',
      resourceId: fx.domain.id,
    }),
    { code: 'docker_proxy_route_binding_mismatch', status: 409 },
  );
});

test('Compose reverse-reference protection blocks breaking edits and removal while referenced by active domain, staged/applied live Nginx, or pending stage/activate jobs, allows non-breaking edits, and unblocks after clean activation', async (t) => {
  const fx = await createRealFixture(t);
  const owner = await fx.loginAs('owner');
  let project = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'protected_stack',
    document: COMPOSE_INITIAL,
  })).json.data.project;

  const route = {
    path: '/api',
    projectId: project.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  };

  // 1. Attach route -> stage -> activate so live appliedProxyRoutes is bound
  const attachChanges = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [route] } };
  const p1 = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: attachChanges })).json.data;
  assert.equal((await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: attachChanges,
    previewDigest: p1.previewDigest,
    confirmation: p1.confirmation,
  })).status, 200);

  const checksumWithRoute = '1'.repeat(64);
  const checksumClean = '2'.repeat(64);

  const stage1 = await owner.api('POST', `/api/domains/${fx.domain.id}/stage`, {});
  assert.equal(stage1.status, 202);
  const claimedStage1 = await fx.baseJobRegistry.claimNext(fx.serverId);
  const completedStage1 = await fx.baseJobRegistry.complete({
    serverId: fx.serverId,
    jobId: claimedStage1.job.id,
    status: 'succeeded',
    result: { checksum: checksumWithRoute, configName: 'yunpanel-app.example.com.conf', bytes: 512 },
  });
  await reconcileCompletedJob({ domainRegistry: fx.domainRegistry, job: completedStage1 });

  const act1 = await owner.api('POST', `/api/domains/${fx.domain.id}/activate`, {});
  assert.equal(act1.status, 202);
  const claimedAct1 = await fx.baseJobRegistry.claimNext(fx.serverId);
  const completedAct1 = await fx.baseJobRegistry.complete({
    serverId: fx.serverId,
    jobId: claimedAct1.job.id,
    status: 'succeeded',
    result: { checksum: checksumWithRoute, configName: 'yunpanel-app.example.com.conf', active: true },
  });
  await reconcileCompletedJob({ domainRegistry: fx.domainRegistry, job: completedAct1 });

  const liveDomain = await fx.domainRegistry.getDomain(fx.domain.id);
  assert.equal(liveDomain.state, 'active');
  assert.deepEqual(liveDomain.appliedProxyRoutes, [route]);

  // 2. NON-BREAKING Compose edit (new image tag, env, and changed unrelated worker port) MUST SUCCEED
  const nonBreakingDoc = [
    'services:',
    '  api:',
    '    image: node:24-alpine',
    '    environment:',
    '      LOG_LEVEL: info',
    '    ports:',
    '      - "127.0.0.1:13000:3000/tcp"',
    '  worker:',
    '    image: redis:7.4-alpine',
    '    ports:',
    '      - "127.0.0.1:16380:6379/tcp"',
    '',
  ].join('\n');
  const nonBreakingRes = await owner.api('PUT', `/api/docker/projects/${project.id}`, {
    expectedRevision: project.revision,
    document: nonBreakingDoc,
  });
  assert.equal(nonBreakingRes.status, 200);
  project = nonBreakingRes.json.data;
  assert.equal(project.revision, 2);

  // 3. BREAKING Compose edits MUST BE BLOCKED with 409 docker_compose_proxy_route_in_use
  const breakingDocs = [
    'services:\n  api:\n    image: node:24-alpine\n    ports:\n      - "127.0.0.1:13099:3000/tcp"\n',
    'services:\n  worker:\n    image: redis:7.4-alpine\n    ports:\n      - "127.0.0.1:16380:6379/tcp"\n',
    'services:\n  api:\n    image: node:24-alpine\n    ports:\n      - "127.0.0.1:13000:4000/tcp"\n',
    'services:\n  api:\n    image: node:24-alpine\n    ports:\n      - "[::1]:13000:3000/tcp"\n',
    'services:\n  api:\n    image: node:24-alpine\n    ports:\n      - "127.0.0.1:13000:3000/tcp"\n      - "127.0.0.1:13001:3000/tcp"\n',
  ];
  for (const badDoc of breakingDocs) {
    const blocked = await owner.api('PUT', `/api/docker/projects/${project.id}`, {
      expectedRevision: project.revision,
      document: badDoc,
    });
    assert.equal(blocked.status, 409, `Expected 409 for breaking doc:\n${badDoc}`);
    assert.equal(blocked.json.error.code, 'docker_compose_proxy_route_in_use');
  }
  const removeBlockedActive = await owner.api('POST', `/api/docker/projects/${project.id}/operations/remove/preview`, {});
  assert.equal(removeBlockedActive.status, 409);
  assert.equal(removeBlockedActive.json.error.code, 'docker_compose_project_in_use');

  // 4. Remove /api in draft (PATCH ONLY — live Nginx still serves checksumWithRoute!)
  const clearChanges = { nginxSettings: { ...liveDomain.nginxSettings, proxyRoutes: [] } };
  const p2 = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: clearChanges })).json.data;
  const u2 = await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: clearChanges,
    previewDigest: p2.previewDigest,
    confirmation: p2.confirmation,
  });
  assert.equal(u2.status, 200);
  assert.deepEqual(u2.json.data.domain.appliedProxyRoutes, [route]);
  assert.equal(Object.hasOwn(u2.json.data.domain, 'stagedProxyRoutes'), false);

  // Breaking edit AND removal STILL 409 while live Nginx is active!
  assert.equal((await owner.api('PUT', `/api/docker/projects/${project.id}`, {
    expectedRevision: project.revision,
    document: breakingDocs[0],
  })).status, 409);
  assert.equal((await owner.api('POST', `/api/docker/projects/${project.id}/operations/remove/preview`, {})).status, 409);

  // 5. Stage clean config (BEFORE activate) -> STILL 409 because old live Nginx has not switched yet!
  const stage2 = await owner.api('POST', `/api/domains/${fx.domain.id}/stage`, {});
  assert.equal(stage2.status, 202);
  const claimedStage2 = await fx.baseJobRegistry.claimNext(fx.serverId);
  const completedStage2 = await fx.baseJobRegistry.complete({
    serverId: fx.serverId,
    jobId: claimedStage2.job.id,
    status: 'succeeded',
    result: { checksum: checksumClean, configName: 'yunpanel-app.example.com.conf', bytes: 256 },
  });
  await reconcileCompletedJob({ domainRegistry: fx.domainRegistry, job: completedStage2 });

  assert.equal((await owner.api('PUT', `/api/docker/projects/${project.id}`, {
    expectedRevision: project.revision,
    document: breakingDocs[0],
  })).status, 409);
  assert.equal((await owner.api('POST', `/api/docker/projects/${project.id}/operations/remove/preview`, {})).status, 409);

  // 6. Activate clean config -> appliedProxyRoutes cleared -> BOTH breaking edit and removal SUCCEED!
  const act2 = await owner.api('POST', `/api/domains/${fx.domain.id}/activate`, {});
  assert.equal(act2.status, 202);
  const claimedAct2 = await fx.baseJobRegistry.claimNext(fx.serverId);
  const completedAct2 = await fx.baseJobRegistry.complete({
    serverId: fx.serverId,
    jobId: claimedAct2.job.id,
    status: 'succeeded',
    result: { checksum: checksumClean, configName: 'yunpanel-app.example.com.conf', active: true },
  });
  await reconcileCompletedJob({ domainRegistry: fx.domainRegistry, job: completedAct2 });

  const activatedClean = await fx.domainRegistry.getDomain(fx.domain.id);
  assert.equal(Object.hasOwn(activatedClean, 'appliedProxyRoutes'), false);

  const nowAllowedEdit = await owner.api('PUT', `/api/docker/projects/${project.id}`, {
    expectedRevision: project.revision,
    document: breakingDocs[0],
  });
  assert.equal(nowAllowedEdit.status, 200);
  assert.equal(nowAllowedEdit.json.data.revision, 3);

  const nowAllowedRemove = await owner.api('POST', `/api/docker/projects/${project.id}/operations/remove/preview`, {});
  assert.equal(nowAllowedRemove.status, 200);
  assert.equal(nowAllowedRemove.json.data.action, 'remove');
});

test('pending queued DOMAIN_STAGE job blocks breaking Compose edit and removal even if domain draft was cleared', async (t) => {
  const fx = await createRealFixture(t);
  const owner = await fx.loginAs('owner');
  const project = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'pending_stage_stack',
    document: COMPOSE_INITIAL,
  })).json.data.project;

  const route = {
    path: '/api',
    projectId: project.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  };
  const addChanges = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [route] } };
  const prev = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: addChanges })).json.data;
  assert.equal((await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: addChanges,
    previewDigest: prev.previewDigest,
    confirmation: prev.confirmation,
  })).status, 200);

  // Enqueue DOMAIN_STAGE (stays queued)
  const stageRes = await owner.api('POST', `/api/domains/${fx.domain.id}/stage`, {});
  assert.equal(stageRes.status, 202);
  const stageJob = stageRes.json.data;

  // Clear domain draft directly so ONLY the pending DOMAIN_STAGE job references project
  const current = await fx.domainRegistry.getDomain(fx.domain.id);
  const clearPrev = await fx.domainRegistry.previewDomainUpdate({
    domainId: fx.domain.id,
    changes: { nginxSettings: { ...current.nginxSettings, proxyRoutes: [] } },
  });
  await fx.domainRegistry.updateDomain({
    domainId: fx.domain.id,
    changes: { nginxSettings: { ...current.nginxSettings, proxyRoutes: [] } },
    previewDigest: clearPrev.previewDigest,
  });

  const breakingDoc = 'services:\n  api:\n    image: node:22-alpine\n    ports:\n      - "127.0.0.1:13099:3000/tcp"\n';
  assert.equal((await owner.api('PUT', `/api/docker/projects/${project.id}`, {
    expectedRevision: project.revision,
    document: breakingDoc,
  })).status, 409);
  assert.equal((await owner.api('POST', `/api/docker/projects/${project.id}/operations/remove/preview`, {})).status, 409);

  // Cancel queued stage job -> unblocked
  await fx.baseJobRegistry.cancel(stageJob.id);
  assert.equal((await owner.api('PUT', `/api/docker/projects/${project.id}`, {
    expectedRevision: project.revision,
    document: breakingDoc,
  })).status, 200);
  assert.equal((await owner.api('POST', `/api/docker/projects/${project.id}/operations/remove/preview`, {})).status, 200);
});

test('cross-project published host port conflict prevents another Compose project from hijacking a bound port even when stopped', async (t) => {
  const fx = await createRealFixture(t);
  const owner = await fx.loginAs('owner');

  const p1Doc = 'services:\n  api:\n    image: node:22-alpine\n    ports:\n      - "127.0.0.1:13000:3000/tcp"\n';
  const p1 = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'primary_api',
    document: p1Doc,
  })).json.data.project;

  const route = {
    path: '/api',
    projectId: p1.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  };
  const changes = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [route] } };
  const prev = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes })).json.data;
  assert.equal((await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes,
    previewDigest: prev.previewDigest,
    confirmation: prev.confirmation,
  })).status, 200);

  // Complete a normal stop operation on P1 (project metadata stays persisted)
  const stopPrev = (await owner.api('POST', `/api/docker/projects/${p1.id}/operations/stop/preview`, {})).json.data;
  const stopQueue = await owner.api('POST', `/api/docker/projects/${p1.id}/operations/stop`, {
    expectedPreviewDigest: stopPrev.previewDigest,
    confirmation: stopPrev.confirmation,
  });
  assert.equal(stopQueue.status, 202);
  const claimedStop = await fx.baseJobRegistry.claimNext(fx.serverId);
  await fx.baseJobRegistry.complete({
    serverId: fx.serverId,
    jobId: claimedStop.job.id,
    status: 'succeeded',
    result: {
      version: 1,
      projectId: claimedStop.job.payload.projectId,
      projectRevision: claimedStop.job.payload.expectedProjectRevision,
      environmentRevision: claimedStop.job.payload.expectedEnvironmentRevision,
      composeSha256: claimedStop.job.payload.expectedComposeSha256,
      action: 'stop',
      runtimeState: 'stopped',
      executed: true,
      sideEffects: true,
    },
  });

  // Attempting to create P2 claiming 127.0.0.1:13000, 0.0.0.0:13000, or unspecified :13000 MUST FAIL 409
  for (const [name, portSpec] of [
    ['hijack_loopback', '"127.0.0.1:13000:8080/tcp"'],
    ['hijack_ipv4_any', '"0.0.0.0:13000:8080/tcp"'],
    ['hijack_unspec', '"13000:8080/tcp"'],
  ]) {
    const hijackRes = await owner.api('POST', '/api/docker/projects', {
      serverId: fx.serverId,
      projectName: name,
      document: `services:\n  web:\n    image: nginx:alpine\n    ports:\n      - ${portSpec}\n`,
    });
    assert.equal(hijackRes.status, 409, `Expected 409 for ${name} (${portSpec})`);
    assert.equal(hijackRes.json.error.code, 'docker_compose_published_port_conflict');
  }

  // Create P2 on a distinct port (13050), then attempt to PUT update P2 to hijack 13000 -> 409
  const p2 = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'other_service',
    document: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:13050:8080/tcp"\n',
  })).json.data.project;

  const p2HijackUpdate = await owner.api('PUT', `/api/docker/projects/${p2.id}`, {
    expectedRevision: p2.revision,
    document: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "0.0.0.0:13000:8080/tcp"\n',
  });
  assert.equal(p2HijackUpdate.status, 409);
  assert.equal(p2HijackUpdate.json.error.code, 'docker_compose_published_port_conflict');

  // Unbind /api from Domain D, move P1 to 13010 -> P2 can now allocate 127.0.0.1:13000!
  const dNow = await fx.domainRegistry.getDomain(fx.domain.id);
  const unbindChanges = { nginxSettings: { ...dNow.nginxSettings, proxyRoutes: [] } };
  const unbindPrev = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: unbindChanges })).json.data;
  assert.equal((await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: unbindChanges,
    previewDigest: unbindPrev.previewDigest,
    confirmation: unbindPrev.confirmation,
  })).status, 200);

  const p1Move = await owner.api('PUT', `/api/docker/projects/${p1.id}`, {
    expectedRevision: p1.revision,
    document: 'services:\n  api:\n    image: node:22-alpine\n    ports:\n      - "127.0.0.1:13010:3000/tcp"\n',
  });
  assert.equal(p1Move.status, 200);

  const p2Takeover = await owner.api('PUT', `/api/docker/projects/${p2.id}`, {
    expectedRevision: p2.revision,
    document: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:13000:8080/tcp"\n',
  });
  assert.equal(p2Takeover.status, 200);
  assert.equal(p2Takeover.json.data.services[0].publishedPorts[0].publishedPort, 13000);
});

test('shared per-project lock prevents concurrent races between Compose update and Domain proxyRoutes update/stage', async (t) => {
  const fx = await createRealFixture(t);
  const owner = await fx.loginAs('owner');
  const project = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'locked_stack',
    document: COMPOSE_INITIAL,
  })).json.data.project;

  const route = {
    path: '/api',
    projectId: project.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  };
  const changes = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [route] } };
  const preview = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes })).json.data;

  await fx.siteMutationLock.withDockerProjectLock(project.id, async () => {
    const putLocked = await owner.api('PUT', `/api/docker/projects/${project.id}`, {
      expectedRevision: project.revision,
      document: COMPOSE_INITIAL,
    });
    assert.equal(putLocked.status, 409);
    assert.equal(putLocked.json.error.code, 'site_mutation_locked');

    const patchLocked = await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
      changes,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    });
    assert.equal(patchLocked.status, 409);
    assert.equal(patchLocked.json.error.code, 'site_mutation_locked');
  });

  assert.equal((await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  })).status, 200);

  await fx.siteMutationLock.withDockerProjectLock(project.id, async () => {
    const stageLocked = await owner.api('POST', `/api/domains/${fx.domain.id}/stage`, {});
    assert.equal(stageLocked.status, 409);
    assert.equal(stageLocked.json.error.code, 'site_mutation_locked');
  });

  assert.equal((await owner.api('POST', `/api/domains/${fx.domain.id}/stage`, {})).status, 202);
});

test('PHP and Passenger projections preserve proxyRoutes through protocol validation and render correct Nginx configs', () => {
  const proxyRoutes = [{
    path: '/api',
    projectId: '0bb78242-03a6-429f-9d17-7725c521437c',
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: true,
  }];
  const domain = { nginxSettings: { clientMaxBodySizeMb: null, headers: [], proxyRoutes } };

  const phpSettings = domainNginxSettingsForTarget(domain, 'php');
  assert.deepEqual(phpSettings.proxyRoutes, proxyRoutes);
  const phpTarget = {
    root: '/var/lib/yunpanel/apps/owned/current',
    socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock',
  };
  const phpEnvelope = createOperationEnvelope({
    id: 'php-proxy-route-stage-1',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'php.example.com',
      aliases: [],
      targetType: 'php',
      target: phpTarget,
      nginxSettings: phpSettings,
      httpsRedirect: false,
      canonicalRedirect: false,
      domainRevision: 2,
    },
  });
  const phpConfig = renderPhpSiteConfig({
    primaryDomain: 'php.example.com',
    ...phpTarget,
    httpsRedirect: false,
    canonicalRedirect: false,
    nginxSettings: phpEnvelope.payload.nginxSettings,
  });
  assert.match(phpConfig, /location = \/api \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:13000\/;/);
  assert.match(phpConfig, /location \^~ \/api\/ \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:13000\/;/);
  assert.ok(phpConfig.indexOf('location ^~ /api/') < phpConfig.indexOf('location ~ \\.php$'));

  const passengerSettings = domainNginxSettingsForTarget(domain, 'passenger');
  assert.deepEqual(passengerSettings.proxyRoutes, proxyRoutes);
  const passengerTarget = {
    appRoot: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current',
    documentRoot: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current/public',
    startupFile: 'server.js',
    nodeBinary: '/usr/bin/node',
    user: 'yunapp-123456abcdef',
    group: 'yunapp-123456abcdef',
    appEnv: 'production',
    environmentInclude: null,
  };
  const passengerEnvelope = createOperationEnvelope({
    id: 'passenger-proxy-route-stage-1',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'node.example.com',
      aliases: [],
      targetType: 'passenger',
      target: passengerTarget,
      nginxSettings: passengerSettings,
      httpsRedirect: false,
      canonicalRedirect: false,
      domainRevision: 2,
    },
  });
  const passengerConfig = renderPassengerSiteConfig({
    primaryDomain: 'node.example.com',
    target: passengerTarget,
    httpsRedirect: false,
    canonicalRedirect: false,
    nginxSettings: passengerEnvelope.payload.nginxSettings,
  });
  assert.match(passengerConfig, /location = \/api \{\n    passenger_enabled off;\n    proxy_pass http:\/\/127\.0\.0\.1:13000\/;/);
  assert.match(passengerConfig, /location \^~ \/api\/ \{\n    passenger_enabled off;\n    proxy_pass http:\/\/127\.0\.0\.1:13000\/;/);

  assert.equal(Object.hasOwn(domainNginxSettingsForTarget({ nginxSettings: { clientMaxBodySizeMb: null, headers: [] } }, 'php'), 'proxyRoutes'), false);
});

test('missing or incomplete siteMutationLock fails closed with 503 across all 6 proxyRoutes and Compose lock callers while empty proxyRoutes pass through', async (t) => {
  for (const brokenLock of [null, {}]) {
    const fx = await createRealFixture(t, { siteMutationLockOverride: brokenLock });
    const owner = await fx.loginAs('owner');

    const project = (await owner.api('POST', '/api/docker/projects', {
      serverId: fx.serverId,
      projectName: 'lock_guard_stack',
      document: COMPOSE_INITIAL,
    })).json.data.project;

    const route = {
      path: '/api',
      projectId: project.id,
      serviceName: 'api',
      targetPort: 3000,
      protocol: 'tcp',
      upstreamHost: '127.0.0.1',
      upstreamPort: 13000,
      websocket: true,
      stripPrefix: false,
    };

    // 1. POST /api/domains (management-app / domain-http.js): non-empty proxyRoutes -> 503; empty -> 201
    const createBlocked = await owner.api('POST', '/api/domains', {
      serverId: fx.serverId,
      websiteId: fx.website.id,
      primaryDomain: 'locked-create.example.com',
      targetType: 'static',
      target: { root: fx.website.documentRoot, spaFallback: true },
      nginxSettings: { proxyRoutes: [route] },
    });
    assert.equal(createBlocked.status, 503);
    assert.equal(createBlocked.json.error.code, 'docker_proxy_route_lock_unavailable');

    const createEmptyAllowed = await owner.api('POST', '/api/domains', {
      serverId: fx.serverId,
      websiteId: fx.website.id,
      primaryDomain: 'empty-routes.example.com',
      targetType: 'static',
      target: { root: fx.website.documentRoot, spaFallback: true },
      nginxSettings: { proxyRoutes: [] },
    });
    assert.equal(createEmptyAllowed.status, 201);

    // 2. core-app.js POST /api/domains directly: non-empty proxyRoutes -> 503; empty -> 201
    const coreApp = createCoreApp({
      registry: fx.serverRegistry,
      domainRegistry: fx.domainRegistry,
      websiteRegistry: fx.websiteRegistry,
      applicationRegistry: fx.applicationRegistry,
      jobRegistry: fx.jobRegistry,
      dockerComposeProjectRegistry: fx.projectRegistry,
      siteMutationLock: brokenLock,
      localServerId: fx.serverId,
    });
    const coreRouteLayer = coreApp.router.stack.find((layer) => layer.route?.path === '/api/domains' && layer.route.methods.post);
    assert.ok(coreRouteLayer);
    const coreCreateHandler = coreRouteLayer.route.stack.at(-1).handle;
    const ownerAuth = {
      user: { id: 'owner-1', username: 'owner', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    const coreBlockedRes = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let coreBlockedErr = null;
    try {
      await coreCreateHandler({
        auth: ownerAuth,
        body: {
          serverId: fx.serverId,
          websiteId: fx.website.id,
          primaryDomain: 'core-locked.example.com',
          targetType: 'static',
          target: { root: fx.website.documentRoot, spaFallback: true },
          nginxSettings: { proxyRoutes: [route] },
        },
      }, coreBlockedRes, (e) => { coreBlockedErr = e; });
    } catch (e) {
      coreBlockedErr = e;
    }
    assert.equal(coreBlockedErr?.code, 'docker_proxy_route_lock_unavailable');
    assert.equal(coreBlockedErr?.status, 503);

    const coreEmptyRes = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let coreEmptyErr = null;
    await coreCreateHandler({
      auth: ownerAuth,
      body: {
        serverId: fx.serverId,
        websiteId: fx.website.id,
        primaryDomain: 'core-empty.example.com',
        targetType: 'static',
        target: { root: fx.website.documentRoot, spaFallback: true },
        nginxSettings: { proxyRoutes: [] },
      },
    }, coreEmptyRes, (e) => { coreEmptyErr = e; });
    assert.equal(coreEmptyErr, null);
    assert.equal(coreEmptyRes.statusCode, 201);

    // 3. PATCH /api/domains/:id (domain-http.js): adding proxyRoutes -> 503; unrelated setting -> 200
    const addChanges = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [route] } };
    const addPrev = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: addChanges })).json.data;
    const patchBlocked = await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
      changes: addChanges,
      previewDigest: addPrev.previewDigest,
      confirmation: addPrev.confirmation,
    });
    assert.equal(patchBlocked.status, 503);
    assert.equal(patchBlocked.json.error.code, 'docker_proxy_route_lock_unavailable');

    const gzipChanges = { nginxSettings: { ...fx.domain.nginxSettings, gzip: true } };
    const gzipPrev = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: gzipChanges })).json.data;
    assert.equal((await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
      changes: gzipChanges,
      previewDigest: gzipPrev.previewDigest,
      confirmation: gzipPrev.confirmation,
    })).status, 200);

    // 4. DOMAIN_STAGE: empty proxyRoutes passes through cleanly; persisted proxyRoutes fails closed 503
    const stageEmptyRes = await owner.api('POST', `/api/domains/${createEmptyAllowed.json.data.id}/stage`, {});
    assert.equal(stageEmptyRes.status, 202);

    const routedDomain = await fx.domainRegistry.createDomain({
      serverId: fx.serverId,
      websiteId: fx.website.id,
      primaryDomain: 'routed-stage-lock.example.com',
      targetType: 'static',
      target: { root: fx.website.documentRoot, spaFallback: true },
      nginxSettings: { proxyRoutes: [route] },
    });
    const stageBlocked = await owner.api('POST', `/api/domains/${routedDomain.id}/stage`, {});
    assert.equal(stageBlocked.status, 503);
    assert.equal(stageBlocked.json.error.code, 'docker_proxy_route_lock_unavailable');

    // 5. PUT /api/docker/projects/:id -> 503
    const putBlocked = await owner.api('PUT', `/api/docker/projects/${project.id}`, {
      expectedRevision: project.revision,
      document: COMPOSE_INITIAL,
    });
    assert.equal(putBlocked.status, 503);
    assert.equal(putBlocked.json.error.code, 'docker_proxy_route_lock_unavailable');

    // 6. POST /api/docker/projects/:id/operations/remove -> 503 (use fresh unreferenced project)
    const unrefProject = (await owner.api('POST', '/api/docker/projects', {
      serverId: fx.serverId,
      projectName: 'lock_guard_remove',
      document: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:13111:80/tcp"\n',
    })).json.data.project;
    const remPrev = (await owner.api('POST', `/api/docker/projects/${unrefProject.id}/operations/remove/preview`, {})).json.data;
    const remBlocked = await owner.api('POST', `/api/docker/projects/${unrefProject.id}/operations/remove`, {
      expectedPreviewDigest: remPrev.previewDigest,
      confirmation: remPrev.confirmation,
    });
    assert.equal(remBlocked.status, 503);
    assert.equal(remBlocked.json.error.code, 'docker_proxy_route_lock_unavailable');
  }
});

test('assertOwnerProxyRouteAccess and isOwnerManagementAuth fail closed (401 on missing auth, 403 on malformed Owner permissions or non-Owner mutations) across all domain HTTP handlers', async (t) => {
  const fx = await createRealFixture(t);
  const owner = await fx.loginAs('owner');
  const project = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'auth_guard_stack',
    document: COMPOSE_INITIAL,
  })).json.data.project;

  const route = {
    path: '/api',
    projectId: project.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  };

  // Attach route as real Owner so currentRoutes is non-empty on fx.domain
  const attachChanges = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [route] } };
  const attachPrev = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: attachChanges })).json.data;
  assert.equal((await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: attachChanges,
    previewDigest: attachPrev.previewDigest,
    confirmation: attachPrev.confirmation,
  })).status, 200);

  // Strict isOwnerManagementAuth requires Array permissions containing '*'
  assert.equal(isOwnerManagementAuth({
    user: { role: 'owner' },
    access: { mode: 'management' },
    security: { managementAllowed: true },
  }), false);
  assert.equal(isOwnerManagementAuth({
    user: { role: 'owner' },
    access: { mode: 'management', permissions: [] },
    security: { managementAllowed: true },
  }), false);
  assert.equal(isOwnerManagementAuth({
    user: { role: 'owner' },
    access: { mode: 'management', permissions: ['domains:write'] },
    security: { managementAllowed: true },
  }), false);
  assert.equal(isOwnerManagementAuth({
    user: { role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  }), true);

  // requireOwnerDockerAccess rejects malformed Owner permissions with 403
  let dockerMiddlewareStatus = 200;
  let dockerMiddlewareBody = null;
  let dockerNextCalled = false;
  requireOwnerDockerAccess(
    {
      auth: {
        user: { id: 'o1', role: 'owner' },
        access: { mode: 'management', permissions: ['domains:write'] },
        security: { managementAllowed: true },
      },
    },
    { status(c) { dockerMiddlewareStatus = c; return this; }, json(b) { dockerMiddlewareBody = b; return this; } },
    () => { dockerNextCalled = true; },
  );
  assert.equal(dockerNextCalled, false);
  assert.equal(dockerMiddlewareStatus, 403);
  assert.equal(dockerMiddlewareBody.error.code, 'docker_owner_required');

  // Direct assertOwnerProxyRouteAccess checks: missing/incomplete auth -> 401 BEFORE unchanged-route bypass
  for (const missingAuth of [undefined, null, {}, { user: { role: 'owner' } }, { user: { role: 'owner' }, access: { mode: 'management', permissions: ['*'] } }]) {
    assert.throws(
      () => assertOwnerProxyRouteAccess({ auth: missingAuth }, [route], { proxyRoutes: [route] }),
      (err) => err?.code === 'unauthorized' && err.status === 401,
    );
  }

  const createHandler = createDomainHandler(fx.domainRegistry, {
    localServerId: fx.serverId,
    dockerComposeProjectRegistry: fx.projectRegistry,
    jobRegistry: fx.jobRegistry,
    siteMutationLock: fx.siteMutationLock,
  });
  const previewHandler = createDomainUpdatePreviewHandler(fx.domainRegistry, {
    localServerId: fx.serverId,
    dockerComposeProjectRegistry: fx.projectRegistry,
    jobRegistry: fx.jobRegistry,
  });
  const updateHandler = createDomainUpdateHandler(fx.domainRegistry, {
    localServerId: fx.serverId,
    dockerComposeProjectRegistry: fx.projectRegistry,
    jobRegistry: fx.jobRegistry,
    siteMutationLock: fx.siteMutationLock,
  });
  const coreApp = createCoreApp({
    registry: fx.serverRegistry,
    domainRegistry: fx.domainRegistry,
    websiteRegistry: fx.websiteRegistry,
    applicationRegistry: fx.applicationRegistry,
    jobRegistry: fx.jobRegistry,
    dockerComposeProjectRegistry: fx.projectRegistry,
    siteMutationLock: fx.siteMutationLock,
    localServerId: fx.serverId,
  });
  const coreCreateHandler = coreApp.router.stack
    .find((layer) => layer.route?.path === '/api/domains' && layer.route.methods.post)
    .route.stack.at(-1).handle;

  async function callHandler(handler, req) {
    let capturedError = null;
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    try {
      await handler(req, res, (err) => { capturedError = err; });
    } catch (err) {
      capturedError = err;
    }
    return { error: capturedError, res };
  }

  const createBody = {
    serverId: fx.serverId,
    websiteId: fx.website.id,
    primaryDomain: 'no-auth-create.example.com',
    targetType: 'static',
    target: { root: fx.website.documentRoot, spaFallback: true },
    nginxSettings: { proxyRoutes: [route] },
  };
  const unchangedChanges = { nginxSettings: { ...fx.domain.nginxSettings, gzip: true, proxyRoutes: [route] } };
  const unchangedPrev = await fx.domainRegistry.previewDomainUpdate({ domainId: fx.domain.id, changes: unchangedChanges });
  const mutatedChanges = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [] } };
  const mutatedPrev = await fx.domainRegistry.previewDomainUpdate({ domainId: fx.domain.id, changes: mutatedChanges });

  // Missing request.auth -> 401 unauthorized across all 4 handlers (even for unchanged proxyRoutes!)
  assert.equal((await callHandler(createHandler, { body: createBody })).error?.status, 401);
  assert.equal((await callHandler(coreCreateHandler, { body: createBody })).error?.status, 401);
  assert.equal((await callHandler(previewHandler, { params: { domainId: fx.domain.id }, body: { changes: unchangedChanges } })).error?.status, 401);
  assert.equal((await callHandler(updateHandler, {
    params: { domainId: fx.domain.id },
    body: { changes: unchangedChanges, previewDigest: unchangedPrev.previewDigest, confirmation: unchangedPrev.confirmation },
  })).error?.status, 401);

  // Malformed Owner permissions & non-Owner roles -> 403 proxy_routes_owner_only on create or mutation
  const malformedOwnerAuth = {
    user: { id: 'o1', role: 'owner' },
    access: { mode: 'management', permissions: ['domains:write'] },
    security: { managementAllowed: true },
  };
  const customerAuth = {
    user: { id: 'c1', role: 'site_manager', websiteIds: [fx.website.id] },
    access: { mode: 'site_management', permissions: ['site:domains'], websiteIds: [fx.website.id] },
    security: { managementAllowed: true },
  };
  for (const restrictedAuth of [malformedOwnerAuth, customerAuth]) {
    const rCreate = await callHandler(createHandler, { auth: restrictedAuth, body: createBody });
    assert.equal(rCreate.error?.status, 403);
    assert.equal(rCreate.error?.code, 'proxy_routes_owner_only');

    const rCoreCreate = await callHandler(coreCreateHandler, { auth: restrictedAuth, body: createBody });
    assert.equal(rCoreCreate.error?.status, 403);
    assert.equal(rCoreCreate.error?.code, 'proxy_routes_owner_only');

    const rPrevMut = await callHandler(previewHandler, {
      auth: restrictedAuth,
      params: { domainId: fx.domain.id },
      body: { changes: mutatedChanges },
    });
    assert.equal(rPrevMut.error?.status, 403);
    assert.equal(rPrevMut.error?.code, 'proxy_routes_owner_only');

    const rUpdMut = await callHandler(updateHandler, {
      auth: restrictedAuth,
      params: { domainId: fx.domain.id },
      body: { changes: mutatedChanges, previewDigest: mutatedPrev.previewDigest, confirmation: mutatedPrev.confirmation },
    });
    assert.equal(rUpdMut.error?.status, 403);
    assert.equal(rUpdMut.error?.code, 'proxy_routes_owner_only');

    // Authenticated non-Owner / restricted actor CAN still preview with strictly unchanged proxyRoutes
    const rPrevUnchanged = await callHandler(previewHandler, {
      auth: restrictedAuth,
      params: { domainId: fx.domain.id },
      body: { changes: unchangedChanges },
    });
    assert.equal(rPrevUnchanged.error, null);
    assert.equal(rPrevUnchanged.res.statusCode, 200);
  }
});

test('DOMAIN_STAGE TOCTOU defense uses authoritative locked domain nginxSettings and rejects stale revision or concurrent route drift with 409', async (t) => {
  const fx = await createRealFixture(t);
  const owner = await fx.loginAs('owner');

  const projectA = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'toctou_stack_a',
    document: COMPOSE_INITIAL,
  })).json.data.project;
  const projectB = (await owner.api('POST', '/api/docker/projects', {
    serverId: fx.serverId,
    projectName: 'toctou_stack_b',
    document: 'services:\n  api:\n    image: node:22-alpine\n    ports:\n      - "127.0.0.1:13002:3000/tcp"\n',
  })).json.data.project;

  const routeA = {
    path: '/api',
    projectId: projectA.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  };
  const routeB = {
    path: '/api',
    projectId: projectB.id,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13002,
    websocket: true,
    stripPrefix: false,
  };

  // Persist routeA on real domainRegistry
  const attachChanges = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [routeA] } };
  const attachPrev = (await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: attachChanges })).json.data;
  assert.equal((await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: attachChanges,
    previewDigest: attachPrev.previewDigest,
    confirmation: attachPrev.confirmation,
  })).status, 200);
  const currentDomain = await fx.domainRegistry.getDomain(fx.domain.id);

  // 1. Stale input.payload.nginxSettings cannot override authoritative lockedDomain.nginxSettings
  const stagedJob = await fx.jobRegistry.enqueue({
    serverId: fx.serverId,
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    resourceType: 'domain',
    resourceId: currentDomain.id,
    payload: {
      domainRevision: currentDomain.desiredRevision,
      primaryDomain: currentDomain.primaryDomain,
      aliases: currentDomain.aliases,
      targetType: currentDomain.targetType,
      target: currentDomain.target,
      nginxSettings: { ...currentDomain.nginxSettings, proxyRoutes: [routeB] },
      canonicalRedirect: currentDomain.canonicalRedirect,
      httpsRedirect: currentDomain.httpsRedirect,
    },
  });
  assert.deepEqual(stagedJob.payload.nginxSettings.proxyRoutes, [routeA]);
  assert.equal(stagedJob.payload.domainRevision, currentDomain.desiredRevision);
  await fx.baseJobRegistry.cancel(stagedJob.id);

  // 2. Stale input.payload.domainRevision fails closed with 409 domain_stage_routing_drift
  await assert.rejects(
    fx.jobRegistry.enqueue({
      serverId: fx.serverId,
      type: 'domain.stage',
      operation: OPERATIONS.DOMAIN_STAGE,
      resourceType: 'domain',
      resourceId: currentDomain.id,
      payload: {
        domainRevision: currentDomain.desiredRevision - 1,
        primaryDomain: currentDomain.primaryDomain,
        aliases: currentDomain.aliases,
        targetType: currentDomain.targetType,
        target: currentDomain.target,
        nginxSettings: currentDomain.nginxSettings,
        canonicalRedirect: currentDomain.canonicalRedirect,
        httpsRedirect: currentDomain.httpsRedirect,
      },
    }),
    (err) => err?.code === 'domain_stage_routing_drift' && err.status === 409,
  );

  // 3. Concurrent domain route drift between pre-lock read and in-lock re-read fails closed 409
  const jobsBeforeRace = (await fx.baseJobRegistry.listJobs()).length;
  let mutatedDuringLock = false;
  const racingLock = {
    withDockerProjectLocks(ids, action) {
      return fx.siteMutationLock.withDockerProjectLocks(ids, async () => {
        if (!mutatedDuringLock) {
          mutatedDuringLock = true;
          const nextChanges = { nginxSettings: { ...currentDomain.nginxSettings, proxyRoutes: [routeB] } };
          const p = await fx.domainRegistry.previewDomainUpdate({ domainId: currentDomain.id, changes: nextChanges });
          await fx.domainRegistry.updateDomain({
            domainId: currentDomain.id,
            changes: nextChanges,
            previewDigest: p.previewDigest,
            skipLock: true,
          });
        }
        return action();
      });
    },
  };
  const racingStageRegistry = createDomainStageTargetJobRegistry({
    registry: fx.baseJobRegistry,
    domainRegistry: fx.domainRegistry,
    websiteRegistry: fx.websiteRegistry,
    dockerComposeProjectRegistry: fx.projectRegistry,
    applicationRegistry: fx.applicationRegistry,
    runtimeBindingRegistry: fx.runtimeBindingRegistry,
    siteMutationLock: racingLock,
  });

  await assert.rejects(
    racingStageRegistry.enqueue({
      serverId: fx.serverId,
      type: 'domain.stage',
      operation: OPERATIONS.DOMAIN_STAGE,
      resourceType: 'domain',
      resourceId: currentDomain.id,
      payload: {
        domainRevision: currentDomain.desiredRevision,
        primaryDomain: currentDomain.primaryDomain,
        aliases: currentDomain.aliases,
        targetType: currentDomain.targetType,
        target: currentDomain.target,
        nginxSettings: currentDomain.nginxSettings,
        canonicalRedirect: currentDomain.canonicalRedirect,
        httpsRedirect: currentDomain.httpsRedirect,
      },
    }),
    (err) => err?.code === 'domain_stage_routing_drift' && err.status === 409,
  );
  assert.equal(mutatedDuringLock, true);
  assert.equal((await fx.baseJobRegistry.listJobs()).length, jobsBeforeRace);
});

test('legacy Compose projects sharing a published host port allow unchanged routine edits, block new/changed port conflicts, block non-exclusive proxyRoutes (409), and allow binding once exclusive', async (t) => {
  const sharedDocA = [
    'services:',
    '  web:',
    '    image: nginx:1.25-alpine',
    '    ports:',
    '      - "127.0.0.1:18123:80/tcp"',
    '',
  ].join('\n');
  const sharedDocB = [
    'services:',
    '  web:',
    '    image: caddy:2-alpine',
    '    ports:',
    '      - "127.0.0.1:18123:80/tcp"',
    '',
  ].join('\n');
  const thirdDocC = [
    'services:',
    '  web:',
    '    image: httpd:2.4-alpine',
    '    ports:',
    '      - "127.0.0.1:18199:80/tcp"',
    '',
  ].join('\n');

  let legacyAId = null;
  let legacyBId = null;

  const fx = await createRealFixture(t, {
    seedProjectsFile: async ({ rootDir, projectsFilePath, masterKey, serverId, validateDockerCompose }) => {
      // Create 3 real encrypted records in isolated temporary files using real docker compose CLI,
      // then combine them into one legacy persisted store simulating pre-Slice-A port sharing.
      const records = [];
      for (const [name, doc] of [['legacy_a', sharedDocA], ['legacy_b', sharedDocB], ['legacy_c', thirdDocC]]) {
        const tmpStore = path.join(rootDir, `seed-${name}.json`);
        const reg = createDockerComposeProjectRegistry({
          filePath: tmpStore,
          masterKey,
          serverExists: async () => true,
        });
        await reg.init();
        const validation = await validateDockerCompose({
          projectName: name,
          document: doc,
          environment: {},
          interpolate: false,
        });
        const created = await reg.createProject({ serverId, projectName: name, document: doc, validation });
        if (name === 'legacy_a') legacyAId = created.id;
        if (name === 'legacy_b') legacyBId = created.id;
        const parsed = JSON.parse(await readFile(tmpStore, 'utf8'));
        records.push(...parsed.projects);
      }
      await writeFile(projectsFilePath, JSON.stringify({ version: 1, projects: records }, null, 2), { mode: 0o600 });
    },
  });

  const owner = await fx.loginAs('owner');

  // 1. Routine YAML edit on legacy_a (image + env, unchanged 127.0.0.1:18123:80/tcp) MUST SUCCEED
  const routineDocA = [
    'services:',
    '  web:',
    '    image: nginx:1.27-alpine',
    '    environment:',
    '      APP_ENV: production',
    '    ports:',
    '      - "127.0.0.1:18123:80/tcp"',
    '',
  ].join('\n');
  const routineRes = await owner.api('PUT', `/api/docker/projects/${legacyAId}`, {
    expectedRevision: 1,
    document: routineDocA,
  });
  assert.equal(routineRes.status, 200);
  assert.equal(routineRes.json.data.revision, 2);

  // 2a. Widening 127.0.0.1:18123 -> 0.0.0.0:18123 collides with legacy_b -> 409 docker_compose_published_port_conflict
  const widenRes = await owner.api('PUT', `/api/docker/projects/${legacyAId}`, {
    expectedRevision: 2,
    document: 'services:\n  web:\n    image: nginx:1.27-alpine\n    ports:\n      - "0.0.0.0:18123:80/tcp"\n',
  });
  assert.equal(widenRes.status, 409);
  assert.equal(widenRes.json.error.code, 'docker_compose_published_port_conflict');

  // 2b. Moving legacy_a to 127.0.0.1:18199 (held by legacy_c) -> 409 docker_compose_published_port_conflict
  const collideCRes = await owner.api('PUT', `/api/docker/projects/${legacyAId}`, {
    expectedRevision: 2,
    document: 'services:\n  web:\n    image: nginx:1.27-alpine\n    ports:\n      - "127.0.0.1:18199:80/tcp"\n',
  });
  assert.equal(collideCRes.status, 409);
  assert.equal(collideCRes.json.error.code, 'docker_compose_published_port_conflict');

  // 3. Binding a /api proxyRoute to legacy_a's shared 127.0.0.1:18123 FAILS on create, update-preview, PATCH, and stage -> 409
  const sharedRoute = {
    path: '/api',
    projectId: legacyAId,
    serviceName: 'web',
    targetPort: 80,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 18123,
    websocket: true,
    stripPrefix: false,
  };
  const createSharedRes = await owner.api('POST', '/api/domains', {
    serverId: fx.serverId,
    websiteId: fx.website.id,
    primaryDomain: 'shared-port.example.com',
    targetType: 'static',
    target: { root: fx.website.documentRoot, spaFallback: true },
    nginxSettings: { proxyRoutes: [sharedRoute] },
  });
  assert.equal(createSharedRes.status, 409);
  assert.equal(createSharedRes.json.error.code, 'docker_proxy_route_port_shared_across_projects');

  const routeChanges = { nginxSettings: { ...fx.domain.nginxSettings, proxyRoutes: [sharedRoute] } };
  const previewSharedRes = await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: routeChanges });
  assert.equal(previewSharedRes.status, 409);
  assert.equal(previewSharedRes.json.error.code, 'docker_proxy_route_port_shared_across_projects');

  const directPrev = await fx.domainRegistry.previewDomainUpdate({ domainId: fx.domain.id, changes: routeChanges });
  const patchSharedRes = await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: routeChanges,
    previewDigest: directPrev.previewDigest,
    confirmation: directPrev.confirmation,
  });
  assert.equal(patchSharedRes.status, 409);
  assert.equal(patchSharedRes.json.error.code, 'docker_proxy_route_port_shared_across_projects');

  const preExistingSharedDomain = await fx.domainRegistry.createDomain({
    serverId: fx.serverId,
    websiteId: fx.website.id,
    primaryDomain: 'preexisting-shared.example.com',
    targetType: 'static',
    target: { root: fx.website.documentRoot, spaFallback: true },
    nginxSettings: { proxyRoutes: [sharedRoute] },
  });
  const stageSharedRes = await owner.api('POST', `/api/domains/${preExistingSharedDomain.id}/stage`, {});
  assert.equal(stageSharedRes.status, 409);
  assert.equal(stageSharedRes.json.error.code, 'docker_proxy_route_port_shared_across_projects');

  // 4. Move legacy_b to 127.0.0.1:18124 -> legacy_a's 127.0.0.1:18123 is now exclusive -> preview, PATCH, and stage SUCCEED!
  const moveBRes = await owner.api('PUT', `/api/docker/projects/${legacyBId}`, {
    expectedRevision: 1,
    document: 'services:\n  web:\n    image: caddy:2-alpine\n    ports:\n      - "127.0.0.1:18124:80/tcp"\n',
  });
  assert.equal(moveBRes.status, 200);

  const previewExclusiveRes = await owner.api('POST', `/api/domains/${fx.domain.id}/update-preview`, { changes: routeChanges });
  assert.equal(previewExclusiveRes.status, 200);

  const patchExclusiveRes = await owner.api('PATCH', `/api/domains/${fx.domain.id}`, {
    changes: routeChanges,
    previewDigest: previewExclusiveRes.json.data.previewDigest,
    confirmation: previewExclusiveRes.json.data.confirmation,
  });
  assert.equal(patchExclusiveRes.status, 200);

  const stageExclusiveRes = await owner.api('POST', `/api/domains/${fx.domain.id}/stage`, {});
  assert.equal(stageExclusiveRes.status, 202);
  const stagedExclusiveJob = await fx.baseJobRegistry.getJob(stageExclusiveRes.json.data.id);
  assert.deepEqual(stagedExclusiveJob.payload.nginxSettings.proxyRoutes, [sharedRoute]);
});
