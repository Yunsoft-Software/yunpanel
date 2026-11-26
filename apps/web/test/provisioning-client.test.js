// Client boundary tests against real loopback HTTP + AuthStore + CSRF + SiteMutationLock
// + disk WebsiteProvisioningRegistry (handlers: {} — zero host step simulators, zero stub Responses,
// and ready:true is never simulated here).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createAuthenticatedApi } from '../../api/src/auth/auth-http.js';
import { createAuthStore } from '../../api/src/auth/auth-store.js';
import { createSiteMutationLock, SiteMutationLockError } from '../../api/src/websites/site-mutation-lock.js';
import { mountWebsiteProvisioningRoutes, WebsiteProvisioningHttpError } from '../../api/src/provisioning/website-provisioning-http.js';
import {
  createWebsiteProvisioningOrchestrator,
  WebsiteProvisioningOrchestratorError,
} from '../../api/src/provisioning/website-provisioning-orchestrator.js';
import {
  createWebsiteProvisioningRegistry,
  WebsiteProvisioningRegistryError,
} from '../../api/src/provisioning/website-provisioning-registry.js';
import { createWebsiteRegistry, WebsiteRegistryError } from '../../api/src/websites/website-registry.js';

import { setSession } from '../src/session-client.js';
import { autoAdvanceWebsiteProvisioning } from '../src/workspace/provisioning-client.js';

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function createRealProvisioningClientEnv(t) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-t894-client-'));
  const lockRoot = path.join(tempDir, 'locks');
  const storeDir = path.join(tempDir, 'stores');
  await mkdir(storeDir, { recursive: true, mode: 0o700 });

  const barrierReleases = [];
  const activeLockTasks = [];
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
  let currentLogin = await authStore.login({
    username: 'T894Owner',
    password: 'OwnerStrongPassword123!',
  });

  const localServerId = randomUUID();
  const siteMutationLock = createSiteMutationLock({ root: lockRoot });
  const websiteRegistry = createWebsiteRegistry({
    filePath: path.join(storeDir, 'websites.json'),
    serverExists: async (id) => id === localServerId,
  });
  const provisioningRegistry = createWebsiteProvisioningRegistry({
    filePath: path.join(storeDir, 'provisioning.json'),
  });
  await Promise.all([websiteRegistry.init(), provisioningRegistry.init()]);

  // Strictly zero host step handlers: no Unix/FPM/SFTP/Nginx simulation.
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry: provisioningRegistry,
    handlers: {},
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  mountWebsiteProvisioningRoutes(app, {
    registry: provisioningRegistry,
    orchestrator,
    websiteRegistry,
    localServerId,
    siteMutationLock,
  });

  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof WebsiteProvisioningHttpError
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

  const traffic = [];
  let onContinue409 = null;
  let listener = (_req, res) => res.writeHead(503).end();

  const server = http.createServer((req, res) => {
    const originalUrl = req.url;
    res.on('finish', () => {
      traffic.push({
        method: req.method,
        url: originalUrl,
        status: res.statusCode,
      });
      if (req.method === 'POST' && originalUrl?.endsWith('/continue') && res.statusCode === 409) {
        const hook = onContinue409;
        onContinue409 = null;
        hook?.();
      }
    });
    listener(req, res);
  });

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
    if (!headers.has('cookie') && currentLogin?.token) {
      headers.set('cookie', `yunpanel_session=${currentLogin.token}`);
    }
    if (!headers.has('origin')) {
      headers.set('origin', publicOrigin);
    }
    return realFetch(targetUrl, { ...init, headers });
  };
  setSession({ csrfToken: currentLogin.session.csrfToken });

  async function createOperationWithSucceededRecordStep() {
    const website = await websiteRegistry.createWebsite({
      name: `T894 Site ${randomUUID().slice(0, 6)}`,
      serverId: localServerId,
      runtimeType: 'proxy',
      proxyTarget: { host: '198.51.100.20', port: 8080, websocket: true },
    });
    const operationId = randomUUID();
    await provisioningRegistry.create({
      operationId,
      websiteId: website.id,
      steps: [
        {
          id: 'website_record',
          kind: 'website_record',
          required: true,
          state: 'succeeded',
          evidence: { websiteId: website.id },
          compensation: { state: 'pending' },
        },
        {
          id: 'unix_identity',
          kind: 'unix_identity',
          required: true,
          state: 'pending',
          compensation: { state: 'pending' },
        },
      ],
    });
    return { websiteId: website.id, operationId };
  }

  async function holdWebsiteLock(websiteId) {
    const acquired = registerDeferred();
    const releaseGate = registerDeferred();
    const lockTask = siteMutationLock.withSiteLock({ websiteId }, async () => {
      acquired.resolve();
      await releaseGate.promise;
    });
    activeLockTasks.push(lockTask);
    await acquired.promise;
    return async () => {
      releaseGate.resolve();
      await lockTask;
    };
  }

  t.after(async () => {
    for (const release of barrierReleases) release();
    await Promise.allSettled(activeLockTasks);
    globalThis.fetch = realFetch;
    setSession(null);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    try { authStore.close(); } catch {}
    await rm(tempDir, { recursive: true, force: true });
  });

  return {
    authStore,
    provisioningRegistry,
    traffic,
    createOperationWithSucceededRecordStep,
    holdWebsiteLock,
    get ownerToken() {
      return currentLogin.token;
    },
    get csrfToken() {
      return currentLogin.session.csrfToken;
    },
    async reloginOwner() {
      currentLogin = await authStore.login({
        username: 'T894Owner',
        password: 'OwnerStrongPassword123!',
      });
      setSession({ csrfToken: currentLogin.session.csrfToken });
      return currentLogin;
    },
    setOnContinue409(fn) {
      onContinue409 = fn;
    },
  };
}

test('autoAdvanceWebsiteProvisioning reconciles real 409 site_mutation_locked -> disk beginCompensation (succeeded -> compensating) via GET with zero second POST', async (t) => {
  const env = await createRealProvisioningClientEnv(t);
  const { websiteId, operationId } = await env.createOperationWithSucceededRecordStep();
  const releaseLock = await env.holdWebsiteLock(websiteId);

  let compensationPersisted = null;
  env.setOnContinue409(() => {
    compensationPersisted = env.provisioningRegistry.beginCompensation({
      operationId,
      stepId: 'website_record',
    });
  });

  const events = [];
  const final = await autoAdvanceWebsiteProvisioning(operationId, {
    lockPollLimit: 25,
    lockPollDelayMs: 25,
    onStep: (event) => events.push(event),
  });
  await compensationPersisted;
  await releaseLock();

  const continuePosts = env.traffic.filter((entry) => entry.method === 'POST');
  const statusGets = env.traffic.filter((entry) => entry.method === 'GET');

  assert.equal(continuePosts.length, 1, '409 site_mutation_locked sonrası ikinci POST atılmamalı');
  assert.equal(continuePosts[0].url, `/api/panel/sites/provisioning/${operationId}/continue`);
  assert.equal(continuePosts[0].status, 409);
  assert.ok(statusGets.length >= 2 && statusGets.length < 10);
  assert.ok(statusGets.every((entry) => (
    entry.url === `/api/panel/sites/provisioning/${operationId}` && entry.status === 200
  )));

  assert.equal(final.ready, false);
  assert.equal(final.steps[0].id, 'website_record');
  assert.equal(final.steps[0].state, 'compensating');
  assert.equal(final.steps[1].state, 'pending');
  assert.equal(events.length, 1);
  assert.equal(events[0].operationId, operationId);
  assert.equal(events[0].outcome, 'compensation_interrupted');
  assert.equal(events[0].stepId, 'website_record');
});

test('autoAdvanceWebsiteProvisioning reconciles real 409 site_mutation_locked -> disk completeCompensation (succeeded -> compensated) via GET with zero second POST', async (t) => {
  const env = await createRealProvisioningClientEnv(t);
  const { websiteId, operationId } = await env.createOperationWithSucceededRecordStep();
  const releaseLock = await env.holdWebsiteLock(websiteId);

  let compensationPersisted = null;
  env.setOnContinue409(() => {
    compensationPersisted = (async () => {
      await env.provisioningRegistry.beginCompensation({
        operationId,
        stepId: 'website_record',
      });
      await env.provisioningRegistry.completeCompensation({
        operationId,
        stepId: 'website_record',
        evidence: { removed: true },
      });
    })();
  });

  const events = [];
  const final = await autoAdvanceWebsiteProvisioning(operationId, {
    lockPollLimit: 25,
    lockPollDelayMs: 25,
    onStep: (event) => events.push(event),
  });
  await compensationPersisted;
  await releaseLock();

  const continuePosts = env.traffic.filter((entry) => entry.method === 'POST');
  assert.equal(continuePosts.length, 1);
  assert.equal(continuePosts[0].status, 409);

  assert.equal(final.ready, false);
  assert.equal(final.steps[0].id, 'website_record');
  assert.equal(final.steps[0].state, 'compensated');
  assert.equal(final.steps[1].state, 'pending');
  assert.ok(events.length >= 1);
  assert.equal(events.at(-1)?.outcome, 'compensated');
  assert.equal(events.at(-1)?.stepId, 'website_record');
});

test('real CSRF boundary: missing or wrong csrfToken on POST /continue is rejected with HTTP 403 and never polled', async (t) => {
  const env = await createRealProvisioningClientEnv(t);
  const { operationId } = await env.createOperationWithSucceededRecordStep();

  for (const invalidCsrf of [null, 'tampered-csrf-token-value']) {
    env.traffic.length = 0;
    setSession(invalidCsrf ? { csrfToken: invalidCsrf } : null);

    await assert.rejects(
      autoAdvanceWebsiteProvisioning(operationId, {
        lockPollLimit: 10,
        lockPollDelayMs: 15,
      }),
      (err) => err?.status === 403,
    );

    assert.deepEqual(
      env.traffic.map((entry) => `${entry.method} ${entry.status}`),
      ['GET 200', 'POST 403'],
    );
  }
});

test('real AuthStore session revocation (HTTP 401) and session_superseded boundaries stop lock-contention polling immediately', async (t) => {
  const env = await createRealProvisioningClientEnv(t);
  const { websiteId, operationId } = await env.createOperationWithSucceededRecordStep();
  const releaseLock = await env.holdWebsiteLock(websiteId);

  // 1) Server-side session revocation via AuthStore -> HTTP 401 on next GET
  env.setOnContinue409(() => {
    env.authStore.revokeSession(env.ownerToken);
  });

  await assert.rejects(
    autoAdvanceWebsiteProvisioning(operationId, {
      lockPollLimit: 20,
      lockPollDelayMs: 20,
    }),
    (err) => err?.status === 401 && err?.code === 'unauthorized',
  );

  assert.deepEqual(
    env.traffic.map((entry) => `${entry.method} ${entry.status}`),
    ['GET 200', 'POST 409', 'GET 401'],
  );

  // 2) Client-side session rotation (session_superseded) after 409
  await env.reloginOwner();
  env.traffic.length = 0;
  env.setOnContinue409(() => {
    setSession({ csrfToken: 'rotated-session-csrf-token' });
  });

  await assert.rejects(
    autoAdvanceWebsiteProvisioning(operationId, {
      lockPollLimit: 20,
      lockPollDelayMs: 20,
    }),
    { name: 'AbortError', code: 'session_superseded' },
  );
  await releaseLock();

  assert.deepEqual(
    env.traffic.map((entry) => `${entry.method} ${entry.status}`),
    ['GET 200', 'POST 409'],
  );
});
