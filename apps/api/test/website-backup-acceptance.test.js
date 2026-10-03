import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import {
  isWebsiteBackupHttpError,
  mountWebsiteBackupRoutes,
} from '../src/website-backup-http.js';
import { createWebsiteBackupBrowser } from '../src/website-backup-browser.js';
import { createWebsiteBackupOperationService } from '../src/website-backup-operation-service.js';
import { createWebsiteBackupOperationRegistry } from '../src/website-backup-operation-registry.js';
import { createSiteResourceBoundary } from '../src/site-resource-boundary.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const siteAId = '11111111-1111-4111-8111-111111111111';
const siteBId = '22222222-2222-4222-8222-222222222222';
const repoId = '33333333-3333-4333-8333-333333333333';
const previewDigest = 'a'.repeat(64);
const backupConfirm = `backup:${siteAId}:${repoId}:${previewDigest}`;
const restoreConfirm = `restore:${siteAId}:${repoId}:snap-a-1:${previewDigest}`;

async function setupAcceptanceServer(t) {
  const websites = new Map([
    [siteAId, { id: siteAId, serverId, name: 'SiteA', runtimeType: 'node', applicationId: 'app-a' }],
    [siteBId, { id: siteBId, serverId, name: 'SiteB', runtimeType: 'php', applicationId: 'app-b' }],
  ]);

  const websiteRegistry = {
    async getWebsite(id) { return websites.get(id) ?? null; },
    async listWebsites() { return Array.from(websites.values()); },
  };

  const domainRegistry = {
    async getDomain() { return null; },
    async listDomains() { return []; },
  };

  const snapshots = [
    { id: 'a'.repeat(64), shortId: 'aaaaaaaa', time: '2026-09-25T10:00:00.000Z', paths: ['/secret/site-a'], tags: [`website:${siteAId}`], hostname: 'host-a', username: 'root' },
    { id: 'b'.repeat(64), shortId: 'bbbbbbbb', time: '2026-09-25T11:00:00.000Z', paths: ['/secret/site-b'], tags: [`website:${siteBId}`], hostname: 'host-b', username: 'root' },
  ];

  const resticRepositoryRegistry = {
    async listRepositories() {
      return [{
        id: repoId,
        serverId,
        name: 'primary-repo',
        backend: 'local',
        target: '/secret/var/backups/restic',
        status: 'ready',
        retentionPolicy: { keepLast: 7 },
        lastCheckedAt: '2026-09-25T00:00:00.000Z',
        lastSnapshotAt: '2026-09-25T11:00:00.000Z',
        error: null,
      }];
    },
    async getRepository(id) {
      if (id === repoId) {
        return { id: repoId, serverId, name: 'primary-repo', target: '/secret/var/backups/restic', backend: 'local', status: 'ready' };
      }
      return null;
    },
    async revealPassword(id) {
      return id === repoId ? 'super-secret-pass' : null;
    },
    async listSnapshots(id, options = {}) {
      assert.equal(id, repoId);
      const reqTags = options.tags ?? [];
      return snapshots.filter((snap) => reqTags.every((t) => snap.tags.includes(t)));
    },
  };

  const websiteBackupSetProvider = {
    async getWebsiteBackupSet({ websiteId: wId }) {
      const site = websites.get(wId);
      if (!site) throw new Error('not found');
      return {
        version: 1,
        website: site,
        digest: previewDigest,
        databases: [],
        mail: [],
        dns: [],
        targetPaths: ['/secret/files'],
        composeHooks: { enabled: false },
      };
    },
  };

  const websiteBackupBrowser = createWebsiteBackupBrowser({
    websiteRegistry,
    resticRepositoryRegistry,
    websiteBackupSetProvider,
    localServerId: serverId,
  });

  const websiteBackupService = {
    async previewBackup({ websiteId: wId, repositoryId: rId }) {
      return {
        websiteId: wId,
        repositoryId: rId,
        backupSetDigest: previewDigest,
        confirmation: `backup:${wId}:${rId}:${previewDigest}`,
        databases: [],
      };
    },
    async executeBackup({ websiteId: wId, repositoryId: rId }) {
      return {
        status: 'succeeded',
        websiteId: wId,
        repositoryId: rId,
        snapshot: { snapshotId: 'snap-new-123' },
        backupSetDigest: previewDigest,
      };
    },
  };

  const websiteRestoreService = {
    async previewRestore({ websiteId: wId, repositoryId: rId, snapshotId: sId }) {
      return {
        websiteId: wId,
        repositoryId: rId,
        snapshotId: sId,
        previewDigest,
        confirmation: `restore:${wId}:${rId}:${sId}:${previewDigest}`,
        healthSpec: { healthPath: '/health', timeoutSeconds: 30 },
      };
    },
    async executeRestore({ websiteId: wId, snapshotId: sId }) {
      return {
        status: 'succeeded',
        websiteId: wId,
        snapshotId: sId,
        preRestoreSnapshotId: 'pre-snap-123',
        healthCheck: { satisfied: true },
      };
    },
  };

  const operationRegistry = createWebsiteBackupOperationRegistry();
  const websiteBackupOperationService = createWebsiteBackupOperationService({
    registry: operationRegistry,
    websiteBackupService,
    websiteRestoreService,
  });

  let currentAuth = null;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });

  // Site resource boundary
  app.use(createSiteResourceBoundary({
    websiteRegistry,
    domainRegistry,
    localServerId: serverId,
  }));

  mountWebsiteBackupRoutes(app, {
    websiteBackupSetProvider,
    websiteBackupService,
    websiteBackupBrowser,
    websiteBackupOperationService,
    websiteRestoreService,
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
    setAuth: (auth) => { currentAuth = auth; },
    operationRegistry,
  };
}

test('BACKUP-UI-04: site-scoped isolation ensures site accounts see only their website snapshots without leaks', async (t) => {
  const { baseUrl, setAuth } = await setupAcceptanceServer(t);

  // Authenticate as Site A manager
  setAuth({
    user: { id: 'user-site-a', role: 'site_manager', websiteIds: [siteAId] },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  // 1. Site A manager accessing Site A backups: 200 OK
  const resA = await fetch(`${baseUrl}/api/websites/${siteAId}/backups`);
  assert.equal(resA.status, 200);
  const bodyA = await resA.json();
  assert.equal(bodyA.data.websiteId, siteAId);
  assert.equal(bodyA.data.repositories.length, 1);
  const repo = bodyA.data.repositories[0];
  assert.equal(repo.name, 'primary-repo');
  assert.equal(repo.snapshots.length, 1);
  assert.equal(repo.snapshots[0].shortId, 'aaaaaaaa');

  // Verify NO confidential data leaked (targets, host paths, credentials, raw error)
  assert.equal(Object.hasOwn(repo, 'target'), false);
  assert.equal(Object.hasOwn(repo, 'error'), false);
  assert.equal(Object.hasOwn(repo.snapshots[0], 'paths'), false);
  assert.equal(Object.hasOwn(repo.snapshots[0], 'hostname'), false);
  assert.equal(Object.hasOwn(repo.snapshots[0], 'username'), false);
  const jsonStr = JSON.stringify(bodyA);
  assert.doesNotMatch(jsonStr, /secret|super-secret-pass|\/secret\/var\/backups/);

  // 2. Site A manager attempting to access Site B backups: 403 Forbidden
  const resB = await fetch(`${baseUrl}/api/websites/${siteBId}/backups`);
  assert.equal(resB.status, 403);
  const bodyB = await resB.json();
  assert.equal(bodyB.error.code, 'site_scope_forbidden');

  // 3. Site A manager attempting global backup endpoints: 403 Forbidden
  const resGlobal = await fetch(`${baseUrl}/api/backups/repositories`);
  assert.equal(resGlobal.status, 403);

  // 4. Site A manager attempting to run backup mutation: 403 Forbidden (requires Owner)
  const resMutate = await fetch(`${baseUrl}/api/websites/${siteAId}/backup-operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'backup', repositoryId: repoId }),
  });
  assert.equal(resMutate.status, 403);
});

test('BACKUP-UI-04: Owner durable backup/restore flow with durable jobs', async (t) => {
  const { baseUrl, setAuth, operationRegistry } = await setupAcceptanceServer(t);

  // Authenticate as Owner
  setAuth({
    user: { id: 'owner-1', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  // 1. Queue durable backup via POST /api/websites/:websiteId/backup/queue
  const queueRes = await fetch(`${baseUrl}/api/websites/${siteAId}/backup/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repositoryId: repoId,
      expectedPreviewDigest: previewDigest,
      confirmation: backupConfirm,
    }),
  });
  assert.equal(queueRes.status, 202);
  const queueData = await queueRes.json();
  assert.equal(queueData.data.kind, 'backup');
  assert.equal(queueData.data.status, 'queued');
  assert.equal(queueData.data.websiteId, siteAId);
  const opId = queueData.data.id;

  // 2. Read operation list: GET /api/websites/:websiteId/backup-operations
  const listRes = await fetch(`${baseUrl}/api/websites/${siteAId}/backup-operations`);
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.ok(listData.data.some((op) => op.id === opId));

  // 3. Read specific operation: GET /api/websites/:websiteId/backup-operations/:operationId
  const getRes = await fetch(`${baseUrl}/api/websites/${siteAId}/backup-operations/${opId}`);
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.data.id, opId);

  // Wait for background execution
  async function waitForOperationTerminal(id, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const op = await operationRegistry.getOperation(id);
      if (op && (op.status === 'succeeded' || op.status === 'failed' || op.status === 'rolled_back')) {
        return op;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return operationRegistry.getOperation(id);
  }

  const finishedOp = await waitForOperationTerminal(opId);
  assert.equal(finishedOp.status, 'succeeded');
  assert.equal(finishedOp.snapshotId, 'snap-new-123');

  // 4. Queue durable restore via POST /api/websites/:websiteId/restore/queue
  const restoreRes = await fetch(`${baseUrl}/api/websites/${siteAId}/restore/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repositoryId: repoId,
      snapshotId: 'snap-a-1',
      expectedPreviewDigest: previewDigest,
      confirmation: restoreConfirm,
    }),
  });
  assert.equal(restoreRes.status, 202);
  const restoreData = await restoreRes.json();
  assert.equal(restoreData.data.kind, 'restore');
  assert.equal(restoreData.data.status, 'queued');
  const restoreOpId = restoreData.data.id;

  const finishedRestore = await waitForOperationTerminal(restoreOpId);
  assert.equal(finishedRestore.status, 'succeeded');
  assert.equal(finishedRestore.preRestoreSnapshotId, 'pre-snap-123');
});
