import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import express from 'express';
import { createPleskImporter } from '../src/plesk-importer.js';
import { mountPleskImporterRoutes, isPleskImporterHttpError } from '../src/plesk-importer-http.js';
import { PleskImporterError } from '../src/plesk-importer.js';

const localServerId = '99bc760a-d508-4ae6-92be-efdedee9658d';

function createMockApp({ pleskImporter, userRole = 'owner' }) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    if (userRole === 'unauthenticated') {
      req.auth = null;
    } else if (userRole === 'owner') {
      req.auth = {
        user: { id: 'usr-owner', username: 'admin', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
    } else if (userRole === 'read_only') {
      req.auth = {
        user: { id: 'usr-ro', username: 'viewer', role: 'read_only' },
        access: { mode: 'read_only', permissions: ['servers.read'] },
        security: { managementAllowed: false },
      };
    }
    next();
  });

  mountPleskImporterRoutes(app, { pleskImporter });

  app.use((err, req, res, next) => {
    if (isPleskImporterHttpError(err) || err instanceof PleskImporterError || (err.status && err.code)) {
      return res.status(err.status ?? 400).json({ error: { code: err.code, message: err.message } });
    }
    return res.status(500).json({ error: { code: 'internal_error', message: err.message } });
  });

  return app;
}

async function withTestServer(app, action) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const traffic = [];
  server.on('request', (request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/importer/plesk/preview') return;
    const sameLocalPort = request.socket.localPort === port;
    response.once('finish', () => {
      traffic.push({ status: response.statusCode, sameLocalPort,
        ownerContext: request.auth?.user?.role === 'owner' && request.auth?.access?.mode === 'management'
          && request.auth?.security?.managementAllowed === true && Array.isArray(request.auth?.access?.permissions) && request.auth.access.permissions.includes('*') });
    });
  });
  try {
    return await action(`http://127.0.0.1:${port}`, server, traffic);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function assertSocketRefused(port) {
  const socket = createConnection({ host: '127.0.0.1', port });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
      socket.once('connect', () => reject(new Error('Test server still accepts connections')));
    });
  } finally {
    socket.destroy();
    await closed;
  }
}

test('importer HTTP server closes before a successful action returns', async () => {
  let closed, port, closeObserved = false;
  try {
    await withTestServer(express(), async (origin, server) => {
      port = server.address().port;
      closed = once(server, 'close');
      server.once('close', () => { closeObserved = true; });
      const response = await fetch(origin);
      await response.arrayBuffer();
      assert.equal(response.status, 404);
    });
    assert.equal(closeObserved, true);
    await assertSocketRefused(port);
  } finally {
    await closed;
  }
});

test('importer HTTP server closes before propagating a failing action', async () => {
  let closed, port, closeObserved = false;
  const failure = new assert.AssertionError({ message: 'Action assertion failed after the real response' });
  try {
    await assert.rejects(withTestServer(express(), async (origin, server) => {
      port = server.address().port;
      closed = once(server, 'close');
      server.once('close', () => { closeObserved = true; });
      const response = await fetch(origin);
      await response.arrayBuffer();
      assert.equal(response.status, 404);
      throw failure;
    }), (error) => error === failure);
    assert.equal(closeObserved, true);
    await assertSocketRefused(port);
  } finally {
    await closed;
  }
});

test('Plesk Importer HTTP API', async (t) => {
  const pleskImporter = createPleskImporter({ localServerId });

  await t.test('POST /api/importer/plesk/preview returns 200 and preview for owner', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'owner' });
    await withTestServer(app, async (origin, _server, traffic) => {
      const response = await fetch(`${origin}/api/importer/plesk/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          websites: [
            {
              name: 'example.com',
              runtime: { runtimeType: 'node', nodeVersion: '24' },
            },
          ],
        }),
      });

      const data = await response.json();
      const errorCode = ['unauthorized', 'forbidden'].includes(data.error?.code) ? data.error.code : null;
      assert.equal(response.status, 200, JSON.stringify({ ownRequestCount: traffic.length, ownListener: traffic, errorCode }));
      assert.equal(traffic.length, 1);
      assert.equal(traffic[0].sameLocalPort, true);
      assert.equal(traffic[0].ownerContext, true);
      assert.equal(traffic[0].status, 200);
      assert.ok(data.preview);
      assert.equal(data.preview.readOnly, true);
      assert.equal(data.preview.serverId, localServerId);
      assert.equal(data.preview.summary.websitesCount, 1);
      assert.equal(data.preview.websites[0].primaryDomain, 'example.com');
    });
  });

  await t.test('POST /api/importer/plesk/preview returns 401 when unauthenticated', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'unauthenticated' });
    await withTestServer(app, async (origin, _server, traffic) => {
      const response = await fetch(`${origin}/api/importer/plesk/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ websites: [{ name: 'example.com' }] }),
      });

      await response.arrayBuffer();
      assert.equal(response.status, 401);
    });
  });

  await t.test('POST /api/importer/plesk/preview returns 403 when user is read_only', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'read_only' });
    await withTestServer(app, async (origin, _server, traffic) => {
      const response = await fetch(`${origin}/api/importer/plesk/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ websites: [{ name: 'example.com' }] }),
      });

      await response.arrayBuffer();
      assert.equal(response.status, 403);
    });
  });

  await t.test('POST /api/importer/plesk/preview rejects forbidden .44 server references with 403', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'owner' });
    await withTestServer(app, async (origin, _server, traffic) => {
      const response = await fetch(`${origin}/api/importer/plesk/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          websites: [
            {
              name: 'example.com',
              target: '157.180.11.44',
            },
          ],
        }),
      });

      assert.equal(response.status, 403);
      const data = await response.json();
      assert.equal(data.error.code, 'plesk_forbidden_target_server');
    });
  });

  await t.test('POST /api/importer/plesk/preview rejects empty websites with 400', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'owner' });
    await withTestServer(app, async (origin, _server, traffic) => {
      const response = await fetch(`${origin}/api/importer/plesk/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          websites: [],
        }),
      });

      assert.equal(response.status, 400);
      const data = await response.json();
      assert.equal(data.error.code, 'plesk_export_no_websites');
    });
  });
});
