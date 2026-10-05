import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
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
