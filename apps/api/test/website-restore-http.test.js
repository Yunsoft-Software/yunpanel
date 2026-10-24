import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import {
  WebsiteRestoreHttpError,
  isWebsiteRestoreHttpError,
  mountWebsiteRestoreRoutes,
} from '../src/website-restore-http.js';
import { WebsiteRestoreError } from '../src/website-restore-service.js';
import { createWebsiteBackupOperationService } from '../src/website-backup-operation-service.js';
import { createWebsiteBackupOperationRegistry } from '../src/website-backup-operation-registry.js';
import { createJobRegistry } from '../src/job-registry.js';

const ownerAuth = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  user: { id: '22222222-2222-4222-8222-222222222222', role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

const regularUserAuth = Object.freeze({
  user: { id: 'user-1', role: 'user' },
  access: { mode: 'view', permissions: [] },
  security: { managementAllowed: false },
});

async function fixture(t) {
  const websiteId = '2c387b02-8747-458a-b509-8f531d4d149e';
  const repositoryId = '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c';
  const snapshotId = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
  const previewDigest = 'a'.repeat(64);
  const confirmation = `restore:${websiteId}:${snapshotId}:${previewDigest}`;

  const mockPreview = {
    websiteId,
    repositoryId,
    snapshotId,
    snapshotTime: '2026-09-20T03:00:00.000Z',
    snapshotTags: [`website:${websiteId}`],
    snapshotPaths: ['/var/lib/yunpanel/apps/test/current'],
    healthSpec: { primaryDomain: 'example.com', healthPath: '/health', timeoutSeconds: 30 },
    previewDigest,
    confirmation,
  };

  const websiteRestoreService = {
    async previewRestore({ websiteId: wId, repositoryId: rId, snapshotId: sId }) {
      if (wId === '00000000-0000-4000-8000-000000000000') {
        throw new WebsiteRestoreError('website_not_found', 'Website not found', 404);
      }
      return mockPreview;
    },
    async executeRestore({ websiteId: wId, expectedPreviewDigest, confirmation: conf }) {
      if (expectedPreviewDigest !== previewDigest) {
        throw new WebsiteRestoreError('restore_preview_stale', 'Preview stale', 409);
      }
      return {
        status: 'succeeded',
        websiteId: wId,
        snapshotId,
        preRestoreSnapshotId: 'pre-snap-1',
        healthCheck: { satisfied: true, statusCode: 200, attempts: 1 },
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

  mountWebsiteRestoreRoutes(app, {
    websiteRestoreService,
    websiteBackupOperationService: createWebsiteBackupOperationService({ registry: createWebsiteBackupOperationRegistry(), websiteRestoreService,
      jobRegistry: createJobRegistry(), websiteRegistry: { getWebsite: async id => ({ id, serverId: repositoryId }) },
      resticRepositoryRegistry: { getRepository: async id => ({ id, serverId: repositoryId }) }, authorizeActor: async actor => actor,
      siteMutationLock: { withSiteLock: async (_identity, action) => action() } }),
  });

  app.use((error, req, res, next) => {
    if (isWebsiteRestoreHttpError(error)) {
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
    repositoryId,
    snapshotId,
    previewDigest,
    confirmation,
    setAuth: (newAuth) => { authContext = newAuth; },
  };
}

test('POST /api/websites/:websiteId/restore/preview returns 200 with preview', async (t) => {
  const { baseUrl, websiteId, repositoryId, snapshotId } = await fixture(t);

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/restore/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repositoryId, snapshotId }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.websiteId, websiteId);
  assert.equal(body.data.snapshotId, snapshotId);
  assert.equal(typeof body.data.previewDigest, 'string');
});

test('POST /api/websites/:websiteId/restore returns 202 without executing synchronously', async (t) => {
  const { baseUrl, websiteId, repositoryId, snapshotId, previewDigest, confirmation } = await fixture(t);

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId,
      snapshotId,
      expectedPreviewDigest: previewDigest,
      confirmation,
    }),
  });

  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.data.status, 'queued');
  assert.equal(body.data.websiteId, websiteId);
  assert.ok(body.data.jobId);
});

test('POST /api/websites/:websiteId/restore returns 403 when user is not owner', async (t) => {
  const { baseUrl, websiteId, repositoryId, snapshotId, previewDigest, confirmation, setAuth } = await fixture(t);
  setAuth(regularUserAuth);

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId,
      snapshotId,
      expectedPreviewDigest: previewDigest,
      confirmation,
    }),
  });

  assert.equal(res.status, 403);
});

test('POST /api/websites/:websiteId/restore returns 409 when preview is stale', async (t) => {
  const { baseUrl, websiteId, repositoryId, snapshotId, confirmation } = await fixture(t);

  const res = await fetch(`${baseUrl}/api/websites/${websiteId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId,
      snapshotId,
      expectedPreviewDigest: '0'.repeat(64),
      confirmation,
    }),
  });

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, 'restore_preview_stale');
});
