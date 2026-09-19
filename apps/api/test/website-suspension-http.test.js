import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  mountWebsiteSuspensionRoutes,
} from '../src/website-suspension-http.js';

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
  mountWebsiteSuspensionRoutes(app, { runtime });
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.code || err.message });
  });
  return app;
}

test('website-suspension-http routes respond to preview and start requests', async () => {
  const mockRuntime = {
    preview: async ({ websiteId }) => ({
      website: { id: websiteId, revision: 1 },
      readyToSuspend: true,
      previewDigest: 'a'.repeat(64),
      confirmation: `start-website-suspend:${websiteId}:1:${'a'.repeat(64)}`,
    }),
    listForWebsite: async () => [],
    start: async ({ websiteId, previewDigest, confirmation }) => ({
      id: 'ws-op-1',
      websiteId,
      status: 'suspended',
    }),
    resume: async ({ websiteId, operationId }) => ({
      id: operationId,
      websiteId,
      status: 'resumed',
    }),
    retrySuspend: async () => {},
    retryResume: async () => {},
  };

  const app = createTestApp(mockRuntime);
  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. GET /api/websites/:websiteId/suspension
    const getRes = await fetch(`${baseUrl}/api/websites/ws-1/suspension`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.preview.readyToSuspend, true);
    assert.equal(getData.preview.previewDigest, 'a'.repeat(64));

    // 2. POST /api/websites/:websiteId/suspension/start
    const postRes = await fetch(`${baseUrl}/api/websites/ws-1/suspension/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewDigest: 'a'.repeat(64),
        confirmation: `start-website-suspend:ws-1:1:${'a'.repeat(64)}`,
      }),
    });
    assert.equal(postRes.status, 201);
    const postData = await postRes.json();
    assert.equal(postData.operation.status, 'suspended');

    // 3. Invalid POST body rejected
    const badRes = await fetch(`${baseUrl}/api/websites/ws-1/suspension/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrongField: 'invalid' }),
    });
    assert.equal(badRes.status, 400);
  } finally {
    server.close();
  }
});
