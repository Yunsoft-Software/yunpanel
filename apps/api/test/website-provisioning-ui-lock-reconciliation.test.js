// Pre-execution HTTP lock boundary test ONLY (handlers: {} — zero host step handlers,
// zero Linux/Unix/FPM/SFTP/Nginx simulation, zero fabricated ready:true).
// Full 10/10 host step execution and UI ready:true acceptance belong strictly to
// guarded native live-audit channels after candidate package deployment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createApplicationRegistry } from '../src/application-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { mountSiteCreateRoutes, SiteCreateError } from '../src/site-create-http.js';
import { createSiteMutationLock, SiteMutationLockError } from '../src/site-mutation-lock.js';
import { mountWebsiteProvisioningRoutes, WebsiteProvisioningHttpError } from '../src/website-provisioning-http.js';
import {
  createWebsiteProvisioningOrchestrator,
  WebsiteProvisioningOrchestratorError,
} from '../src/website-provisioning-orchestrator.js';
import {
  createWebsiteProvisioningRegistry,
  WebsiteProvisioningRegistryError,
} from '../src/website-provisioning-registry.js';
import { createWebsiteRegistry, WebsiteRegistryError } from '../src/website-registry.js';

import { panelRequest } from '../../web/src/api.js';
import { setSession } from '../../web/src/session-client.js';
import { autoAdvanceWebsiteProvisioning } from '../../web/src/workspace/provisioning-client.js';
import { createSiteSubmission } from '../../web/src/workspace/site-create-submission.js';

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function createPreExecutionLockEnv(t) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t894-preexec-lock-'));
  const lockRoot = path.join(tempDir, 'locks');
  const storeDir = path.join(tempDir, 'stores');
  await mkdir(storeDir, { recursive: true, mode: 0o700 });

  const barrierReleases = [];
  const activeLockPromises = [];
  const registerDeferred = () => {
    const deferred = createDeferred();
    barrierReleases.push(deferred.resolve);
    return deferred;
  };

  const authStore = createAuthStore({ filePath: path.join(storeDir, 'auth.sqlite') });
  const { token: setupToken } = authStore.issueSetupToken();
  await authStore.completeSetup({
    setupToken,
    username: 'T894Owner',
    password: 'OwnerStrongPassword123!',
  });
  const ownerLogin = await authStore.login({
    username: 'T894Owner',
    password: 'OwnerStrongPassword123!',
  });
  const ownerToken = ownerLogin.token;
  const sessionCookie = `yunpanel_session=${ownerToken}`;
  const csrfToken = ownerLogin.session.csrfToken;

  const siteMutationLock = createSiteMutationLock({ root: lockRoot });
  const serverRegistry = createServerRegistry({ filePath: path.join(storeDir, 'servers.json') });
  await serverRegistry.init();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 't894-local-host' });
  const enrolled = await serverRegistry.enrollServer({
    token: enrollment.token,
    hostname: 't894-local-host.internal',
    executionMode: 'local',
  });
  const localServerId = enrolled.server.id;

  const serverExists = async (id) => Boolean(await serverRegistry.getServer(id));
  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(storeDir, 'applications.json'),
    serverExists,
  });
  const dockerWorkloadRegistry = createDockerWorkloadRegistry({
    filePath: path.join(storeDir, 'docker.json'),
    serverExists,
  });
  const websiteRegistry = createWebsiteRegistry({
    filePath: path.join(storeDir, 'websites.json'),
    serverExists,
    getApplication: (id) => applicationRegistry.getApplication(id),
    getDockerWorkload: (id) => dockerWorkloadRegistry.getWorkload(id),
  });
  const domainRegistry = createDomainRegistry({
    filePath: path.join(storeDir, 'domains.json'),
    serverExists,
    getWebsite: (id) => websiteRegistry.getWebsite(id),
    websiteBindingRequired: () => true,
  });
  const dnsHostingRegistry = createDnsHostingRegistry({
    filePath: path.join(storeDir, 'dns-zones.json'),
    getWebDomain: (id) => domainRegistry.getDomain(id),
  });
  const mailDomainRegistry = createMailDomainRegistry({
    filePath: path.join(storeDir, 'mail-domains.json'),
    getWebDomain: (id) => domainRegistry.getDomain(id),
  });
  const provisioningRegistry = createWebsiteProvisioningRegistry({
    filePath: path.join(storeDir, 'provisioning.json'),
  });

  await Promise.all([
    applicationRegistry.init(),
    dockerWorkloadRegistry.init(),
    websiteRegistry.init(),
    domainRegistry.init(),
    dnsHostingRegistry.init(),
    mailDomainRegistry.init(),
    provisioningRegistry.init(),
  ]);

  // Zero step handlers: any attempt to execute a host step fails immediately with 503
  // website_provisioning_handler_unavailable, proving 409 happens strictly pre-execution.
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry: provisioningRegistry,
    handlers: {},
  });

  const traffic = [];
  let onContinue409 = null;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  mountSiteCreateRoutes(app, {
    localServerId,
    registry: serverRegistry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    websiteProvisioningRegistry: provisioningRegistry,
    siteMutationLock,
  });

  mountWebsiteProvisioningRoutes(app, {
    registry: provisioningRegistry,
    orchestrator,
    websiteRegistry,
    localServerId,
    siteMutationLock,
  });

  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SiteCreateError
      || error instanceof WebsiteProvisioningHttpError
      || error instanceof WebsiteProvisioningOrchestratorError
      || error instanceof WebsiteProvisioningRegistryError
      || error instanceof SiteMutationLockError
      || error instanceof WebsiteRegistryError) {
      return res.status(error.status ?? 400).json({
        error: { code: error.code, message: error.message },
      });
    }
    return res.status(500).json({
      error: { code: 'internal_error', message: error?.message ?? 'Unexpected error' },
    });
  });

  const server = http.createServer((req, res) => {
    res.on('finish', () => {
      traffic.push({
        method: req.method,
        url: req.url,
        status: res.statusCode,
      });
      if (req.method === 'POST' && req.url?.endsWith('/continue') && res.statusCode === 409) {
        const hook = onContinue409;
        onContinue409 = null;
        hook?.();
      }
    });
    listener(req, res);
  });
  let listener = (_req, res) => res.writeHead(503).end();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const publicOrigin = `http://127.0.0.1:${port}`;
  listener = createAuthenticatedApi({
    store: authStore,
    publicOrigin,
    development: true,
    ownerMfaRequired: false,
    createHandler: () => app,
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const targetUrl = typeof input === 'string' && input.startsWith('/')
      ? `${publicOrigin}${input}`
      : input;
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('cookie')) headers.set('cookie', sessionCookie);
    if (!headers.has('origin')) headers.set('origin', publicOrigin);
    return realFetch(targetUrl, { ...init, headers });
  };
  setSession({ csrfToken });

  async function holdWebsiteLock(websiteId) {
    const acquired = registerDeferred();
    const releaseGate = registerDeferred();
    const lockTask = siteMutationLock.withSiteLock({ websiteId }, async () => {
      acquired.resolve();
      await releaseGate.promise;
    });
    activeLockPromises.push(lockTask);
    await acquired.promise;
    return async () => {
      releaseGate.resolve();
      await lockTask;
    };
  }

  t.after(async () => {
    for (const release of barrierReleases) release();
    await Promise.allSettled(activeLockPromises);
    globalThis.fetch = realFetch;
    setSession(null);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    try { authStore.close(); } catch {}
    await rm(tempDir, { recursive: true, force: true });
  });

  return {
    localServerId,
    authStore,
    ownerToken,
    csrfToken,
    websiteRegistry,
    provisioningRegistry,
    traffic,
    holdWebsiteLock,
    setOnContinue409(fn) {
      onContinue409 = fn;
    },
  };
}

test('pre-execution 409 site_mutation_locked over real AuthStore/CSRF/SiteMutationLock sends zero second POST and never fabricates ready:true', async (t) => {
  const env = await createPreExecutionLockEnv(t);
  let releaseLock = null;

  const flow = createSiteSubmission({
    request: panelRequest,
    advance: async (operationId, options) => {
      const op = await env.provisioningRegistry.get(operationId);
      releaseLock = await env.holdWebsiteLock(op.websiteId);
      return autoAdvanceWebsiteProvisioning(operationId, {
        ...options,
        lockPollLimit: 3,
        lockPollDelayMs: 15,
      });
    },
  });

  const finalState = await flow.submit({
    operationId: randomUUID(),
    serverId: env.localServerId,
    name: 'T894 PreExec Lock Site',
    primaryDomain: `t894-lock-${randomUUID().slice(0, 8)}.example.test`,
    parentDomainId: null,
    wwwMode: 'none',
    httpsMode: 'off',
    dns: { mode: 'external' },
    mail: { mode: 'none' },
    source: { kind: 'new_static' },
  });
  await releaseLock?.();

  const createPosts = env.traffic.filter((entry) => entry.method === 'POST' && entry.url === '/api/sites');
  const continuePosts = env.traffic.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/continue'));
  const statusGets = env.traffic.filter((entry) => entry.method === 'GET' && entry.url.startsWith('/api/sites/provisioning/'));

  assert.equal(createPosts.length, 1, 'Yeni create isteği tekrarlanmamalı');
  assert.equal(continuePosts.length, 1, '409 site_mutation_locked sonrası ikinci POST /continue atılmamalı');
  assert.equal(continuePosts[0].status, 409);
  assert.equal(statusGets.length, 4, '1 ilk GET + 3 sınırlı kilit okuma GET isteği yapılmalı');
  assert.ok(statusGets.every((entry) => entry.status === 200));

  // Without host execution, ready:true is NEVER fabricated.
  assert.equal(finalState.phase, 'attention');
  assert.equal(finalState.steps.length, 10);
  assert.equal(finalState.steps.filter((step) => step.state === 'succeeded').length, 3);
  assert.equal(finalState.steps.filter((step) => step.state === 'pending').length, 7);
});

test('real failed journal transition on disk during lock contention stops GET polling immediately and surfaces failed step', async (t) => {
  const env = await createPreExecutionLockEnv(t);
  let releaseLock = null;
  let trackedOperationId = null;

  env.setOnContinue409(() => {
    void (async () => {
      await env.provisioningRegistry.beginStep({
        operationId: trackedOperationId,
        stepId: 'unix_identity',
      });
      await env.provisioningRegistry.failStep({
        operationId: trackedOperationId,
        stepId: 'unix_identity',
        error: 'unix_identity_apply_failed',
      });
    })();
  });

  let lastReconciledOp = null;
  const flow = createSiteSubmission({
    request: panelRequest,
    advance: async (operationId, options) => {
      trackedOperationId = operationId;
      const op = await env.provisioningRegistry.get(operationId);
      releaseLock = await env.holdWebsiteLock(op.websiteId);
      lastReconciledOp = await autoAdvanceWebsiteProvisioning(operationId, {
        ...options,
        lockPollLimit: 25,
        lockPollDelayMs: 20,
      });
      return lastReconciledOp;
    },
  });

  const finalState = await flow.submit({
    operationId: randomUUID(),
    serverId: env.localServerId,
    name: 'T894 Journal Failure Site',
    primaryDomain: `t894-fail-${randomUUID().slice(0, 8)}.example.test`,
    parentDomainId: null,
    wwwMode: 'none',
    httpsMode: 'off',
    dns: { mode: 'external' },
    mail: { mode: 'none' },
    source: { kind: 'new_static' },
  });
  await releaseLock?.();

  const continuePosts = env.traffic.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/continue'));
  const statusGets = env.traffic.filter((entry) => entry.method === 'GET' && entry.url.startsWith('/api/sites/provisioning/'));

  assert.equal(continuePosts.length, 1);
  assert.equal(continuePosts[0].status, 409);
  assert.ok(statusGets.length >= 2 && statusGets.length < 10, 'failed okunur okunmaz sınırlı poll bütçesi tüketilmeden durmalı');

  assert.equal(finalState.phase, 'attention');
  const unixStep = finalState.steps.find((step) => step.id === 'unix_identity');
  assert.equal(unixStep?.state, 'failed');
  assert.equal(lastReconciledOp?.ready, false);
  const reconciledUnixStep = lastReconciledOp?.steps.find((step) => step.id === 'unix_identity');
  assert.equal(reconciledUnixStep?.state, 'failed');
  assert.equal(reconciledUnixStep?.canRetry, true);
});

test('AuthStore session revocation during lock-contention GET polling rejects immediately with HTTP 401 without extra POST', async (t) => {
  const env = await createPreExecutionLockEnv(t);
  const website = await env.websiteRegistry.createWebsite({
    name: 'T894 Auth Revoke Site',
    serverId: env.localServerId,
    runtimeType: 'proxy',
    proxyTarget: { host: '198.51.100.20', port: 8080, websocket: true },
  });
  const operationId = randomUUID();
  await env.provisioningRegistry.create({
    operationId,
    websiteId: website.id,
    steps: [{
      id: 'nginx',
      kind: 'nginx',
      required: true,
      state: 'pending',
      intent: { primaryDomain: 'revoke.example.test' },
      compensation: { state: 'pending' },
    }],
  });

  const releaseLock = await env.holdWebsiteLock(website.id);
  env.setOnContinue409(() => {
    env.authStore.revokeSession(env.ownerToken);
  });

  await assert.rejects(
    autoAdvanceWebsiteProvisioning(operationId, {
      lockPollLimit: 20,
      lockPollDelayMs: 15,
    }),
    (err) => err?.status === 401 && err?.code === 'unauthorized',
  );
  await releaseLock();

  const continuePosts = env.traffic.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/continue'));
  const statusGets = env.traffic.filter((entry) => entry.method === 'GET' && entry.url.startsWith('/api/sites/provisioning/'));
  assert.equal(continuePosts.length, 1);
  assert.equal(continuePosts[0].status, 409);
  assert.equal(statusGets.length, 2);
  assert.equal(statusGets[0].status, 200);
  assert.equal(statusGets[1].status, 401);
});

test('AbortSignal and session_superseded boundaries cancel lock-contention polling immediately without extra POST or GET', async (t) => {
  const env = await createPreExecutionLockEnv(t);
  const website = await env.websiteRegistry.createWebsite({
    name: 'T894 Abort Boundary Site',
    serverId: env.localServerId,
    runtimeType: 'proxy',
    proxyTarget: { host: '198.51.100.21', port: 8080, websocket: true },
  });
  const operationId = randomUUID();
  await env.provisioningRegistry.create({
    operationId,
    websiteId: website.id,
    steps: [{
      id: 'nginx',
      kind: 'nginx',
      required: true,
      state: 'pending',
      intent: { primaryDomain: 'abort.example.test' },
      compensation: { state: 'pending' },
    }],
  });

  const releaseLock = await env.holdWebsiteLock(website.id);

  // 1) AbortSignal cancels pending poll timer immediately
  const controller = new AbortController();
  env.setOnContinue409(() => {
    setTimeout(() => controller.abort(), 15);
  });
  const startedAt = Date.now();
  await assert.rejects(
    autoAdvanceWebsiteProvisioning(operationId, {
      signal: controller.signal,
      lockPollLimit: 10,
      lockPollDelayMs: 3000,
    }),
    { name: 'AbortError' },
  );
  assert.ok(Date.now() - startedAt < 1000);

  // 2) Client session rotation (session_superseded) aborts immediately
  env.traffic.length = 0;
  env.setOnContinue409(() => {
    setSession({ csrfToken: 'rotated-csrf-token' });
  });
  await assert.rejects(
    autoAdvanceWebsiteProvisioning(operationId, {
      lockPollLimit: 10,
      lockPollDelayMs: 15,
    }),
    { name: 'AbortError', code: 'session_superseded' },
  );
  await releaseLock();

  const continuePosts = env.traffic.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/continue'));
  const statusGets = env.traffic.filter((entry) => entry.method === 'GET' && entry.url.startsWith('/api/sites/provisioning/'));
  assert.equal(continuePosts.length, 1);
  assert.equal(statusGets.length, 1);
});

test('non-lock HTTP 409 (website_provisioning_abandoned) over real HTTP is never polled and fails closed immediately', async (t) => {
  const env = await createPreExecutionLockEnv(t);
  const websiteId = randomUUID();
  const operationId = randomUUID();
  await env.provisioningRegistry.create({
    operationId,
    websiteId,
    steps: [{
      id: 'nginx',
      kind: 'nginx',
      required: true,
      state: 'pending',
      intent: { primaryDomain: 'abandoned.example.test' },
      compensation: { state: 'pending' },
    }],
  });

  // Initial GET sees active pending step; right before POST /continue we mark journal abandoned on disk.
  const origGet = env.provisioningRegistry.get;
  let firstReadSeen = false;
  const wrappedOrchestratorOpId = operationId;
  await assert.rejects(
    (async () => {
      const readOnceThenAbandon = async () => {
        if (!firstReadSeen) {
          firstReadSeen = true;
          await env.provisioningRegistry.abandonUncreated({
            operationId: wrappedOrchestratorOpId,
            websiteId,
            websiteAbsent: true,
            applicationAbsent: false,
          });
        }
      };
      // Trigger initial read via real HTTP, then abandon before POST /continue:
      const realGlobalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const res = await realGlobalFetch(input, init);
        if (typeof input === 'string' && input.endsWith(`/sites/provisioning/${operationId}`) && (!init?.method || init.method === 'GET')) {
          await readOnceThenAbandon();
        }
        return res;
      };
      try {
        return await autoAdvanceWebsiteProvisioning(operationId, {
          lockPollLimit: 10,
          lockPollDelayMs: 10,
        });
      } finally {
        globalThis.fetch = realGlobalFetch;
        void origGet;
      }
    })(),
    (err) => err?.status === 409 && err?.code === 'website_provisioning_abandoned',
  );

  const continuePosts = env.traffic.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/continue'));
  const statusGets = env.traffic.filter((entry) => entry.method === 'GET' && entry.url.startsWith('/api/sites/provisioning/'));
  assert.equal(continuePosts.length, 1);
  assert.equal(continuePosts[0].status, 409);
  assert.equal(statusGets.length, 1, 'Kilit kodu taşımayan 409 sonrası GET polling başlamamalı');
});
