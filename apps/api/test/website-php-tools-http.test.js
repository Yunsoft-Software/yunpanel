import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountWebsitePhpToolsRoutes } from '../src/website-php-tools-http.js';

const WEBSITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function createTestApp({
  websitePhpToolsService = {},
  userRole = 'owner',
} = {}) {
  const app = express();
  app.use(express.json());

  const requirePanelRouteAccess = ({ minRole } = {}) => (req, res, next) => {
    if (!userRole) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } });
    }
    if (minRole === 'operator' && userRole === 'readonly') {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Operator role required' } });
    }
    next();
  };

  mountWebsitePhpToolsRoutes(app, {
    websitePhpToolsService,
    requirePanelRouteAccess,
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

test('requires operator role', async () => {
  const app = createTestApp({
    websitePhpToolsService: {},
    userRole: 'readonly',
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
