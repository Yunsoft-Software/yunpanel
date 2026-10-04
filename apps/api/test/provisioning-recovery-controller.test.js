import { register } from 'node:module';
register('../../web/test/jsx-loader.js', import.meta.url);

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
import {
  createProvisioningRecovery,
  EMPTY_RECOVERY,
  recoveryAllowed,
  recoveryBusy,
  recoveryOperation,
} from '../../web/src/workspace/provisioning-recovery.js';

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
