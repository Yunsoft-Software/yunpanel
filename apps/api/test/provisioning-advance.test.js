import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';

// Run web provisioning-advance test suite as baseline
import '../../web/test/provisioning-advance.test.js';

import {
  mountWebsiteProvisioningRoutes,
  WebsiteProvisioningHttpError,
  websiteProvisioningHttpInternals,
} from '../src/website-provisioning-http.js';
import { advanceProvisioning } from '../../web/src/workspace/provisioning-advance.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';

const { continueBody, retryBody, compensateBody, publicOperation, publicResult } = websiteProvisioningHttpInternals;

test('Backend provisioning advance: confirmation validators strictly enforce exact tokens', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const expectedContinue = `continue-site-provisioning:${id}`;

  // Valid continue confirmation
  assert.equal(continueBody({ confirmation: expectedContinue }, id), expectedContinue);

  // Invalid continue confirmations
  for (const bad of [
    null,
    undefined,
    {},
    { confirmation: 'wrong' },
    { confirmation: expectedContinue, extra: true },
    { other: expectedContinue },
    ['continue-site-provisioning:' + id],
  ]) {
    assert.throws(
      () => continueBody(bad, id),
      (err) => err instanceof WebsiteProvisioningHttpError && err.code === 'website_provisioning_confirmation_required',
    );
  }
});

test('Backend provisioning advance: public projection returns clean, frozen structures', () => {
  const op = {
    operationId: '11111111-1111-4111-8111-111111111111',
    websiteId: '22222222-2222-4222-8222-222222222222',
    ready: false,
    status: 'partial',
    progress: { required: 2, completed: 1, remaining: 1 },
    steps: [
      { id: 'nginx', kind: 'nginx', required: true, state: 'succeeded', compensation: { state: 'not_required' } },
      { id: 'certificate', kind: 'certificate', required: true, state: 'failed', compensation: { state: 'pending' } },
    ],
  };

  const projected = publicOperation(op);
  assert.equal(projected.operationId, op.operationId);
  assert.equal(projected.ready, false);
  assert.equal(projected.steps.length, 2);
  assert.equal(projected.steps[0].state, 'succeeded');
  assert.equal(projected.steps[1].state, 'failed');
  assert.equal(projected.steps[1].canRetry, true);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.steps), true);
});

test('Backend provisioning advance: HTTP server routes enforce authentication, tenant boundaries, and step advance', async () => {
  const localServerId = randomUUID();
  const websiteId = randomUUID();
  const foreignWebsiteId = randomUUID();
  const operationId = randomUUID();

  const stepNginx = { id: 'nginx', kind: 'nginx', required: true, state: 'pending', compensation: { state: 'pending' } };
  const stepCert = { id: 'certificate', kind: 'certificate', required: true, state: 'pending', compensation: { state: 'pending' } };

  let currentOp = {
    operationId,
    websiteId,
    ready: false,
    status: 'running',
    progress: { required: 2, completed: 0, remaining: 2 },
    steps: [stepNginx, stepCert],
  };

  const registry = {
    get: async (id) => (id === operationId ? currentOp : null),
    getLatestForWebsite: async (wid) => (wid === websiteId ? currentOp : null),
  };

  const orchestrator = {
    runNext: async (id) => {
      if (currentOp.steps[0].state === 'pending') {
        currentOp = {
          ...currentOp,
          progress: { required: 2, completed: 1, remaining: 1 },
          steps: [
            { ...stepNginx, state: 'succeeded' },
            stepCert,
          ],
        };
        return { outcome: 'progressed', stepId: 'nginx', operation: currentOp };
      }
      currentOp = {
        ...currentOp,
        ready: true,
        status: 'succeeded',
        progress: { required: 2, completed: 2, remaining: 0 },
        steps: [
          { ...stepNginx, state: 'succeeded' },
          { ...stepCert, state: 'succeeded' },
        ],
      };
      return { outcome: 'ready', stepId: 'certificate', operation: currentOp };
    },
    retryStep: async () => ({ outcome: 'progressed', stepId: 'nginx', operation: currentOp }),
    compensateStep: async () => ({ outcome: 'compensated', stepId: 'nginx', operation: currentOp }),
    supportsCompensation: () => true,
  };

  const websites = new Map([
    [websiteId, { id: websiteId, serverId: localServerId, customerId: 'cust-1' }],
    [foreignWebsiteId, { id: foreignWebsiteId, serverId: localServerId, customerId: 'cust-2' }],
  ]);

  const app = express();
  app.disable('x-powered-by');

  let currentAuth = null;
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });
  app.use(express.json());

  mountWebsiteProvisioningRoutes(app, {
    registry,
    orchestrator,
    websiteRegistry: { getWebsite: async (id) => websites.get(id) || null },
    localServerId,
  });

  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ code: err.code, message: err.message });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Unauthenticated request receives 401
    currentAuth = null;
    let res = await fetch(`${base}/api/sites/provisioning/${operationId}`);
    assert.equal(res.status, 401);

    // 2. Read-only role cannot mutate (receives 403)
    currentAuth = {
      id: 'sess-ro',
      user: { id: 'ro-user', role: 'read_only' },
      access: { mode: 'read_only', permissions: ['websites.read'] },
      security: { managementAllowed: false },
    };
    res = await fetch(`${base}/api/sites/provisioning/${operationId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: `continue-site-provisioning:${operationId}` }),
    });
    assert.equal(res.status, 403);

    // 3. Foreign tenant access receives 404 (fail-closed)
    currentAuth = {
      id: 'sess-foreign',
      user: { id: 'cust-2', role: 'customer', active: true, websiteIds: [foreignWebsiteId], hosting: { kind: 'customer' } },
      access: { mode: 'site_management' },
      security: { managementAllowed: true },
    };
    res = await fetch(`${base}/api/sites/provisioning/${operationId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: `continue-site-provisioning:${operationId}` }),
    });
    assert.equal(res.status, 404);

    // 4. Authorized owner can advance provisioning using client driver advanceProvisioning
    currentAuth = {
      id: 'sess-owner',
      user: { id: 'owner-1', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };

    const finalOperation = await advanceProvisioning({
      operationId,
      read: async ({ signal }) => {
        const r = await fetch(`${base}/api/sites/provisioning/${operationId}`, { signal });
        const json = await r.json();
        return json.data;
      },
      advance: async ({ signal }) => {
        const r = await fetch(`${base}/api/sites/provisioning/${operationId}/continue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmation: `continue-site-provisioning:${operationId}` }),
          signal,
        });
        const json = await r.json();
        return json.data;
      },
    });

    assert.equal(finalOperation.ready, true);
    assert.equal(finalOperation.steps.length, 2);
    assert.equal(finalOperation.steps.every((s) => s.state === 'succeeded'), true);
  } finally {
    server.close();
  }
});

function createRealAuthFixture(t) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-adv-test-'));
  const filePath = path.join(tempDir, 'auth.sqlite');
  const store = createAuthStore({ filePath });
  t.after(() => {
    try { store.close(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });
  return { store, filePath, tempDir };
}

function makeStep(id, state = 'pending', extra = {}) {
  return {
    id,
    kind: id,
    required: true,
    state,
    error: state === 'failed' ? `${id}_failed` : null,
    canRetry: state === 'failed',
    canCompensate: false,
    compensation: { state: 'not_required', error: null },
    ...extra,
  };
}

function makeOperation(websiteId, operationId, steps, ready = false, status = 'running') {
  const required = steps.filter((s) => s.required !== false);
  const completed = required.filter((s) => s.state === 'succeeded').length;
  return {
    operationId,
    websiteId,
    ready: ready || steps.every((s) => !s.required || s.state === 'succeeded'),
    status: ready ? 'succeeded' : status,
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    steps,
    progress: { required: required.length, completed, remaining: required.length - completed },
  };
}

test('T-DEV-JOB-UX: Gerçek HTTP/auth/CSRF ile başarılı adım zinciri, zaten tamamlanmış işlem, 401/403/409/429/5xx, yanıt kaybı, yanlış işlem/site sonucu, logout/login ve abort', async (t) => {
  const { store: authStore, filePath, tempDir } = createRealAuthFixture(t);
  const lockRoot = path.join(tempDir, 'locks');
  const siteMutationLock = createSiteMutationLock({ root: lockRoot });

  const localServerId = randomUUID();
  const siteAId = randomUUID();
  const siteBId = randomUUID();

  // 1. Setup Owner user
  const { token: setupToken } = authStore.issueSetupToken();
  const ownerUser = await authStore.completeSetup({
    setupToken,
    username: 'SecurityOwner',
    password: 'OwnerPassword123!',
  });
  const ownerLogin = await authStore.login({ username: 'SecurityOwner', password: 'OwnerPassword123!' });
  const authCookieName = '__Host-yunpanel_session';
  const ownerCookie = `${authCookieName}=${ownerLogin.token}`;
  const ownerCsrf = ownerLogin.session.csrfToken;

  // 2. Setup Site Manager for Site A
  const userA = await authStore.users.createSiteManager({
    username: 'admin.sitea@example.test',
    password: 'SiteAPassword123!',
    websiteId: siteAId,
    actorId: ownerUser.id,
  });
  const loginA = await authStore.login({ username: 'admin.sitea@example.test', password: 'SiteAPassword123!' });
  const siteACookie = `${authCookieName}=${loginA.token}`;
  const siteACsrf = loginA.session.csrfToken;

  // 3. Setup Read-Only user
  const userRo = await authStore.users.createSiteManager({
    username: 'readonly.user@example.test',
    password: 'ReadOnlyPass123!',
    websiteId: siteAId,
    actorId: ownerUser.id,
  });
  const dbSync = new DatabaseSync(filePath);
  dbSync.prepare('UPDATE users SET role = ? WHERE id = ?').run('read_only', userRo.id);
  dbSync.close();
  const loginRo = await authStore.login({ username: 'readonly.user@example.test', password: 'ReadOnlyPass123!' });
  const roCookie = `${authCookieName}=${loginRo.token}`;
  const roCsrf = loginRo.session.csrfToken;

  const websites = new Map([
    [siteAId, { id: siteAId, serverId: localServerId, customerId: userA.id }],
    [siteBId, { id: siteBId, serverId: localServerId, customerId: randomUUID() }],
  ]);

  const operations = new Map();

  let simulate500 = false;
  let simulate503Scope = false;
  let simulate429 = false;

  const orchestrator = {
    runNext: async (id, actor) => {
      if (simulate500) {
        const err = new Error('simulated internal error in orchestrator');
        err.status = 500;
        throw err;
      }
      if (simulate429) {
        const err = new Error('simulated rate limit exceeded in orchestrator');
        err.status = 429;
        throw err;
      }
      const op = operations.get(id);
      if (!op) throw new Error('Operation not found');

      const pendingIndex = op.steps.findIndex((s) => s.state === 'pending');
      if (pendingIndex === -1) {
        return { outcome: 'ready', stepId: null, operation: op };
      }

      const step = op.steps[pendingIndex];
      const updatedSteps = op.steps.map((s, idx) => (idx === pendingIndex ? { ...s, state: 'succeeded' } : s));
      const isLast = pendingIndex === op.steps.length - 1;
      const updatedOp = makeOperation(op.websiteId, id, updatedSteps, isLast);
      operations.set(id, updatedOp);

      return {
        outcome: isLast ? 'ready' : 'progressed',
        stepId: step.id,
        operation: updatedOp,
      };
    },
    retryStep: async (id, stepId) => {
      const op = operations.get(id);
      const updatedSteps = op.steps.map((s) => (s.id === stepId ? { ...s, state: 'succeeded' } : s));
      const updatedOp = makeOperation(op.websiteId, id, updatedSteps);
      operations.set(id, updatedOp);
      return { outcome: 'progressed', stepId, operation: updatedOp };
    },
    compensateStep: async (id, stepId) => {
      const op = operations.get(id);
      const updatedSteps = op.steps.map((s) => (s.id === stepId ? { ...s, state: 'compensated' } : s));
      const updatedOp = makeOperation(op.websiteId, id, updatedSteps);
      operations.set(id, updatedOp);
      return { outcome: 'compensated', stepId, operation: updatedOp };
    },
    supportsCompensation: () => true,
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  mountWebsiteProvisioningRoutes(app, {
    registry: {
      get: async (id) => operations.get(id) || null,
      getLatestForWebsite: async (wid) => {
        for (const op of operations.values()) {
          if (op.websiteId === wid) return op;
        }
        return null;
      },
    },
    orchestrator,
    websiteRegistry: {
      getWebsite: async (id) => {
        if (simulate503Scope) {
          throw new Error('Database connection failed for website registry');
        }
        return websites.get(id) || null;
      },
    },
    localServerId,
    siteMutationLock,
  });

  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ code: err.code || 'internal_error', message: err.message });
  });

  const origin = 'https://server.cryptoraichu.website';
  const listener = createAuthenticatedApi({
    store: authStore,
    publicOrigin: origin,
    development: true,
    ownerMfaRequired: false,
    createHandler: () => app,
  });

  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    try { server.closeAllConnections?.(); } catch {}
    server.close();
  });

  const makeClient = ({ cookie = ownerCookie, csrf = ownerCsrf, requestOrigin = origin, opId } = {}) => {
    const readCalls = [];
    const advanceCalls = [];
    return {
      readCalls,
      advanceCalls,
      read: async ({ signal } = {}) => {
        readCalls.push({ time: Date.now() });
        const res = await fetch(`${base}/api/sites/provisioning/${opId}`, {
          headers: cookie ? { cookie } : {},
          signal,
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          try { err.code = (await res.json()).code; } catch {}
          throw err;
        }
        const json = await res.json();
        return json.data;
      },
      advance: async ({ signal } = {}) => {
        advanceCalls.push({ time: Date.now() });
        const headers = {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(requestOrigin ? { origin: requestOrigin } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        };
        const res = await fetch(`${base}/api/sites/provisioning/${opId}/continue`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ confirmation: `continue-site-provisioning:${opId}` }),
          signal,
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          try { err.code = (await res.json()).code; } catch {}
          throw err;
        }
        const json = await res.json();
        return json.data;
      },
    };
  };

  // ==========================================================================
  // 1. Gerçek HTTP/auth/CSRF ile başarılı adım zinciri (Successful step chain)
  // ==========================================================================
  const op1Id = randomUUID();
  const op1 = makeOperation(siteAId, op1Id, [
    makeStep('unix_identity'),
    makeStep('nginx'),
    makeStep('database'),
    makeStep('certificate'),
  ]);
  operations.set(op1Id, op1);

  const client1 = makeClient({ opId: op1Id });
  const recordedSteps1 = [];
  const final1 = await advanceProvisioning({
    operationId: op1Id,
    read: client1.read,
    advance: client1.advance,
    onStep: (result) => recordedSteps1.push(result),
  });

  assert.equal(final1.ready, true);
  assert.equal(final1.status, 'succeeded');
  assert.equal(final1.steps.length, 4);
  assert.equal(final1.steps.every((s) => s.state === 'succeeded'), true);
  assert.equal(client1.readCalls.length, 1);
  assert.equal(client1.advanceCalls.length, 4);
  assert.equal(recordedSteps1.length, 4);
  assert.deepEqual(recordedSteps1.map((r) => r.stepId), ['unix_identity', 'nginx', 'database', 'certificate']);
  assert.equal(recordedSteps1[3].outcome, 'ready');

  // ==========================================================================
  // 2. Zaten tamamlanmış işlem (Already-ready operation without redundant POST)
  // ==========================================================================
  const client2 = makeClient({ opId: op1Id });
  const final2 = await advanceProvisioning({
    operationId: op1Id,
    read: client2.read,
    advance: client2.advance,
  });

  assert.equal(final2.ready, true);
  assert.equal(client2.readCalls.length, 1);
  assert.equal(client2.advanceCalls.length, 0); // No new POST performed!

  // ==========================================================================
  // 3. 401, 403, 409, 429, 5xx Hata Kodları (Fail-closed error handling)
  // ==========================================================================
  const opErrId = randomUUID();
  const opErr = makeOperation(siteAId, opErrId, [makeStep('nginx')]);
  operations.set(opErrId, opErr);

  // 3a: 401 Unauthorized - unauthenticated GET
  const clientAnon = makeClient({ cookie: null, opId: opErrId });
  await assert.rejects(
    advanceProvisioning({
      operationId: opErrId,
      read: clientAnon.read,
      advance: clientAnon.advance,
    }),
    (err) => err.status === 401,
  );
  assert.equal(clientAnon.advanceCalls.length, 0);

  // 3b: 401 Unauthorized - invalid cookie on POST
  const clientBadCookie = makeClient({ cookie: `${authCookieName}=invalid_token_xyz`, opId: opErrId });
  await assert.rejects(
    advanceProvisioning({
      operationId: opErrId,
      read: clientBadCookie.read,
      advance: clientBadCookie.advance,
    }),
    (err) => err.status === 401,
  );

  // 3c: 403 Forbidden - bad CSRF token
  const clientBadCsrf = makeClient({ csrf: 'tampered-csrf-token', opId: opErrId });
  await assert.rejects(
    advanceProvisioning({
      operationId: opErrId,
      read: clientBadCsrf.read,
      advance: clientBadCsrf.advance,
    }),
    (err) => err.status === 403,
  );

  // 3d: 403 Forbidden - cross-origin request
  const clientBadOrigin = makeClient({ requestOrigin: 'https://attacker.example.com', opId: opErrId });
  await assert.rejects(
    advanceProvisioning({
      operationId: opErrId,
      read: clientBadOrigin.read,
      advance: clientBadOrigin.advance,
    }),
    (err) => err.status === 403,
  );

  // 3e: 403 Forbidden - read_only role cannot mutate
  const clientRo = makeClient({ cookie: roCookie, csrf: roCsrf, opId: opErrId });
  await assert.rejects(
    advanceProvisioning({
      operationId: opErrId,
      read: clientRo.read,
      advance: clientRo.advance,
    }),
    (err) => err.status === 403,
  );

  // 3f: 409 Conflict - siteMutationLock collision
  let releaseLock;
  let lockAcquired;
  const lockAcquiredPromise = new Promise((r) => { lockAcquired = r; });
  const lockGate = new Promise((r) => { releaseLock = r; });
  const lockPromise = siteMutationLock.withSiteLock({ websiteId: siteAId }, async () => {
    lockAcquired();
    await lockGate;
  });
  await lockAcquiredPromise;

  const clientConflict = makeClient({ opId: opErrId });
  await assert.rejects(
    advanceProvisioning({
      operationId: opErrId,
      read: clientConflict.read,
      advance: clientConflict.advance,
    }),
    (err) => err.status === 409 && err.code === 'site_mutation_locked',
  );
  releaseLock();
  await lockPromise;

  // 3g: 429 Too Many Requests
  simulate429 = true;
  const client429 = makeClient({ opId: opErrId });
  await assert.rejects(
    advanceProvisioning({
      operationId: opErrId,
      read: client429.read,
      advance: client429.advance,
    }),
    (err) => err.status === 429,
  );
  simulate429 = false;

  // 3h: 500 Server Error
  simulate500 = true;
  const client500 = makeClient({ opId: opErrId });
  await assert.rejects(
    advanceProvisioning({
      operationId: opErrId,
      read: client500.read,
      advance: client500.advance,
    }),
    (err) => err.status === 500,
  );
  simulate500 = false;

  // 3i: 503 Scope Unavailable
  const op503Id = randomUUID();
  const op503 = makeOperation(siteAId, op503Id, [makeStep('nginx')]);
  operations.set(op503Id, op503);
  simulate503Scope = true;
  const client503 = makeClient({ cookie: siteACookie, csrf: siteACsrf, opId: op503Id });
  await assert.rejects(
    advanceProvisioning({
      operationId: op503Id,
      read: client503.read,
      advance: client503.advance,
    }),
    (err) => err.status === 503,
  );
  simulate503Scope = false;

  // ==========================================================================
  // 4. Yanıt Kaybı (Lost Response) ve Belirsiz POST İsteklerinin Uzlaştırılması
  // ==========================================================================
  const opLostId = randomUUID();
  const opLost = makeOperation(siteAId, opLostId, [makeStep('unix_identity'), makeStep('nginx')]);
  operations.set(opLostId, opLost);

  let postAttemptCount = 0;
  let lostEncountered = false;

  const clientLost = {
    read: async ({ signal } = {}) => {
      const res = await fetch(`${base}/api/sites/provisioning/${opLostId}`, {
        headers: { cookie: ownerCookie },
        signal,
      });
      const json = await res.json();
      return json.data;
    },
    advance: async ({ signal } = {}) => {
      postAttemptCount += 1;
      if (postAttemptCount === 1) {
        // Execute step 1 on the server
        const op = operations.get(opLostId);
        const updatedSteps = op.steps.map((s, idx) => (idx === 0 ? { ...s, state: 'succeeded' } : s));
        operations.set(opLostId, makeOperation(op.websiteId, opLostId, updatedSteps));

        // Network connection drops before response is delivered (lost response)
        lostEncountered = true;
        const netErr = new TypeError('fetch failed: socket hang up');
        netErr.code = 'ECONNRESET';
        throw netErr;
      }

      // Normal advance for subsequent steps
      const res = await fetch(`${base}/api/sites/provisioning/${opLostId}/continue`, {
        method: 'POST',
        headers: {
          cookie: ownerCookie,
          origin,
          'x-csrf-token': ownerCsrf,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ confirmation: `continue-site-provisioning:${opLostId}` }),
        signal,
      });
      const json = await res.json();
      return json.data;
    },
  };

  // advanceProvisioning does NOT blindly auto-repeat uncertain POST
  await assert.rejects(
    advanceProvisioning({
      operationId: opLostId,
      read: clientLost.read,
      advance: clientLost.advance,
    }),
    (err) => err.code === 'ECONNRESET',
  );

  assert.equal(lostEncountered, true);
  assert.equal(postAttemptCount, 1); // exactly 1 POST attempt, no duplicate POST!

  // Reconcile with ground truth via GET read
  const reconciledSnapshot = await clientLost.read({});
  assert.equal(reconciledSnapshot.steps[0].state, 'succeeded');
  assert.equal(reconciledSnapshot.steps[1].state, 'pending');

  // Resume advance cleanly from the reconciled state
  const finalReconciled = await advanceProvisioning({
    operationId: opLostId,
    read: clientLost.read,
    advance: clientLost.advance,
  });

  assert.equal(finalReconciled.ready, true);
  assert.equal(finalReconciled.steps[1].state, 'succeeded');
  assert.equal(postAttemptCount, 2); // only 1 additional POST made for step 2!

  // ==========================================================================
  // 5. Yanlış İşlem/Site Sonucu Eşleşmesi (Mismatched operation / site result)
  // ==========================================================================
  const opMismatchId = randomUUID();
  const opMismatch = makeOperation(siteAId, opMismatchId, [makeStep('nginx')]);
  operations.set(opMismatchId, opMismatch);

  // Mismatched websiteId
  const clientWrongSite = {
    read: async () => opMismatch,
    advance: async () => ({
      operationId: opMismatchId,
      outcome: 'progressed',
      stepId: 'nginx',
      operation: makeOperation(siteBId, opMismatchId, [makeStep('nginx', 'succeeded')]),
    }),
  };

  await assert.rejects(
    advanceProvisioning({
      operationId: opMismatchId,
      read: clientWrongSite.read,
      advance: clientWrongSite.advance,
    }),
    (err) => err.code === 'provisioning_response_invalid',
  );

  // Mismatched operationId
  const clientWrongOp = {
    read: async () => opMismatch,
    advance: async () => ({
      operationId: randomUUID(),
      outcome: 'progressed',
      stepId: 'nginx',
      operation: makeOperation(siteAId, randomUUID(), [makeStep('nginx', 'succeeded')]),
    }),
  };

  await assert.rejects(
    advanceProvisioning({
      operationId: opMismatchId,
      read: clientWrongOp.read,
      advance: clientWrongOp.advance,
    }),
    (err) => err.code === 'provisioning_response_invalid',
  );

  // ==========================================================================
  // 6. Logout / Login ve Oturum Güvenliği (Session rotation / user logout)
  // ==========================================================================
  const opLogoutId = randomUUID();
  const opLogout = makeOperation(siteAId, opLogoutId, [makeStep('unix_identity'), makeStep('nginx')]);
  operations.set(opLogoutId, opLogout);

  let sessionActive = true;
  let loggedOutServer = false;

  const clientLogout = makeClient({ opId: opLogoutId });
  const advancePromise = advanceProvisioning({
    operationId: opLogoutId,
    read: clientLogout.read,
    advance: clientLogout.advance,
    isCurrent: () => sessionActive,
    onStep: async () => {
      sessionActive = false;
      authStore.revokeSession(ownerLogin.token, null, 'logout');
      loggedOutServer = true;
    },
  });

  await assert.rejects(
    advancePromise,
    (err) => err.name === 'AbortError' && err.code === 'session_superseded',
  );
  assert.equal(loggedOutServer, true);

  // Submitting with old session cookie returns 401 Unauthorized
  const postAfterLogout = await fetch(`${base}/api/sites/provisioning/${opLogoutId}/continue`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin,
      'x-csrf-token': ownerCsrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ confirmation: `continue-site-provisioning:${opLogoutId}` }),
  });
  assert.equal(postAfterLogout.status, 401);

  // ==========================================================================
  // 7. Abort Durumunda Oturum Güvenliği ve Host İşini İptal Etmeme
  // ==========================================================================
  const opAbortId = randomUUID();
  const opAbort = makeOperation(siteAId, opAbortId, [
    makeStep('unix_identity'),
    makeStep('nginx'),
    makeStep('database'),
  ]);
  operations.set(opAbortId, opAbort);

  // Fresh login after previous logout
  const ownerLogin2 = await authStore.login({ username: 'SecurityOwner', password: 'OwnerPassword123!' });
  const ownerCookie2 = `${authCookieName}=${ownerLogin2.token}`;
  const ownerCsrf2 = ownerLogin2.session.csrfToken;

  const abortController = new AbortController();
  const clientAbort = makeClient({ cookie: ownerCookie2, csrf: ownerCsrf2, opId: opAbortId });

  await assert.rejects(
    advanceProvisioning({
      operationId: opAbortId,
      signal: abortController.signal,
      read: clientAbort.read,
      advance: clientAbort.advance,
      onStep: (result) => {
        if (result.stepId === 'unix_identity') {
          abortController.abort();
        }
      },
    }),
    (err) => err.name === 'AbortError',
  );

  // Host verification: "İlerlemenin durması host üzerindeki işlemi iptal etmemelidir."
  const hostOp = operations.get(opAbortId);
  assert.ok(hostOp, 'Host operation must still exist');
  assert.equal(hostOp.steps[0].id, 'unix_identity');
  assert.equal(hostOp.steps[0].state, 'succeeded', 'Completed step must NOT be rolled back');
  assert.equal(hostOp.steps[1].state, 'pending', 'Remaining step must still be pending');
  assert.equal(hostOp.steps[2].state, 'pending');
  assert.notEqual(hostOp.status, 'cancelled', 'Operation must NOT be marked cancelled on host');

  // Resume with fresh controller and complete to ready
  const clientResume = makeClient({ cookie: ownerCookie2, csrf: ownerCsrf2, opId: opAbortId });
  const finalResume = await advanceProvisioning({
    operationId: opAbortId,
    read: clientResume.read,
    advance: clientResume.advance,
  });

  assert.equal(finalResume.ready, true);
  assert.equal(finalResume.steps.every((s) => s.state === 'succeeded'), true);
});
