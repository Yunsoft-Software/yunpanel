import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { mountWebsitePhpToolsRoutes } from '../src/website-php-tools-http.js';

const WEBSITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function createTestApp({
  websitePhpToolsService = {},
  websitePhpToolActionService = null,
  userRole = 'owner',
  unauthenticated = false,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (unauthenticated) return next();
    if (userRole === 'owner') {
      req.auth = {
        id: '11111111-1111-4111-8111-111111111111',
        user: { id: 'owner-id', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
    } else if (['site_manager', 'reseller', 'customer'].includes(userRole)) {
      req.auth = {
        id: '22222222-2222-4222-8222-222222222222',
        user: { id: `${userRole}-id`, role: userRole, websiteIds: [WEBSITE_ID] },
        access: { mode: 'site_management', permissions: ['sites.manage'] },
        security: { managementAllowed: true },
      };
    } else if (userRole === 'read_only') {
      req.auth = {
        id: '33333333-3333-4333-8333-333333333333',
        user: { id: 'read-only-id', role: 'read_only' },
        access: { mode: 'read_only', permissions: ['websites.read'] },
        security: { managementAllowed: false },
      };
    }
    next();
  });

  mountWebsitePhpToolsRoutes(app, {
    websitePhpToolsService,
    websitePhpToolActionService,
  });

  return app;
}

test('GET /api/websites/:websiteId/wp-cli/status returns status', async () => {
  const app = createTestApp({
    websitePhpToolsService: {
      getWpCliStatus: async (id) => {
        assert.equal(id, WEBSITE_ID);
        return { available: true, version: '2.8.1', installed: true, coreVersion: '6.4.2' };
      },
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/wp-cli/status`;

  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.coreVersion, '6.4.2');
  } finally {
    server.close();
  }
});

test('POST /api/websites/:websiteId/wp-cli/run validates request and runs command', async () => {
  const app = createTestApp({
    websitePhpToolsService: {
      runWpCli: async (id, { command, args }) => {
        assert.equal(id, WEBSITE_ID);
        assert.equal(command, 'cache');
        assert.deepEqual(args, ['flush']);
        return { success: true, exitCode: 0, stdout: 'Success: Cache flushed.\n', stderr: '' };
      },
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/wp-cli/run`;

  try {
    // Missing command -> 400
    const badRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['flush'] }),
    });
    assert.equal(badRes.status, 400);

    // Invalid args -> 400
    const badArgsRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'cache', args: 'not-an-array' }),
    });
    assert.equal(badArgsRes.status, 400);

    // Valid call -> 200
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'cache', args: ['flush'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.stdout, 'Success: Cache flushed.\n');
  } finally {
    server.close();
  }
});

test('GET /api/websites/:websiteId/composer/status returns status', async () => {
  const app = createTestApp({
    websitePhpToolsService: {
      getComposerStatus: async (id) => {
        assert.equal(id, WEBSITE_ID);
        return { available: true, version: '2.7.2', hasComposerJson: true, valid: true };
      },
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/composer/status`;

  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.hasComposerJson, true);
    assert.equal(body.valid, true);
  } finally {
    server.close();
  }
});

test('POST /api/websites/:websiteId/composer/run validates request and runs command', async () => {
  const app = createTestApp({
    websitePhpToolsService: {
      runComposer: async (id, { command, args }) => {
        assert.equal(id, WEBSITE_ID);
        assert.equal(command, 'validate');
        assert.deepEqual(args, ['--strict']);
        return { success: true, exitCode: 0, stdout: 'valid\n', stderr: '' };
      },
    },
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/composer/run`;

  try {
    // Valid call -> 200
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'validate', args: ['--strict'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.stdout, 'valid\n');
  } finally {
    server.close();
  }
});

test('requires an authenticated Owner management context', async () => {
  const app = createTestApp({
    websitePhpToolsService: {},
    userRole: 'read_only',
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/wp-cli/status`;

  try {
    const res = await fetch(url);
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('POST /api/websites/:websiteId/actions/preview returns action preview', async () => {
  const previewData = {
    actionId: 'wp.cache.flush',
    previewDigest: 'c'.repeat(64),
    confirmation: `php-tool:${WEBSITE_ID}:wp.cache.flush:${'c'.repeat(64)}`,
  };
  const app = createTestApp({
    websitePhpToolsService: {
      getActionPreview: async (id, actionId) => {
        assert.equal(id, WEBSITE_ID);
        assert.equal(actionId, 'wp.cache.flush');
        return previewData;
      },
    },
    userRole: 'site_manager',
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/actions/preview`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: 'wp.cache.flush' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, previewData);

    // Invalid body fails with 400
    const badRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: 'wp.cache.flush', extra: true }),
    });
    assert.equal(badRes.status, 400);
  } finally {
    server.close();
  }
});

test('POST /api/websites/:websiteId/actions/queue enqueues action and binds live actor context', async () => {
  const queuedCalls = [];
  const actionPayload = {
    actionId: 'wp.cache.flush',
    expectedWebsiteRevision: 4,
    previewDigest: 'c'.repeat(64),
    confirmation: `php-tool:${WEBSITE_ID}:wp.cache.flush:${'c'.repeat(64)}`,
  };
  const app = createTestApp({
    websitePhpToolsService: {},
    websitePhpToolActionService: {
      queue: async (websiteId, input, actor) => {
        queuedCalls.push({ websiteId, input, actor });
        return {
          action: { actionId: input.actionId, websiteId },
          job: { id: 'job-123', status: 'queued' },
        };
      },
    },
    userRole: 'customer',
  });

  const server = app.listen(0);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/websites/${WEBSITE_ID}/actions/queue`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(actionPayload),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.data.job.status, 'queued');
    assert.equal(queuedCalls.length, 1);
    assert.equal(queuedCalls[0].websiteId, WEBSITE_ID);
    assert.equal(queuedCalls[0].actor.role, 'customer');
    assert.equal(queuedCalls[0].actor.userId, 'customer-id');
    assert.equal(queuedCalls[0].actor.sessionId, '22222222-2222-4222-8222-222222222222');
  } finally {
    server.close();
  }
});

test('POST /api/websites/:websiteId/actions/queue fails closed for unauthenticated and read_only requests', async () => {
  const unauthApp = createTestApp({
    websitePhpToolsService: {},
    websitePhpToolActionService: { queue: async () => ({}) },
    unauthenticated: true,
  });
  const readOnlyApp = createTestApp({
    websitePhpToolsService: {},
    websitePhpToolActionService: { queue: async () => ({}) },
    userRole: 'read_only',
  });

  const s1 = unauthApp.listen(0);
  const s2 = readOnlyApp.listen(0);
  try {
    const unauthRes = await fetch(`http://127.0.0.1:${s1.address().port}/api/websites/${WEBSITE_ID}/actions/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: 'wp.cache.flush' }),
    });
    assert.equal(unauthRes.status, 401);

    const readOnlyRes = await fetch(`http://127.0.0.1:${s2.address().port}/api/websites/${WEBSITE_ID}/actions/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: 'wp.cache.flush' }),
    });
    assert.equal(readOnlyRes.status, 403);
  } finally {
    s1.close();
    s2.close();
  }
});

test('authenticated boundary fails closed on revoked session or invalid CSRF for action queue', async (t) => {
  const origin = 'https://panel.example.test';
  const csrfToken = 'valid-csrf-token-12345';
  let sessionActive = true;
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    user: { id: 'owner-user', username: 'owner', role: 'owner' },
    csrfToken,
  };
  const store = {
    configured: () => true,
    mfa: { enabled: () => true },
    getSession: (token) => sessionActive && token === 'valid-token' ? session : null,
  };

  const coreApp = express();
  coreApp.use(express.json());
  mountWebsitePhpToolsRoutes(coreApp, {
    websitePhpToolsService: {},
    websitePhpToolActionService: {
      queue: async () => ({ job: { id: 'job-1', status: 'queued' } }),
    },
  });

  const listener = createAuthenticatedApi({
    store,
    publicOrigin: origin,
    createHandler: () => coreApp,
  });

  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

  const port = server.address().port;
  const queueUrl = `http://127.0.0.1:${port}/api/websites/${WEBSITE_ID}/actions/queue`;
  const validHeaders = {
    origin,
    cookie: '__Host-yunpanel_session=valid-token',
    'x-csrf-token': csrfToken,
    'content-type': 'application/json',
  };

  // 1. Missing CSRF token fails closed with 403
  const noCsrfRes = await fetch(queueUrl, {
    method: 'POST',
    headers: { origin, cookie: '__Host-yunpanel_session=valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'wp.cache.flush' }),
  });
  assert.equal(noCsrfRes.status, 403);
  const noCsrfBody = await noCsrfRes.json();
  assert.equal(noCsrfBody.error.code, 'csrf_invalid');

  // 2. Invalid CSRF token fails closed with 403
  const badCsrfRes = await fetch(queueUrl, {
    method: 'POST',
    headers: { ...validHeaders, 'x-csrf-token': 'wrong-csrf' },
    body: JSON.stringify({ actionId: 'wp.cache.flush' }),
  });
  assert.equal(badCsrfRes.status, 403);
  const badCsrfBody = await badCsrfRes.json();
  assert.equal(badCsrfBody.error.code, 'csrf_invalid');

  // 3. Valid session and CSRF token succeeds with 202
  const successRes = await fetch(queueUrl, {
    method: 'POST',
    headers: validHeaders,
    body: JSON.stringify({ actionId: 'wp.cache.flush' }),
  });
  assert.equal(successRes.status, 202);

  // 4. Revoked session fails closed with 401
  sessionActive = false;
  const revokedRes = await fetch(queueUrl, {
    method: 'POST',
    headers: validHeaders,
    body: JSON.stringify({ actionId: 'wp.cache.flush' }),
  });
  assert.equal(revokedRes.status, 401);
  const revokedBody = await revokedRes.json();
  assert.equal(revokedBody.error.code, 'unauthorized');
});
