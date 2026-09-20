import test from 'node:test';
import assert from 'node:assert/strict';
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

test('Plesk Importer HTTP API', async (t) => {
  const pleskImporter = createPleskImporter({ localServerId });

  await t.test('POST /api/importer/plesk/preview returns 200 and preview for owner', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/importer/plesk/preview`, {
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

      assert.equal(response.status, 200);
      const data = await response.json();
      assert.ok(data.preview);
      assert.equal(data.preview.readOnly, true);
      assert.equal(data.preview.serverId, localServerId);
      assert.equal(data.preview.summary.websitesCount, 1);
      assert.equal(data.preview.websites[0].primaryDomain, 'example.com');
    } finally {
      server.close();
    }
  });

  await t.test('POST /api/importer/plesk/preview returns 401 when unauthenticated', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'unauthenticated' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/importer/plesk/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ websites: [{ name: 'example.com' }] }),
      });

      assert.equal(response.status, 401);
    } finally {
      server.close();
    }
  });

  await t.test('POST /api/importer/plesk/preview returns 403 when user is read_only', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'read_only' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/importer/plesk/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ websites: [{ name: 'example.com' }] }),
      });

      assert.equal(response.status, 403);
    } finally {
      server.close();
    }
  });

  await t.test('POST /api/importer/plesk/preview rejects forbidden .44 server references with 403', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/importer/plesk/preview`, {
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
    } finally {
      server.close();
    }
  });

  await t.test('POST /api/importer/plesk/preview rejects empty websites with 400', async () => {
    const app = createMockApp({ pleskImporter, userRole: 'owner' });
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/importer/plesk/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          websites: [],
        }),
      });

      assert.equal(response.status, 400);
      const data = await response.json();
      assert.equal(data.error.code, 'plesk_export_no_websites');
    } finally {
      server.close();
    }
  });
});
