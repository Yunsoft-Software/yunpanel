import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  mountWebsiteRemovalRoutes,
  WebsiteRemovalHttpError,
} from '../src/website-removal-http.js';

function createMockRuntime() {
  const op = {
    id: 'ws-rem-1',
    websiteId: 'ws-1',
    status: 'running',
    updatedAt: '2026-09-19T20:00:00.000Z',
    steps: [{ id: '001:domain_removal:dom-1', status: 'pending' }],
    actions: {
      stepContinuationConfirmation: 'continue-website-remove-step:ws-1:ws-rem-1:001:domain_removal:dom-1:2026-09-19T20:00:00.000Z',
    },
  };
  return {
    preview: async ({ websiteId }) => ({
      version: 1,
      operation: 'website_remove',
      websiteId,
      previewDigest: 'a'.repeat(64),
      confirmation: `start-website-remove:${websiteId}:1:${'a'.repeat(64)}`,
    }),
    start: async () => op,
    continueStep: async () => ({ ...op, status: 'removed' }),
    get: async (id) => (id === 'ws-rem-1' ? op : null),
    listForWebsite: async (wsId) => (wsId === 'ws-1' ? [op] : []),
  };
}

function createTestApp(runtime) {
  const app = express();
  app.use(express.json());
  // Mock panel route access middleware
  app.use((req, res, next) => {
    req.auth = {
      user: { role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });
  mountWebsiteRemovalRoutes(app, { runtime });
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });
  return app;
}

test('website-removal-http mounts preview, start, continue and get routes', async () => {
  const runtime = createMockRuntime();
  const app = createTestApp(runtime);
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET preview
    const resPreview = await fetch(`${baseUrl}/api/websites/ws-1/removal`);
    assert.equal(resPreview.status, 200);
    const dataPreview = await resPreview.json();
    assert.equal(dataPreview.preview.websiteId, 'ws-1');
    assert.equal(dataPreview.operations.length, 1);

    // 2. POST start
    const resStart = await fetch(`${baseUrl}/api/websites/ws-1/removal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: 'a'.repeat(64),
        confirmation: `start-website-remove:ws-1:1:${'a'.repeat(64)}`,
      }),
    });
    assert.equal(resStart.status, 201);
    const dataStart = await resStart.json();
    assert.equal(dataStart.operation.id, 'ws-rem-1');

    // 3. POST continue
    const resContinue = await fetch(`${baseUrl}/api/websites/ws-1/removal-operations/ws-rem-1/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedUpdatedAt: '2026-09-19T20:00:00.000Z',
        stepId: '001:domain_removal:dom-1',
        confirmation: 'continue-website-remove-step:ws-1:ws-rem-1:001:domain_removal:dom-1:2026-09-19T20:00:00.000Z',
      }),
    });
    assert.equal(resContinue.status, 200);
    const dataContinue = await resContinue.json();
    assert.equal(dataContinue.operation.status, 'removed');

    // 4. GET operations
    const resOps = await fetch(`${baseUrl}/api/websites/ws-1/removal-operations`);
    assert.equal(resOps.status, 200);
    const dataOps = await resOps.json();
    assert.equal(dataOps.operations.length, 1);

    // 5. GET single operation
    const resSingle = await fetch(`${baseUrl}/api/websites/ws-1/removal-operations/ws-rem-1`);
    assert.equal(resSingle.status, 200);
    const dataSingle = await resSingle.json();
    assert.equal(dataSingle.operation.id, 'ws-rem-1');
  } finally {
    server.close();
  }
});
