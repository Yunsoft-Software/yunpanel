import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  mountDomainRemovalRoutes,
} from '../src/domain-removal-http.js';

function createTestApp(runtime) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = {
      user: { role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountDomainRemovalRoutes(app, { runtime });
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: { code: err.code || err.message } });
  });
  return app;
}

test('domain-removal-http routes handle preview, start, continue and retry requests', async () => {
  const checksum = 'a'.repeat(64);
  const mockOperation = {
    id: 'op-1',
    domainId: 'dom-1',
    status: 'running',
    checksum,
    updatedAt: '2026-09-19T20:00:00.000Z',
    steps: [
      { id: 'step-1', kind: 'routing_suspend', status: 'failed' },
      { id: 'step-2', kind: 'certificate', status: 'pending' },
    ],
  };

  const mockRuntime = {
    preview: async ({ domainId }) => ({
      domain: { id: domainId },
      readyToStart: true,
      previewDigest: checksum,
      confirmation: `start-domain-remove:${domainId}:1:${checksum}`,
    }),
    listForDomain: async () => [mockOperation],
    get: async (id) => (id === 'op-1' ? mockOperation : null),
    start: async ({ domainId }) => ({ ...mockOperation, domainId }),
    retryRouting: async () => ({ ...mockOperation, status: 'running' }),
    continueStep: async () => ({ ...mockOperation, status: 'succeeded' }),
  };

  const app = createTestApp(mockRuntime);
  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. GET /api/domains/:domainId/removal
    const getRes = await fetch(`${baseUrl}/api/domains/dom-1/removal`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.preview.readyToStart, true);
    assert.equal(getData.operations.length, 1);

    // 2. POST /api/domains/:domainId/removal-preview
    const previewRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-preview`, { method: 'POST' });
    assert.equal(previewRes.status, 200);
    const previewData = await previewRes.json();
    assert.equal(previewData.preview.readyToStart, true);

    // 3. POST /api/domains/:domainId/removal (start)
    const startRes = await fetch(`${baseUrl}/api/domains/dom-1/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: checksum,
        confirmation: `start-domain-remove:dom-1:1:${checksum}`,
      }),
    });
    assert.equal(startRes.status, 201);
    const startData = await startRes.json();
    assert.equal(startData.operation.id, 'op-1');

    // 4. GET /api/domains/:domainId/removal-operations
    const listRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-operations`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.operations.length, 1);

    // 5. GET /api/domains/:domainId/removal-operations/:operationId
    const opRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-operations/op-1`);
    assert.equal(opRes.status, 200);
    const opData = await opRes.json();
    assert.equal(opData.operation.id, 'op-1');

    // 6. POST retry-routing
    const retryRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-operations/op-1/retry-routing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-09-19T20:00:00.000Z',
        checksum,
        confirmation: 'retry-domain-routing:op-1',
      }),
    });
    assert.equal(retryRes.status, 200);

    // 7. POST continue
    const continueRes = await fetch(`${baseUrl}/api/domains/dom-1/removal-operations/op-1/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-09-19T20:00:00.000Z',
        stepId: 'step-2',
        checksum,
        confirmation: 'continue-domain-step:op-1:step-2',
      }),
    });
    assert.equal(continueRes.status, 200);

    // 8. Invalid body rejected
    const badRes = await fetch(`${baseUrl}/api/domains/dom-1/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bad: 'input' }),
    });
    assert.equal(badRes.status, 400);
  } finally {
    server.close();
  }
});
