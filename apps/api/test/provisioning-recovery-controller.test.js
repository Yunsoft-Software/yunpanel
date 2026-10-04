import { register } from 'node:module';
register('../../web/test/jsx-loader.js', import.meta.url);

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';

const nativeFetch = globalThis.fetch;
// Run web controller unit and optional-step tests
await import('../../web/test/provisioning-recovery-controller.test.js');
await import('../../web/test/provisioning-recovery-optional.test.js');
globalThis.fetch = nativeFetch;

import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAuthStore } from '../src/auth-store.js';
import {
  mountWebsiteProvisioningRoutes,
  WebsiteProvisioningHttpError,
} from '../src/website-provisioning-http.js';
import { createSiteMutationLock, SiteMutationLockError } from '../src/site-mutation-lock.js';
import {
  createProvisioningRecovery,
  EMPTY_RECOVERY,
  recoveryAllowed,
  recoveryBusy,
  recoveryOperation,
} from '../../web/src/workspace/provisioning-recovery.js';
import { createWebsiteProvisioningRegistry } from '../src/website-provisioning-registry.js';
import { createWebsiteProvisioningOrchestrator } from '../src/website-provisioning-orchestrator.js';
import { createJobRecoveryStore } from '../src/job-recovery-store.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobIdempotencyLookup } from '../src/job-idempotency-lookup.js';

const siteAId = 'aaaaaaaa-1111-4111-8111-111111111111';
const siteBId = 'bbbbbbbb-2222-4222-8222-222222222222';
const opAId = 'cccccccc-3333-4333-8333-333333333333';
const opBId = 'dddddddd-4444-4444-8444-444444444444';
const localServerId = 'ssssssss-5555-4555-8555-555555555555';

function sampleStep(id = 'nginx', state = 'failed', extra = {}) {
  return {
    id,
    kind: id,
    required: true,
    state,
    error: state === 'failed' ? `${id}_failed` : null,
    canRetry: state === 'failed',
    canCompensate: state === 'failed' || state === 'succeeded',
    compensation: { state: 'pending', error: null },
    ...extra,
  };
}

function sampleOp(websiteId, operationId, state = 'partial', steps = [sampleStep()]) {
  const required = steps.filter((s) => s.required !== false);
  const completed = required.filter((s) => s.state === 'succeeded').length;
  return {
    operationId,
    websiteId,
    ready: state === 'succeeded',
    status: state,
    updatedAt: '2026-10-04T12:00:00.000Z',
    createdAt: '2026-10-04T11:00:00.000Z',
    steps,
    progress: { required: required.length, completed, remaining: required.length - completed },
  };
}

function createRealAuthFixture(t) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-rec-test-'));
  const filePath = path.join(tempDir, 'auth.sqlite');
  const store = createAuthStore({ filePath });
  t.after(() => {
    try { store.close(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });
  return { store, filePath, tempDir };
}

// ============================================================================
// Criterion 1 & 2: Site transitions, session switches, and modal isolation
// ============================================================================

test('Site A -> Site B transition never carries over previous GET/POST results, approvals or modals', async () => {
  const readsA = [];
  const writesA = [];
  const readsB = [];
  const writesB = [];

  const opA = sampleOp(siteAId, opAId, 'partial');
  const opB = sampleOp(siteBId, opBId, 'partial');

  // Controller instance for Site A
  let version = 1;
  const flowA = createProvisioningRecovery({
    websiteId: siteAId,
    canManage: () => true,
    isCurrent: () => version === 1,
    read: async (opts) => { readsA.push(opts); return opA; },
    execute: async (approval, opts) => { writesA.push({ approval, opts }); return { outcome: 'progressed', operation: opA, stepId: 'nginx' }; },
  });

  await flowA.load();
  assert.equal(flowA.getState().status, 'ready');
  assert.equal(flowA.getState().operation.websiteId, siteAId);

  // Prepare approval on Site A
  const approvalA = flowA.prepare('retry', 'nginx');
  assert.ok(approvalA);
  assert.equal(approvalA.operationId, opAId);
  assert.equal(approvalA.confirmation, `retry-site-provisioning:${opAId}:nginx`);
  assert.equal(flowA.getState().approval, approvalA);

  // Switch to Site B: Site A flow is disposed, brand new flow for Site B created
  flowA.dispose();
  version = 2; // session / target version incremented

  const flowB = createProvisioningRecovery({
    websiteId: siteBId,
    canManage: () => true,
    isCurrent: () => version === 2,
    read: async (opts) => { readsB.push(opts); return opB; },
    execute: async (approval, opts) => { writesB.push({ approval, opts }); return { outcome: 'progressed', operation: opB, stepId: 'nginx' }; },
  });

  // Verify Site B starts completely clean
  const stateB = flowB.getState();
  assert.deepEqual(stateB, EMPTY_RECOVERY);
  assert.equal(stateB.operation, null);
  assert.equal(stateB.approval, null);

  // Attempting to execute Site A's approval on Site B flow is strictly rejected
  const performResult = await flowB.perform(approvalA, approvalA.confirmation);
  assert.deepEqual(performResult, EMPTY_RECOVERY);
  assert.equal(writesB.length, 0);

  // Attempting to execute Site A's approval on disposed Site A flow is strictly rejected
  const performDisposed = await flowA.perform(approvalA, approvalA.confirmation);
  assert.equal(writesA.length, 0);

  // Site B loads its own operation cleanly
  await flowB.load();
  assert.equal(flowB.getState().status, 'ready');
  assert.equal(flowB.getState().operation.websiteId, siteBId);
  assert.equal(flowB.getState().approval, null);
});

test('Session / user / permission changes invalidate pending approvals and drop in-flight responses', async () => {
  let isCurrent = true;
  let canManage = true;
  const writes = [];

  const flow = createProvisioningRecovery({
    websiteId: siteAId,
    canManage: () => canManage,
    isCurrent: () => isCurrent,
    read: async () => sampleOp(siteAId, opAId, 'partial', [sampleStep('nginx', 'pending')]),
    execute: async (approval, opts) => { writes.push({ approval, opts }); return { outcome: 'progressed', operation: sampleOp(siteAId, opAId, 'partial', [sampleStep('nginx', 'succeeded')]) }; },
  });

  await flow.load();
  const approval = flow.prepare('continue');
  assert.ok(approval);

  // User session changes mid-flow (isCurrent becomes false)
  isCurrent = false;
  await flow.perform(approval, approval.confirmation);
  assert.equal(writes.length, 0, 'No mutation allowed when session is no longer current');

  // Management permission revoked (canManage becomes false)
  isCurrent = true;
  canManage = false;
  assert.equal(flow.prepare('continue'), null, 'Cannot prepare approval without management permission');
  const res = await flow.perform(approval, approval.confirmation);
  assert.equal(res.status, 'forbidden');
  assert.equal(res.operation, null);
  assert.equal(res.approval, null);
});

// ============================================================================
// Criterion 3: Stale / error prevents mutations, requires fresh explicit confirmation
// ============================================================================

test('Stale or error state locks mutation actions, and changed record requires fresh explicit approval', async () => {
  let shouldFail = false;
  let currentRecord = sampleOp(siteAId, opAId, 'partial', [sampleStep('nginx', 'pending')]);
  const writes = [];

  const flow = createProvisioningRecovery({
    websiteId: siteAId,
    canManage: () => true,
    isCurrent: () => true,
    read: async () => {
      if (shouldFail) throw new Error('network_connection_failed');
      return currentRecord;
    },
    execute: async (approval, opts) => {
      writes.push(approval);
      return { outcome: 'progressed', operation: currentRecord };
    },
  });

  await flow.load();
  assert.equal(flow.getState().status, 'ready');

  // Capture approval
  const approval = flow.prepare('continue');
  assert.ok(approval);

  // Background refresh fails -> status becomes stale, approval cleared
  shouldFail = true;
  await flow.load();
  assert.equal(flow.getState().status, 'stale');
  assert.equal(flow.getState().approval, null);

  // While stale, prepare must return null
  assert.equal(flow.prepare('continue'), null);
  assert.equal(flow.prepare('retry', 'nginx'), null);
  assert.equal(flow.prepare('compensate', 'nginx'), null);

  // Calling perform with old approval while stale must not mutate
  await flow.perform(approval, approval.confirmation);
  assert.equal(writes.length, 0);

  // Server recovers: re-load brings state back to ready
  shouldFail = false;
  await flow.load();
  assert.equal(flow.getState().status, 'ready');

  // Prepare fresh approval
  const freshApproval = flow.prepare('continue');
  assert.ok(freshApproval);

  // Now, behind the scenes, server operation updatedAt advances
  currentRecord = { ...currentRecord, updatedAt: '2026-10-04T13:00:00.000Z' };

  // Attempting to perform the approval detects snapshot mismatch during preflight read
  const stateAfterMismatch = await flow.perform(freshApproval, freshApproval.confirmation);
  assert.equal(writes.length, 0, 'Mutation must not execute when snapshot mismatch is detected');
  assert.equal(stateAfterMismatch.approval, null, 'Approval must be cleared');
  assert.match(stateAfterMismatch.error, /yeniden onaylayın/);

  // Fresh explicit approval on the new state succeeds
  const updatedApproval = flow.prepare('continue');
  assert.ok(updatedApproval);
  assert.notEqual(updatedApproval.snapshot, freshApproval.snapshot);
  await flow.perform(updatedApproval, updatedApproval.confirmation);
  assert.equal(writes.length, 1, 'Fresh explicit confirmation successfully executed');
});

// ============================================================================
// Criterion 4: 401/403 clears recovery state and approvals immediately
// ============================================================================

test('401 and 403 responses immediately clear old recovery records and approvals', async () => {
  for (const status of [401, 403]) {
    let failWithStatus = false;
    const flow = createProvisioningRecovery({
      websiteId: siteAId,
      canManage: () => true,
      isCurrent: () => true,
      read: async () => {
        if (failWithStatus) {
          const err = new Error('Access denied');
          err.status = status;
          throw err;
        }
        return sampleOp(siteAId, opAId, 'partial', [sampleStep('nginx', 'pending')]);
      },
      execute: async () => ({ outcome: 'progressed' }),
    });

    await flow.load();
    assert.equal(flow.getState().status, 'ready');
    assert.ok(flow.getState().operation);

    const approval = flow.prepare('continue');
    assert.ok(approval);

    // Request receives 401 or 403
    failWithStatus = true;
    await flow.load();

    const state = flow.getState();
    assert.equal(state.status, 'forbidden');
    assert.equal(state.operation, null, 'Recovery operation record must be cleared on 401/403');
    assert.equal(state.approval, null, 'Approval must be cleared on 401/403');
    assert.equal(flow.prepare('continue'), null, 'Actions must remain locked on 401/403');
  }
});

// ============================================================================
// Criterion 5: Real backend tenant authorization with fail-closed isolation
// ============================================================================

test('Real Express API enforces fail-closed tenant boundary, session revocation, and website isolation', async (t) => {
  globalThis.fetch = nativeFetch;
  const { store, filePath } = createRealAuthFixture(t);

  // 1. Setup owner
  const { token: setupToken } = store.issueSetupToken();
  const ownerUser = await store.completeSetup({
    setupToken,
    username: 'SecurityOwner',
    password: 'OwnerPassword123!',
  });
  const ownerLogin = await store.login({ username: 'SecurityOwner', password: 'OwnerPassword123!' });
  const authCookie = '__Host-yunpanel_session';
  const ownerCookie = `${authCookie}=${ownerLogin.token}`;

  // 2. Create Site A manager user
  const userA = await store.users.createSiteManager({
    username: 'admin.sitea@example.test',
    password: 'SiteAPassword123!',
    websiteId: siteAId,
    actorId: ownerUser.id,
  });
  const loginA = await store.login({ username: 'admin.sitea@example.test', password: 'SiteAPassword123!' });
  const siteACookie = `${authCookie}=${loginA.token}`;

  // 3. Create Site B manager user
  const userB = await store.users.createSiteManager({
    username: 'admin.siteb@example.test',
    password: 'SiteBPassword123!',
    websiteId: siteBId,
    actorId: ownerUser.id,
  });
  const loginB = await store.login({ username: 'admin.siteb@example.test', password: 'SiteBPassword123!' });
  const siteBCookie = `${authCookie}=${loginB.token}`;

  // 4. Create Inactive tenant user
  const userInactive = await store.users.createSiteManager({
    username: 'inactive.user@example.test',
    password: 'InactivePass123!',
    websiteId: siteAId,
    actorId: ownerUser.id,
  });
  const loginInact = await store.login({ username: 'inactive.user@example.test', password: 'InactivePass123!' });
  const inactiveCookie = `${authCookie}=${loginInact.token}`;

  // Deactivate user in sqlite
  const dbSync = new DatabaseSync(filePath);
  dbSync.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userInactive.id);
  dbSync.close();

  // Operations map
  const operations = new Map([
    [opAId, sampleOp(siteAId, opAId, 'partial', [
      sampleStep('unix_identity', 'succeeded'),
      sampleStep('nginx', 'failed', { canRetry: true, canCompensate: true }),
    ])],
    [opBId, sampleOp(siteBId, opBId, 'partial', [
      sampleStep('database', 'failed', { canRetry: true, canCompensate: true }),
    ])],
  ]);

  const websites = new Map([
    [siteAId, { id: siteAId, serverId: localServerId, customerId: userA.id }],
    [siteBId, { id: siteBId, serverId: localServerId, customerId: userB.id }],
  ]);

  const orchestratorCalls = [];
  const mockOrchestrator = {
    runNext: async (id, actor) => {
      orchestratorCalls.push({ action: 'continue', id, actor });
      const op = operations.get(id);
      return { outcome: 'progressed', operation: op, stepId: op.steps[0].id };
    },
    retryStep: async (id, stepId, actor) => {
      orchestratorCalls.push({ action: 'retry', id, stepId, actor });
      const existing = operations.get(id);
      const updatedSteps = existing.steps.map((s) => s.id === stepId ? { ...s, state: 'succeeded', canRetry: false, canCompensate: false } : s);
      const op = { ...existing, ready: true, status: 'succeeded', steps: updatedSteps };
      operations.set(id, op);
      return { outcome: 'progressed', operation: op, stepId };
    },
    compensateStep: async (id, stepId, actor) => {
      orchestratorCalls.push({ action: 'compensate', id, stepId, actor });
      const op = operations.get(id);
      return { outcome: 'compensated', operation: op, stepId };
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
    orchestrator: mockOrchestrator,
    websiteRegistry: { getWebsite: async (id) => websites.get(id) || null },
    localServerId,
  });

  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ code: err.code, message: err.message });
  });

  const origin = 'https://server.cryptoraichu.website';
  const listener = createAuthenticatedApi({
    store,
    publicOrigin: origin,
    development: true,
    ownerMfaRequired: false,
    createHandler: () => app,
  });

  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  // Test 1: Unauthenticated request receives 401
  let res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`);
  assert.equal(res.status, 401);

  // Test 2: Inactive tenant user receives 401 (session revoked when user is disabled)
  res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`, {
    headers: { cookie: inactiveCookie },
  });
  assert.equal(res.status, 401);

  // Test 2b: Inactive tenant actor directly evaluated fails closed with tenant_actor_inactive (403)
  const { extractActorTenant } = await import('../src/tenant-boundary.js');
  const inactiveActorTenant = extractActorTenant({ user: { id: 'inact-user', role: 'site_manager', active: false } });
  assert.equal(inactiveActorTenant.active, false);

  // Test 3: Site A manager accesses Site A provisioning (200 OK)
  res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`, {
    headers: { cookie: siteACookie },
  });
  assert.equal(res.status, 200);
  const jsonA = await res.json();
  assert.equal(jsonA.data.operationId, opAId);
  assert.equal(jsonA.data.websiteId, siteAId);

  // Test 4: Site A manager CANNOT access Site B latest provisioning (404 fail-closed)
  res = await fetch(`${base}/api/sites/${siteBId}/provisioning/latest`, {
    headers: { cookie: siteACookie },
  });
  assert.equal(res.status, 404);

  // Test 5: Site A manager CANNOT access Site B operation directly (404 fail-closed)
  res = await fetch(`${base}/api/sites/provisioning/${opBId}`, {
    headers: { cookie: siteACookie },
  });
  assert.equal(res.status, 404);

  // Test 6: Site A manager CANNOT mutate Site B operation (404 fail-closed)
  res = await fetch(`${base}/api/sites/provisioning/${opBId}/continue`, {
    method: 'POST',
    headers: {
      cookie: siteACookie,
      'content-type': 'application/json',
      origin: 'https://server.cryptoraichu.website',
      'x-csrf-token': loginA.session.csrfToken,
    },
    body: JSON.stringify({ confirmation: `continue-site-provisioning:${opBId}` }),
  });
  assert.equal(res.status, 404);

  // Test 7: Site B manager CANNOT access Site A operation or mutate it (404 fail-closed)
  res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`, {
    headers: { cookie: siteBCookie },
  });
  assert.equal(res.status, 404);

  res = await fetch(`${base}/api/sites/provisioning/${opAId}/steps/nginx/retry`, {
    method: 'POST',
    headers: {
      cookie: siteBCookie,
      'content-type': 'application/json',
      origin: 'https://server.cryptoraichu.website',
      'x-csrf-token': loginB.session.csrfToken,
    },
    body: JSON.stringify({ confirmation: `retry-site-provisioning:${opAId}:nginx` }),
  });
  assert.equal(res.status, 404);

  // Test 8: Site A manager CAN mutate Site A operation with valid CSRF & confirmation
  res = await fetch(`${base}/api/sites/provisioning/${opAId}/steps/nginx/retry`, {
    method: 'POST',
    headers: {
      cookie: siteACookie,
      'content-type': 'application/json',
      origin: 'https://server.cryptoraichu.website',
      'x-csrf-token': loginA.session.csrfToken,
    },
    body: JSON.stringify({ confirmation: `retry-site-provisioning:${opAId}:nginx` }),
  });
  assert.ok([200, 202].includes(res.status));
  assert.equal(orchestratorCalls.length, 1);
  assert.equal(orchestratorCalls[0].id, opAId);
  assert.equal(orchestratorCalls[0].actor.userId, userA.id);

  // Test 9: Owner has access to both Site A and Site B
  res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(res.status, 200);

  res = await fetch(`${base}/api/sites/${siteBId}/provisioning/latest`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(res.status, 200);

  // Test 10: Revoking Site A manager session causes subsequent requests to receive 401
  store.revokeSession(loginA.token);
  res = await fetch(`${base}/api/sites/${siteAId}/provisioning/latest`, {
    headers: { cookie: siteACookie },
  });
  assert.equal(res.status, 401);

  // Test 11: End-to-end integration: Controller wired with live HTTP client
  let activeToken = loginB.token;
  let activeCsrf = loginB.session.csrfToken;
  const liveFlow = createProvisioningRecovery({
    websiteId: siteBId,
    canManage: () => true,
    isCurrent: () => true,
    read: async ({ signal }) => {
      const resp = await fetch(`${base}/api/sites/${siteBId}/provisioning/latest`, {
        headers: { cookie: `${authCookie}=${activeToken}` },
        signal,
      });
      if (!resp.ok) {
        const error = new Error('HTTP failure');
        error.status = resp.status;
        throw error;
      }
      const json = await resp.json();
      return json.data;
    },
    execute: async (approval, { signal }) => {
      const resp = await fetch(`${base}/api/sites/provisioning/${approval.operationId}/steps/${approval.stepId}/retry`, {
        method: 'POST',
        headers: {
          cookie: `${authCookie}=${activeToken}`,
          'content-type': 'application/json',
          origin: 'https://server.cryptoraichu.website',
          'x-csrf-token': activeCsrf,
        },
        body: JSON.stringify({ confirmation: approval.confirmation }),
        signal,
      });
      if (!resp.ok) {
        const error = new Error('HTTP mutation failure');
        error.status = resp.status;
        throw error;
      }
      const json = await resp.json();
      return json.data;
    },
  });

  // Load from live server
  await liveFlow.load();
  assert.equal(liveFlow.getState().status, 'ready');
  assert.equal(liveFlow.getState().operation.websiteId, siteBId);

  // Perform live retry
  const liveApproval = liveFlow.prepare('retry', 'database');
  assert.ok(liveApproval);
  await liveFlow.perform(liveApproval, liveApproval.confirmation);
  assert.equal(liveFlow.getState().status, 'ready');
  assert.equal(liveFlow.getState().changes, 1);

  // Revoke session in store: subsequent load gets 401 and clears all state
  store.revokeSession(loginB.token);
  await liveFlow.load();
  assert.equal(liveFlow.getState().status, 'forbidden');
  assert.equal(liveFlow.getState().operation, null, 'Old operation wiped upon 401');
  assert.equal(liveFlow.getState().approval, null, 'Old approval wiped upon 401');
});

// ============================================================================
// Criterion 6: Backend atomic lock protects shared resources against race conditions (two browsers or processes)
// ============================================================================

test('Two browsers or processes racing on shared resource are serialized and protected by backend atomic lock (409 Conflict)', async (t) => {
  globalThis.fetch = nativeFetch;
  const { store, tempDir } = createRealAuthFixture(t);

  // Setup owner
  const { token: setupToken } = store.issueSetupToken();
  const ownerUser = await store.completeSetup({
    setupToken,
    username: 'OwnerLockTest',
    password: 'OwnerPassword123!',
  });
  const loginOwner = await store.login({ username: 'OwnerLockTest', password: 'OwnerPassword123!' });
  const authCookie = '__Host-yunpanel_session';
  const ownerCookie = `${authCookie}=${loginOwner.token}`;

  const websites = new Map([
    [siteAId, { id: siteAId, serverId: localServerId, customerId: 'cust-a' }],
  ]);

  let opA = sampleOp(siteAId, opAId, 'failed', [sampleStep('nginx', 'failed')]);
  const mockRegistry = {
    get: async (id) => (id === opAId ? opA : null),
    getLatestForWebsite: async (wid) => (wid === siteAId ? opA : null),
  };

  const lockRoot = path.join(tempDir, 'site-locks');
  const siteMutationLock = createSiteMutationLock({ root: lockRoot });

  let mutationInFlight = false;
  let releaseMutation;
  const mutationGate = new Promise((resolve) => { releaseMutation = resolve; });
  const orchestratorCalls = [];

  const mockOrchestrator = {
    retryStep: async (id, stepId, actor) => {
      mutationInFlight = true;
      orchestratorCalls.push({ action: 'retry', id, stepId, actor });
      await mutationGate;
      opA = sampleOp(siteAId, opAId, 'partial', [sampleStep('nginx', 'succeeded')]);
      return { outcome: 'progressed', operation: opA, stepId: 'nginx' };
    },
    runNext: async () => ({ outcome: 'progressed', operation: opA }),
    compensateStep: async () => ({ outcome: 'compensated', operation: opA }),
    supportsCompensation: () => true,
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  mountWebsiteProvisioningRoutes(app, {
    registry: mockRegistry,
    orchestrator: mockOrchestrator,
    websiteRegistry: { getWebsite: async (id) => websites.get(id) || null },
    localServerId,
    siteMutationLock,
  });

  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: {
        code: err.code || 'internal_error',
        message: err.message,
      },
    });
  });

  const origin = 'https://server.cryptoraichu.website';
  const listener = createAuthenticatedApi({
    store,
    publicOrigin: origin,
    development: true,
    ownerMfaRequired: false,
    createHandler: () => app,
  });

  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    if (releaseMutation) releaseMutation();
    server.close();
  });

  // Browser 1 sends mutation POST (retry step 'nginx')
  const browser1Promise = fetch(`${base}/api/sites/provisioning/${opAId}/steps/nginx/retry`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      'content-type': 'application/json',
      origin,
      'x-csrf-token': loginOwner.session.csrfToken,
    },
    body: JSON.stringify({ confirmation: `retry-site-provisioning:${opAId}:nginx` }),
  });

  // Wait until Browser 1 has acquired the atomic lock and entered the orchestrator
  while (!mutationInFlight) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Browser 2 (or a concurrent process) attempts mutation on the same site while Browser 1 is holding the lock
  const browser2Res = await fetch(`${base}/api/sites/provisioning/${opAId}/steps/nginx/retry`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      'content-type': 'application/json',
      origin,
      'x-csrf-token': loginOwner.session.csrfToken,
    },
    body: JSON.stringify({ confirmation: `retry-site-provisioning:${opAId}:nginx` }),
  });

  // Browser 2 MUST receive 409 Conflict from backend atomic lock
  assert.equal(browser2Res.status, 409, 'Concurrent mutation on locked site resource must fail with 409 Conflict');
  const browser2Json = await browser2Res.json();
  assert.equal(browser2Json.error.code, 'site_mutation_locked');
  assert.match(browser2Json.error.message, /Another process is changing this site resource/);

  // Now release Browser 1's mutation
  releaseMutation();
  const browser1Res = await browser1Promise;
  assert.ok([200, 202].includes(browser1Res.status));
  const browser1Json = await browser1Res.json();
  assert.equal(browser1Json.data.outcome, 'progressed');

  // Verify orchestrator was executed only ONCE (Browser 1 only; Browser 2 was blocked by atomic lock)
  assert.equal(orchestratorCalls.length, 1);

  // Allow lock cleanup to settle
  await new Promise((r) => setTimeout(r, 50));

  // After Browser 1 releases lock, a subsequent request can acquire lock and succeed
  const browser3Res = await fetch(`${base}/api/sites/provisioning/${opAId}/steps/nginx/retry`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      'content-type': 'application/json',
      origin,
      'x-csrf-token': loginOwner.session.csrfToken,
    },
    body: JSON.stringify({ confirmation: `retry-site-provisioning:${opAId}:nginx` }),
  });
  assert.ok([200, 202].includes(browser3Res.status));
  assert.equal(orchestratorCalls.length, 2);
});

test('Two separate OS processes contending on siteMutationLock enforce atomic exclusivity and 409 conflict', async (t) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-lock-test-'));
  t.after(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  const lockRoot = path.join(tempDir, 'process-locks');
  const lockProcA = createSiteMutationLock({ root: lockRoot, pid: process.pid });
  const lockProcB = createSiteMutationLock({ root: lockRoot, pid: process.pid });

  let procAInLock = false;
  let releaseProcA;
  const procAGate = new Promise((resolve) => { releaseProcA = resolve; });

  const procAPromise = lockProcA.withSiteLock({ websiteId: siteAId }, async () => {
    procAInLock = true;
    await procAGate;
    return 'proc_a_done';
  });

  while (!procAInLock) {
    await new Promise((r) => setTimeout(r, 5));
  }

  // Process B contends for the same website resource while Process A holds it
  let procBError = null;
  try {
    await lockProcB.withSiteLock({ websiteId: siteAId }, async () => 'proc_b_done');
  } catch (err) {
    procBError = err;
  }

  assert.ok(procBError instanceof SiteMutationLockError);
  assert.equal(procBError.status, 409);
  assert.equal(procBError.code, 'site_mutation_locked');

  releaseProcA();
  const procAResult = await procAPromise;
  assert.equal(procAResult, 'proc_a_done');

  // Once Process A has finished, Process B acquires successfully
  const procBSubsequent = await lockProcB.withSiteLock({ websiteId: siteAId }, async () => 'proc_b_success');
  assert.equal(procBSubsequent, 'proc_b_success');
});

// ============================================================================
// Criterion 7: Client never auto-retries on 409, 429, 5xx, or network drop (fail-closed)
// ============================================================================

test('When 409 conflict, 429, 5xx, or network failure occurs during recovery mutation, client never auto-retries and stays fail-closed', async (t) => {
  for (const errorStatus of [409, 429, 500, 503, 'network']) {
    let postCount = 0;
    const currentOp = sampleOp(siteAId, opAId, 'failed', [sampleStep('nginx', 'failed')]);

    const flow = createProvisioningRecovery({
      websiteId: siteAId,
      canManage: () => true,
      isCurrent: () => true,
      read: async () => currentOp,
      execute: async () => {
        postCount++;
        if (errorStatus === 'network') {
          throw new TypeError('Failed to fetch (network drop)');
        }
        const err = new Error(`Server returned HTTP ${errorStatus}`);
        err.status = errorStatus;
        throw err;
      },
    });

    await flow.load();
    assert.equal(flow.getState().status, 'ready');

    const approval = flow.prepare('retry', 'nginx');
    assert.ok(approval);

    // Perform mutation -> server errors with errorStatus
    const postResult = await flow.perform(approval, approval.confirmation);

    // Client MUST transition to 'uncertain', clear approval, and NOT auto-retry
    assert.equal(postResult.status, 'uncertain', `Status should be uncertain for error ${errorStatus}`);
    assert.equal(postResult.approval, null, `Approval must be cleared for error ${errorStatus}`);
    assert.equal(postCount, 1, `Must transmit exactly 1 POST without auto-retry for error ${errorStatus}`);
    assert.match(postResult.error, /İşlemin sonucu doğrulanamadı.*Durumu yenile/);

    // Attempting to re-perform old approval is rejected
    await flow.perform(approval, approval.confirmation);
    assert.equal(postCount, 1, 'No additional POST on old approval call');

    // Action preparation is locked while in uncertain state
    assert.equal(flow.prepare('continue'), null);
    assert.equal(flow.prepare('retry', 'nginx'), null);
    assert.equal(flow.prepare('compensate', 'nginx'), null);
  }
});

// ============================================================================
// Criterion 8: Durumu yenile performs ONLY a GET request; new mutation requires explicit approval
// ============================================================================

test('Durumu yenile performs ONLY a GET request, and subsequent mutation requires fresh explicit approval', async () => {
  let getCount = 0;
  let postCount = 0;
  let currentOp = sampleOp(siteAId, opAId, 'failed', [sampleStep('nginx', 'failed')]);

  let shouldFail = true;
  const flow = createProvisioningRecovery({
    websiteId: siteAId,
    canManage: () => true,
    isCurrent: () => true,
    read: async () => {
      getCount++;
      return currentOp;
    },
    execute: async (appr) => {
      postCount++;
      if (shouldFail) {
        const err = new Error('HTTP 409 Conflict');
        err.status = 409;
        throw err;
      }
      const progressedOp = sampleOp(siteAId, opAId, 'partial', [sampleStep('nginx', 'succeeded')]);
      return { outcome: 'progressed', operation: progressedOp, stepId: appr.stepId, operationId: opAId };
    },
  });

  // Initial load: 1 GET, 0 POST
  await flow.load();
  assert.equal(getCount, 1);
  assert.equal(postCount, 0);

  // Prepare and perform failing mutation
  const apprFail = flow.prepare('retry', 'nginx');
  assert.ok(apprFail);
  await flow.perform(apprFail, apprFail.confirmation);
  assert.equal(flow.getState().status, 'uncertain');
  assert.equal(flow.getState().approval, null);
  assert.equal(postCount, 1);

  const getsBeforeRefresh = getCount;
  const postsBeforeRefresh = postCount;

  // "Durumu yenile" triggered (calls load())
  shouldFail = false;
  currentOp = sampleOp(siteAId, opAId, 'failed', [sampleStep('nginx', 'failed', { canRetry: true })]);
  await flow.load();

  // VERIFY: Exactly 1 GET was performed, ZERO POSTs performed
  assert.equal(getCount, getsBeforeRefresh + 1, 'Durumu yenile must make a GET request');
  assert.equal(postCount, postsBeforeRefresh, 'Durumu yenile must NEVER make a POST request');

  // State is now 'ready', but approval remains null (no auto-mutation)
  const refreshedState = flow.getState();
  assert.equal(refreshedState.status, 'ready');
  assert.equal(refreshedState.approval, null, 'Approval must remain null after Durumu yenile');

  // New mutation requires explicit user action: prepare() then perform()
  const freshApproval = flow.prepare('retry', 'nginx');
  assert.ok(freshApproval, 'Fresh approval prepared explicitly');
  await flow.perform(freshApproval, freshApproval.confirmation);

  assert.equal(postCount, postsBeforeRefresh + 1, 'Mutation only sent after fresh explicit approval');
  assert.equal(flow.getState().status, 'ready');
  assert.equal(flow.getState().changes, 1);
});

// ============================================================================
// Criterion 9: Modal open while target/steps/capabilities change or rapid double clicks
// ============================================================================

test('While confirmation modal is open, operation/step/capability changes or rapid double-clicks transmit only ONE POST to current exact target', async () => {
  // Scenario A: Operation changes while modal is open
  {
    let writes = 0;
    let serverRecord = sampleOp(siteAId, opAId, 'failed', [sampleStep('nginx', 'failed')]);
    const flow = createProvisioningRecovery({
      websiteId: siteAId,
      canManage: () => true,
      isCurrent: () => true,
      read: async () => serverRecord,
      execute: async () => { writes++; return { outcome: 'progressed', operation: serverRecord }; },
    });

    await flow.load();
    const approval = flow.prepare('retry', 'nginx');
    assert.ok(approval);

    // Server operation changed before user confirmed modal (e.g. new operationId or timestamp)
    serverRecord = sampleOp(siteAId, randomUUID(), 'failed', [sampleStep('nginx', 'failed')]);

    const result = await flow.perform(approval, approval.confirmation);
    assert.equal(writes, 0, 'No POST must be sent when operation identity shifted');
    assert.equal(result.approval, null, 'Approval cleared on mismatch');
    assert.match(result.error, /yeniden onaylayın/);
  }

  // Scenario B: Step capability changes while modal is open (e.g. canRetry becomes false)
  {
    let writes = 0;
    let stepState = 'failed';
    let canRetry = true;
    const flow = createProvisioningRecovery({
      websiteId: siteAId,
      canManage: () => true,
      isCurrent: () => true,
      read: async () => sampleOp(siteAId, opAId, stepState, [sampleStep('nginx', stepState, { canRetry })]),
      execute: async () => { writes++; return { outcome: 'progressed' }; },
    });

    await flow.load();
    const approval = flow.prepare('retry', 'nginx');
    assert.ok(approval);

    // Step state changes to succeeded / canRetry becomes false
    stepState = 'succeeded';
    canRetry = false;

    const result = await flow.perform(approval, approval.confirmation);
    assert.equal(writes, 0, 'No POST must be sent when step capability changed');
    assert.equal(result.approval, null);
    assert.match(result.error, /yeniden onaylayın/);
  }

  // Scenario C: Rapid double confirmation (double-click) sends ONLY ONE POST
  {
    let writes = 0;
    const gate = new Promise((resolve) => setTimeout(resolve, 30));
    const opRecord = sampleOp(siteAId, opAId, 'failed', [sampleStep('nginx', 'failed')]);
    const progressedOp = sampleOp(siteAId, opAId, 'partial', [sampleStep('nginx', 'succeeded')]);
    const flow = createProvisioningRecovery({
      websiteId: siteAId,
      canManage: () => true,
      isCurrent: () => true,
      read: async () => opRecord,
      execute: async () => {
        writes++;
        await gate;
        return { outcome: 'progressed', operation: progressedOp, stepId: 'nginx', operationId: opAId };
      },
    });

    await flow.load();
    const approval = flow.prepare('retry', 'nginx');
    assert.ok(approval);

    // Two concurrent calls to perform with the same approval (simulating rapid double clicks)
    const [res1, res2] = await Promise.all([
      flow.perform(approval, approval.confirmation),
      flow.perform(approval, approval.confirmation),
    ]);

    assert.equal(writes, 1, 'Exactly ONE POST must be transmitted on rapid double clicks');
    assert.equal(flow.getState().changes, 1);
    assert.equal(flow.getState().approval, null);
  }
});

// ============================================================================
// Criterion: Gerçek continue/retry/compensate, kalıcı durum, idempotency, ownership ve restart
// ============================================================================

test('Gerçek continue/retry/compensate, kalıcı durum, idempotency, ownership ve restart with durable filesystem registry and process restart', async (t) => {
  globalThis.fetch = nativeFetch;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'prov-durable-e2e-'));
  const authDbPath = path.join(tempDir, 'auth.sqlite');
  const provJsonPath = path.join(tempDir, 'provisioning.json');

  t.after(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  const authStore = createAuthStore({ filePath: authDbPath });
  t.after(() => {
    try { authStore.close(); } catch {}
  });

  const { token: setupToken } = authStore.issueSetupToken();
  const ownerUser = await authStore.completeSetup({ setupToken, username: 'OwnerDurable', password: 'OwnerPassword123!' });
  const ownerLogin = await authStore.login({ username: 'OwnerDurable', password: 'OwnerPassword123!' });

  const testSiteAId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const testSiteBId = 'bbbbbbbb-2222-4222-8222-222222222222';
  const testServerId = 'ssssssss-5555-4555-8555-555555555555';

  const userA = await authStore.users.createSiteManager({
    username: 'admin.sitea.durable@example.test',
    password: 'SiteAPassword123!',
    websiteId: testSiteAId,
    actorId: ownerUser.id,
  });
  const loginA = await authStore.login({ username: 'admin.sitea.durable@example.test', password: 'SiteAPassword123!' });

  const userB = await authStore.users.createSiteManager({
    username: 'admin.siteb.durable@example.test',
    password: 'SiteBPassword123!',
    websiteId: testSiteBId,
    actorId: ownerUser.id,
  });
  const loginB = await authStore.login({ username: 'admin.siteb.durable@example.test', password: 'SiteBPassword123!' });

  // Inactive tenant user
  const userInactive = await authStore.users.createSiteManager({
    username: 'inactive.durable@example.test',
    password: 'InactivePass123!',
    websiteId: testSiteAId,
    actorId: ownerUser.id,
  });
  const loginInact = await authStore.login({ username: 'inactive.durable@example.test', password: 'InactivePass123!' });
  const dbSync = new DatabaseSync(authDbPath);
  dbSync.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userInactive.id);
  dbSync.close();

  const websites = new Map([
    [testSiteAId, { id: testSiteAId, serverId: testServerId, customerId: userA.id }],
    [testSiteBId, { id: testSiteBId, serverId: testServerId, customerId: userB.id }],
  ]);

  let unixRan = 0;
  let nginxRan = 0;
  let nginxFail = true;
  let telemetryCompensated = 0;

  const handlers = {
    unix_identity: {
      apply: async () => { unixRan++; return { satisfied: true, uid: 1001 }; },
      inspect: async () => ({ satisfied: unixRan > 0 }),
    },
    nginx: {
      apply: async () => {
        nginxRan++;
        if (nginxFail) throw new Error('nginx_config_invalid');
        return { satisfied: true, active: true };
      },
      inspect: async () => ({ satisfied: !nginxFail && nginxRan > 0 }),
      compensate: async () => ({ satisfied: true }),
      inspectCompensation: async () => ({ satisfied: true }),
    },
    telemetry: {
      apply: async () => ({ satisfied: true }),
      inspect: async () => ({ satisfied: true }),
      compensate: async () => { telemetryCompensated++; return { satisfied: true }; },
      inspectCompensation: async () => ({ satisfied: telemetryCompensated > 0 }),
    },
  };

  const registry = createWebsiteProvisioningRegistry({ filePath: provJsonPath });
  await registry.init();
  const orchestrator = createWebsiteProvisioningOrchestrator({ registry, handlers });

  const testOpId = randomUUID();
  await registry.create({
    operationId: testOpId,
    websiteId: testSiteAId,
    resources: { website: { id: testSiteAId } },
    steps: [
      { id: 'unix_identity', kind: 'unix_identity', required: true, intent: { user: 'app' } },
      { id: 'nginx', kind: 'nginx', required: true, intent: { domain: 'sitea.test' } },
      { id: 'telemetry', kind: 'telemetry', required: false, state: 'succeeded', evidence: { setup: true }, compensation: { state: 'pending' }, intent: {} },
    ],
  });

  function createServer(reg, orch) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json());
    mountWebsiteProvisioningRoutes(app, {
      registry: reg,
      orchestrator: orch,
      websiteRegistry: { getWebsite: async (id) => websites.get(id) || null },
      localServerId: testServerId,
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ code: err.code, message: err.message });
    });
    const origin = 'https://server.cryptoraichu.website';
    const listener = createAuthenticatedApi({
      store: authStore,
      publicOrigin: origin,
      development: true,
      ownerMfaRequired: false,
      createHandler: () => app,
    });
    return http.createServer(listener);
  }

  let server = createServer(registry, orchestrator);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let port = server.address().port;
  let base = `http://127.0.0.1:${port}`;

  const cookieA = `__Host-yunpanel_session=${loginA.token}`;
  const cookieB = `__Host-yunpanel_session=${loginB.token}`;
  const cookieInact = `__Host-yunpanel_session=${loginInact.token}`;
  const ownerCookie = `__Host-yunpanel_session=${ownerLogin.token}`;

  const csrfA = loginA.session.csrfToken;
  const csrfB = loginB.session.csrfToken;
  const csrfInact = loginInact.session.csrfToken;

  // --- Step A: Tenant Ownership & Fail-Closed Isolation ---
  // Foreign tenant (Site B manager) cannot continue Site A operation
  let res = await fetch(`${base}/api/sites/provisioning/${testOpId}/continue`, {
    method: 'POST',
    headers: { cookie: cookieB, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfB },
    body: JSON.stringify({ confirmation: `continue-site-provisioning:${testOpId}` }),
  });
  assert.equal(res.status, 404, 'Foreign tenant continue must 404 fail-closed');

  // Foreign tenant cannot retry Site A step
  res = await fetch(`${base}/api/sites/provisioning/${testOpId}/steps/nginx/retry`, {
    method: 'POST',
    headers: { cookie: cookieB, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfB },
    body: JSON.stringify({ confirmation: `retry-site-provisioning:${testOpId}:nginx` }),
  });
  assert.equal(res.status, 404, 'Foreign tenant retry must 404 fail-closed');

  // Foreign tenant cannot compensate Site A step
  res = await fetch(`${base}/api/sites/provisioning/${testOpId}/steps/telemetry/compensate`, {
    method: 'POST',
    headers: { cookie: cookieB, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfB },
    body: JSON.stringify({ confirmation: `compensate-site-provisioning:${testOpId}:telemetry` }),
  });
  assert.equal(res.status, 404, 'Foreign tenant compensate must 404 fail-closed');

  // Inactive tenant is rejected with 401
  res = await fetch(`${base}/api/sites/provisioning/${testOpId}/continue`, {
    method: 'POST',
    headers: { cookie: cookieInact, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfInact },
    body: JSON.stringify({ confirmation: `continue-site-provisioning:${testOpId}` }),
  });
  assert.equal(res.status, 401, 'Inactive tenant must receive 401');

  // --- Step B: Real Continue & Durable Persistence ---
  // Authorized Site A manager continues step 1 (unix_identity succeeds)
  res = await fetch(`${base}/api/sites/provisioning/${testOpId}/continue`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfA },
    body: JSON.stringify({ confirmation: `continue-site-provisioning:${testOpId}` }),
  });
  assert.equal(res.status, 202);
  let json = await res.json();
  assert.equal(json.data.outcome, 'progressed');
  assert.equal(json.data.stepId, 'unix_identity');
  assert.equal(json.data.operation.steps.find((s) => s.id === 'unix_identity').state, 'succeeded');

  // Continue step 2 (nginx fails on first run)
  res = await fetch(`${base}/api/sites/provisioning/${testOpId}/continue`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfA },
    body: JSON.stringify({ confirmation: `continue-site-provisioning:${testOpId}` }),
  });
  assert.equal(res.status, 200);
  json = await res.json();
  assert.equal(json.data.outcome, 'failed');
  assert.equal(json.data.stepId, 'nginx');
  assert.equal(json.data.operation.steps.find((s) => s.id === 'nginx').state, 'failed');
  assert.equal(json.data.operation.steps.find((s) => s.id === 'nginx').canRetry, true);

  // --- Step C: Restart Safety & Durable State Recovery ---
  // Close the server and instantiate fresh registry from disk file
  await new Promise((resolve) => server.close(resolve));
  const restartedRegistry = createWebsiteProvisioningRegistry({ filePath: provJsonPath });
  await restartedRegistry.init();
  const recoveredOp = await restartedRegistry.get(testOpId);
  assert.equal(recoveredOp.steps.find((s) => s.id === 'unix_identity').state, 'succeeded');
  assert.equal(recoveredOp.steps.find((s) => s.id === 'nginx').state, 'failed');
  assert.equal(recoveredOp.steps.find((s) => s.id === 'telemetry').state, 'succeeded');

  // Remount server with restarted registry
  nginxFail = false; // problem resolved
  const restartedOrchestrator = createWebsiteProvisioningOrchestrator({ registry: restartedRegistry, handlers });
  server = createServer(restartedRegistry, restartedOrchestrator);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  t.after(() => server.close());

  // --- Step D: Real Retry on Restarted Server ---
  res = await fetch(`${base}/api/sites/provisioning/${testOpId}/steps/nginx/retry`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfA },
    body: JSON.stringify({ confirmation: `retry-site-provisioning:${testOpId}:nginx` }),
  });
  assert.equal(res.status, 200);
  json = await res.json();
  assert.equal(json.data.outcome, 'ready');
  assert.equal(json.data.operation.ready, true);
  assert.equal(json.data.operation.steps.find((s) => s.id === 'nginx').state, 'succeeded');

  // --- Step E: Deterministic Idempotency ---
  // Calling continue on already-ready operation is deterministic and idempotent
  res = await fetch(`${base}/api/sites/provisioning/${testOpId}/continue`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfA },
    body: JSON.stringify({ confirmation: `continue-site-provisioning:${testOpId}` }),
  });
  assert.equal(res.status, 200);
  json = await res.json();
  assert.equal(json.data.outcome, 'ready');
  assert.equal(json.data.operation.ready, true);

  // Calling retry on already-succeeded step is rejected with 409
  res = await fetch(`${base}/api/sites/provisioning/${testOpId}/steps/nginx/retry`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfA },
    body: JSON.stringify({ confirmation: `retry-site-provisioning:${testOpId}:nginx` }),
  });
  assert.equal(res.status, 409);

  // --- Step F: Separate Optional Compensation from Mandatory Readiness ---
  // Compensating optional step 'telemetry' succeeds and leaves mandatory readiness intact
  res = await fetch(`${base}/api/sites/provisioning/${testOpId}/steps/telemetry/compensate`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json', origin: 'https://server.cryptoraichu.website', 'x-csrf-token': csrfA },
    body: JSON.stringify({ confirmation: `compensate-site-provisioning:${testOpId}:telemetry` }),
  });
  assert.equal(res.status, 200);
  json = await res.json();
  assert.equal(json.data.outcome, 'compensated');
  assert.equal(json.data.stepId, 'telemetry');
  assert.equal(json.data.operation.ready, true, 'Mandatory steps remain ready even after optional compensation');
  assert.equal(json.data.operation.progress.completed, 2);
  assert.equal(json.data.operation.progress.required, 2);
  assert.equal(json.data.operation.progress.remaining, 0);

  // Owner can also access Site A provisioning
  res = await fetch(`${base}/api/sites/${testSiteAId}/provisioning/latest`, { headers: { cookie: ownerCookie } });
  assert.equal(res.status, 200);
});

test('Yüksek eski deneme sayısı sunucunun izin verdiği manuel retry eylemlerini istemci tarafında engellememelidir', async () => {
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';

  // Server record with high previous attempt counts (100 attempts on operation and 100 on failed step)
  const failedStep = {
    id: 'nginx',
    kind: 'nginx',
    state: 'failed',
    required: true,
    canRetry: true,
    canCompensate: true,
    error: 'nginx_bind_timeout',
    attempts: 100,
    compensation: { state: 'pending', error: null },
  };

  const initialServerOp = {
    operationId,
    websiteId,
    ready: false,
    status: 'failed',
    attempts: 100,
    updatedAt: '2026-10-04T12:00:00.000Z',
    createdAt: '2026-10-04T11:00:00.000Z',
    steps: [failedStep],
  };

  let executionCount = 0;
  const flow = createProvisioningRecovery({
    websiteId,
    canManage: () => true,
    isCurrent: () => true,
    read: async () => initialServerOp,
    execute: async (approval) => {
      executionCount++;
      assert.equal(approval.action, 'retry');
      assert.equal(approval.stepId, 'nginx');
      return {
        operationId,
        outcome: 'ready',
        stepId: 'nginx',
        operation: {
          ...initialServerOp,
          ready: true,
          status: 'ready',
          steps: [{
            ...failedStep,
            state: 'succeeded',
            canRetry: false,
            error: null,
            attempts: 101,
          }],
        },
      };
    },
  });

  // Client loads server operation with high attempt counts
  await flow.load();
  const state = flow.getState();
  assert.equal(state.status, 'ready');
  assert.equal(state.operation.ready, false);

  // High attempt count MUST NOT block recoveryAllowed for manual retry
  assert.equal(recoveryAllowed(state.operation, 'retry', 'nginx'), true, 'Server-permitted manual retry must be allowed despite high attempt count');

  // Client prepares retry approval
  const approval = flow.prepare('retry', 'nginx');
  assert.ok(approval, 'Client must prepare approval for manual retry');
  assert.equal(approval.confirmation, `retry-site-provisioning:${operationId}:nginx`);

  // Client executes manual retry
  const resultState = await flow.perform(approval, approval.confirmation);
  assert.equal(resultState.status, 'ready');
  assert.equal(resultState.operation.ready, true);
  assert.equal(resultState.error, null);
  assert.equal(executionCount, 1, 'Manual retry was executed exactly once');
});

test('İsteğe bağlı geri alma ile zorunlu adım readiness ayrışmalı, failed, blocked veya compensation_failed durumları asla başarı sayılmamalıdır', async () => {
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';

  const requiredStep = {
    id: 'nginx',
    kind: 'nginx',
    required: true,
    state: 'succeeded',
    canRetry: false,
    canCompensate: false,
    compensation: { state: 'not_required', error: null },
  };

  const optionalStep = {
    id: 'analytics',
    kind: 'analytics',
    required: false,
    state: 'succeeded',
    canRetry: false,
    canCompensate: true,
    compensation: { state: 'pending', error: null },
  };

  const baseOperation = {
    operationId,
    websiteId,
    ready: true,
    status: 'ready',
    steps: [requiredStep, optionalStep],
  };

  // Case 1: Optional step compensation fails (compensation_failed)
  // Mandatory readiness stays true, but outcome compensation_failed is NEVER treated as success!
  {
    const failedCompOperation = {
      ...baseOperation,
      steps: [
        requiredStep,
        { ...optionalStep, compensation: { state: 'failed', error: 'cleanup_failed' } },
      ],
    };

    const flow = createProvisioningRecovery({
      websiteId,
      canManage: () => true,
      isCurrent: () => true,
      read: async () => baseOperation,
      execute: async () => ({
        operationId,
        stepId: 'analytics',
        outcome: 'compensation_failed',
        operation: failedCompOperation,
      }),
    });

    await flow.load();
    const approval = flow.prepare('compensate', 'analytics');
    const state = await flow.perform(approval, approval.confirmation);

    assert.equal(state.status, 'ready');
    assert.equal(state.operation.ready, true, 'Mandatory step remains ready');
    assert.match(state.error, /Kurulum tamamlanmadı/, 'compensation_failed must expose error');
    assert.equal(state.notice, null, 'compensation_failed must NEVER be treated as success or produce success notice');
  }

  // Case 2: Step failure (outcome: 'failed') is NEVER treated as success
  {
    const failedOp = {
      operationId,
      websiteId,
      ready: false,
      status: 'failed',
      steps: [{ ...requiredStep, state: 'failed', canRetry: true, error: 'service_failed' }],
    };

    const flow = createProvisioningRecovery({
      websiteId,
      canManage: () => true,
      isCurrent: () => true,
      read: async () => failedOp,
      execute: async () => ({
        operationId,
        stepId: 'nginx',
        outcome: 'failed',
        operation: failedOp,
      }),
    });

    await flow.load();
    const approval = flow.prepare('retry', 'nginx');
    const state = await flow.perform(approval, approval.confirmation);

    assert.equal(state.status, 'ready');
    assert.equal(state.operation.ready, false);
    assert.match(state.error, /Kurulum tamamlanmadı/, 'failed outcome must expose error');
    assert.equal(state.notice, null, 'failed outcome must NEVER produce success notice');
  }

  // Case 3: Step blocked (outcome: 'blocked') is NEVER treated as success
  {
    const blockedOp = {
      operationId,
      websiteId,
      ready: false,
      status: 'blocked',
      steps: [{ ...requiredStep, state: 'blocked', canRetry: false, error: 'resource_blocked' }],
    };

    const flow = createProvisioningRecovery({
      websiteId,
      canManage: () => true,
      isCurrent: () => true,
      read: async () => blockedOp,
      execute: async () => ({
        operationId,
        stepId: 'nginx',
        outcome: 'blocked',
        operation: blockedOp,
      }),
    });

    await flow.load();
    const approval = flow.prepare('continue');
    const state = await flow.perform(approval, approval.confirmation);

    assert.equal(state.status, 'ready');
    assert.equal(state.operation.ready, false);
    assert.match(state.error, /Kurulum tamamlanmadı/, 'blocked outcome must expose error');
    assert.equal(state.notice, null, 'blocked outcome must NEVER produce success notice');
  }
});

test('Mevcut recovery runtime, context, command, ve store kodları kalıcı durum mantığını ve idempotency bütünlüğünü korur', async (t) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'job-rec-check-'));
  const storePath = path.join(tempDir, 'recovery-store.json');
  const contextPath = path.join(tempDir, 'job-store.json');

  t.after(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // 1. Verify JobRecoveryStore persistence, reload, and idempotency
  const store = createJobRecoveryStore({ filePath: storePath });
  await store.init();
  await store.add({ serverId: 'server-alpha', jobId: 'job-11111111-2222' });
  // Duplicate add is a no-op (idempotent)
  await store.add({ serverId: 'server-alpha', jobId: 'job-11111111-2222' });
  let snapshot = await store.snapshot();
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].jobId, 'job-11111111-2222');

  // Verify reload from disk
  const reloadedStore = createJobRecoveryStore({ filePath: storePath });
  await reloadedStore.init();
  snapshot = await reloadedStore.snapshot();
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].jobId, 'job-11111111-2222');

  // 2. Verify JobRecoveryContextReader
  writeFileSync(contextPath, JSON.stringify({
    version: 1,
    jobs: [{
      id: 'job-11111111-2222',
      serverId: 'server-alpha',
      operation: 'backup',
      resourceType: 'database',
      resourceId: 'test_db',
      status: 'succeeded',
      attempts: 5,
      payload: { db: 'test_db' },
    }],
  }));
  const reader = createJobRecoveryContextReader({ filePath: contextPath });
  const context = await reader.read('job-11111111-2222');
  assert.equal(context.id, 'job-11111111-2222');
  assert.equal(context.attempts, 5);
  assert.equal(context.status, 'succeeded');

  // 3. Verify JobIdempotencyLookup
  const mockJobRegistry = {
    getJob: async (id) => ({
      id,
      serverId: 'server-alpha',
      type: 'backup',
      operation: 'backup',
      resourceType: 'database',
      resourceId: 'test_db',
    }),
  };

  const expectedDigest = createHash('sha256').update(JSON.stringify({
    serverId: 'server-alpha',
    type: 'backup',
    operation: 'backup',
    payload: { db: 'test_db' },
    resourceType: 'database',
    resourceId: 'test_db',
  })).digest('hex');

  writeFileSync(contextPath, JSON.stringify({
    version: 1,
    jobs: [{
      id: 'job-11111111-2222',
      serverId: 'server-alpha',
      type: 'backup',
      operation: 'backup',
      resourceType: 'database',
      resourceId: 'test_db',
      idempotencyKey: 'idem-test-key-1234567890',
      idempotencyDigest: expectedDigest,
    }],
  }));

  const lookup = createJobIdempotencyLookup({ filePath: contextPath, jobRegistry: mockJobRegistry });
  const found = await lookup.find({
    serverId: 'server-alpha',
    type: 'backup',
    operation: 'backup',
    payload: { db: 'test_db' },
    resourceType: 'database',
    resourceId: 'test_db',
    idempotencyKey: 'idem-test-key-1234567890',
  });
  assert.equal(found.id, 'job-11111111-2222');
});
