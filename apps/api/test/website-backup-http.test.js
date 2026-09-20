import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import {
  WebsiteBackupHttpError,
  isWebsiteBackupHttpError,
  mountWebsiteBackupRoutes,
} from '../src/website-backup-http.js';
import { WebsiteBackupSetError } from '../src/website-backup-set.js';

const ownerAuth = Object.freeze({
  user: { id: 'owner-1', role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function fixture(t) {
  const websiteId = '2c387b02-8747-458a-b509-8f531d4d149e';
  const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

  const mockBackupSet = {
    version: 1,
    website: {
      id: websiteId,
      serverId,
      name: 'TestApp',
      primaryDomain: 'example.com',
      runtimeType: 'node',
      applicationId: '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8',
      unixUser: 'yunapp-84e0ccf313b7',
      revision: 1,
    },
    files: {
      runtimeType: 'node',
      targetPaths: ['/var/lib/yunpanel/apps/84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8/current'],
      exclusions: ['.git'],
    },
    data: {
      persistentDataDirectory: '/var/lib/yunpanel/data/84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8',
      targetPaths: ['/var/lib/yunpanel/data/84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8'],
      exclusions: ['**/tmp/**'],
    },
    env: { savedRevision: 1, appliedRevision: 1, variablesCount: 0, variableKeys: [] },
    databases: [],
    mail: [],
    dns: [],
    nginx: [],
    composeHooks: { enabled: false },
    targetPaths: [
      '/var/lib/yunpanel/apps/84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8/current',
      '/var/lib/yunpanel/data/84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8',
      `/var/lib/yunpanel/backups/resources/website/${websiteId}`,
    ],
    excludePatterns: ['.git', '**/tmp/**'],
    tags: [`website:${websiteId}`, `server:${serverId}`],
    digest: 'a'.repeat(64),
  };

  const mockPreview = {
    websiteId,
    repositoryId: '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c',
    backupSetDigest: 'a'.repeat(64),
    targetPaths: mockBackupSet.targetPaths,
    excludePatterns: mockBackupSet.excludePatterns,
    tags: mockBackupSet.tags,
    databases: [],
    composeHooksEnabled: false,
    confirmation: `backup:${websiteId}:91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c:${'a'.repeat(64)}`,
  };

  const websiteBackupSetProvider = {
    async getWebsiteBackupSet({ websiteId: requestedId, serverId: requestedServerId }) {
      if (requestedId === '00000000-0000-0000-0000-000000000000') {
        throw new WebsiteBackupSetError('website_not_found', 'Website not found', 404);
      }
      if (requestedId === 'invalid-uuid') {
        throw new WebsiteBackupSetError('invalid_website_id', 'websiteId is invalid', 400);
      }
      return mockBackupSet;
    },
  };

  const websiteBackupService = {
    async previewBackup({ websiteId: requestedId, repositoryId }) {
      if (requestedId === '00000000-0000-0000-0000-000000000000') {
        throw new WebsiteBackupSetError('website_not_found', 'Website not found', 404);
      }
      return { ...mockPreview, repositoryId };
    },
    async executeBackup({ websiteId: requestedId, repositoryId, expectedPreviewDigest, confirmation }) {
      if (expectedPreviewDigest === 'stale-digest') {
        throw new WebsiteBackupSetError('backup_preview_stale', 'Stale preview digest', 409);
      }
      return {
        status: 'succeeded',
        websiteId: requestedId,
        repositoryId,
        snapshot: { snapshotId: 'snap-abc123' },
        backupSetDigest: expectedPreviewDigest ?? 'a'.repeat(64),
      };
    },
  };

  let authContext = ownerAuth;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = authContext;
    next();
  });

  mountWebsiteBackupRoutes(app, {
    websiteBackupSetProvider,
    websiteBackupService,
    localServerId: serverId,
  });

  app.use((error, req, res, next) => {
    if (isWebsiteBackupHttpError(error)) {
      return res.status(error.status ?? 400).json({
        error: { code: error.code, message: error.message },
      });
    }
    return res.status(500).json({ error: { code: 'internal_error', message: error.message } });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    websiteId,
    setAuth: (newAuth) => { authContext = newAuth; },
  };
}

test('GET /api/websites/:websiteId/backup-set returns 200 with website backup set', async (t) => {
  const { baseUrl, websiteId } = await fixture(t);

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/backup-set`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.data.version, 1);
  assert.equal(body.data.website.id, websiteId);
  assert.equal(body.data.website.runtimeType, 'node');
  assert.ok(Array.isArray(body.data.targetPaths));
  assert.ok(Array.isArray(body.data.tags));
});

test('GET /api/websites/:websiteId/backup-set returns 404 when website does not exist', async (t) => {
  const { baseUrl } = await fixture(t);

  const res = await fetch(`${baseUrl}/api/websites/00000000-0000-0000-0000-000000000000/backup-set`);
  assert.equal(res.status, 404);

  const body = await res.json();
  assert.equal(body.error.code, 'website_not_found');
});

test('GET /api/websites/:websiteId/backup-set returns 400 when websiteId is invalid', async (t) => {
  const { baseUrl } = await fixture(t);

  const res = await fetch(`${baseUrl}/api/websites/invalid-uuid/backup-set`);
  assert.equal(res.status, 400);

  const body = await res.json();
  assert.equal(body.error.code, 'invalid_website_id');
});

test('GET /api/websites/:websiteId/backup-set returns 401 when unauthorized', async (t) => {
  const { baseUrl, websiteId, setAuth } = await fixture(t);
  setAuth(null);

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/backup-set`);
  assert.equal(res.status, 401);
});

test('POST /api/websites/:websiteId/backup/preview returns 200 with preview', async (t) => {
  const { baseUrl, websiteId } = await fixture(t);

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/backup/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositoryId: '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c' }),
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.data.websiteId, websiteId);
  assert.equal(body.data.repositoryId, '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c');
  assert.ok(body.data.confirmation.startsWith('backup:'));
});

test('POST /api/websites/:websiteId/backup requires owner role', async (t) => {
  const { baseUrl, websiteId, setAuth } = await fixture(t);
  setAuth({
    user: { id: 'viewer-1', role: 'viewer' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repositoryId: '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c',
    }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, 'forbidden');
});

test('POST /api/websites/:websiteId/backup returns 201 on success', async (t) => {
  const { baseUrl, websiteId } = await fixture(t);

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repositoryId: '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c',
      expectedPreviewDigest: 'a'.repeat(64),
      confirmation: `backup:${websiteId}:91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c:${'a'.repeat(64)}`,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.data.status, 'succeeded');
  assert.equal(body.data.snapshot.snapshotId, 'snap-abc123');
});

test('POST /api/websites/:websiteId/backup returns 409 on stale digest', async (t) => {
  const { baseUrl, websiteId } = await fixture(t);

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repositoryId: '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c',
      expectedPreviewDigest: 'stale-digest',
    }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, 'backup_preview_stale');
});
