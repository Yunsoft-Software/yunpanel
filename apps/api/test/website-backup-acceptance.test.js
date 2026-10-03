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
import {
  createDisasterRecoveryScope,
  normalizeDisasterRecoveryScope,
  maskDisasterRecoverySecrets,
  DISASTER_RECOVERY_CATEGORIES,
} from '../src/backup-manifest.js';
import {
  verifyDisasterRecoveryRestore,
  BackupPlanError,
} from '../src/backup-plan.js';
import {
  sanitizeDisasterRecoveryRestoreResult,
  DatabaseRestoreJobResultError,
} from '../src/database-restore-job-result.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const siteAId = '11111111-1111-4111-8111-111111111111';
const siteBId = '22222222-2222-4222-8222-222222222222';
const repoId = '33333333-3333-4333-8333-333333333333';
const previewDigest = 'a'.repeat(64);
const backupConfirm = `backup:${siteAId}:${repoId}:${previewDigest}`;
const restoreConfirm = `restore:${siteAId}:${repoId}:snap-a-1:${previewDigest}`;

async function setupAcceptanceServer(t, { customSnapshots = null } = {}) {
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

  const snapshots = customSnapshots ?? [
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
    async checkResticRepository(id) {
      assert.equal(id, repoId);
      return { ok: true, checkedAt: new Date().toISOString() };
    },
    async updateRetentionPolicy(id, policy) {
      assert.equal(id, repoId);
      return { ok: true, retentionPolicy: policy };
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

  const operationRegistry = createWebsiteBackupOperationRegistry();

  const websiteBackupBrowser = createWebsiteBackupBrowser({
    websiteRegistry,
    resticRepositoryRegistry,
    websiteBackupSetProvider,
    operationRegistry,
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
    async previewRestore({ websiteId: wId, repositoryId: rId, snapshotId: sId, include = [] }) {
      return {
        websiteId: wId,
        repositoryId: rId,
        snapshotId: sId,
        previewDigest,
        confirmation: `restore:${wId}:${rId}:${sId}:${previewDigest}`,
        healthSpec: { healthPath: '/health', timeoutSeconds: 30 },
        include,
        selective: Array.isArray(include) && include.length > 0,
      };
    },
    async executeRestore({ websiteId: wId, snapshotId: sId, include = [] }) {
      return {
        status: 'succeeded',
        websiteId: wId,
        snapshotId: sId,
        preRestoreSnapshotId: 'pre-snap-123',
        healthCheck: { satisfied: true },
        include,
        selective: Array.isArray(include) && include.length > 0,
      };
    },
  };

  const websiteBackupOperationService = createWebsiteBackupOperationService({
    registry: operationRegistry,
    websiteBackupService,
    websiteRestoreService,
    resticRepositoryRegistry,
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

test('PROD-08 Acceptance: Disaster recovery scope covers all 6 domains and masks sensitive secrets', () => {
  const rawScope = {
    scopeId: 'dr-scope-siteA',
    serverId,
    websiteId: siteAId,
    siteFiles: [
      {
        path: '/var/lib/yunpanel/websites/SiteA/public_html',
        fileCount: 150,
        totalBytes: 5242880,
        contentSha256: 'a'.repeat(64),
        permissions: '0755',
        owner: 'site-a',
      },
    ],
    databases: [
      {
        databaseName: 'site_a_prod',
        engine: 'mariadb',
        sizeBytes: 10485760,
        dumpSha256: 'b'.repeat(64),
      },
    ],
    mail: [
      {
        mailDomainId: 'mail-domain-1',
        domainName: 'example.com',
        storageBytes: 2097152,
        snapshotSha256: 'c'.repeat(64),
        accountCount: 3,
      },
    ],
    configuration: [
      {
        kind: 'nginx',
        path: '/etc/nginx/sites-available/example.com.conf',
        checksum: 'd'.repeat(64),
        content: 'server { listen 80; server_name example.com; }',
      },
    ],
    panelRelationships: [
      {
        resourceType: 'user_grant',
        resourceId: 'site-manager-grant-1',
        details: { userId: 'user-site-a', role: 'site_manager', websiteId: siteAId },
      },
    ],
    encryptionKeys: [
      {
        keyId: 'ssl-key-site-a',
        kind: 'tls_private_key',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----',
        keyPassword: 'very-secret-password-123',
        fingerprint: 'e'.repeat(64),
      },
    ],
    acceptableRpoSeconds: 1800,
    targetRtoSeconds: 3600,
  };

  const scope = createDisasterRecoveryScope(rawScope);

  // 1. All 6 categories must be present
  assert.deepEqual(scope.categories, [
    'site_files',
    'database',
    'mail',
    'configuration',
    'panel_relationships',
    'encryption_keys',
  ]);
  assert.equal(scope.siteFiles.length, 1);
  assert.equal(scope.databases.length, 1);
  assert.equal(scope.mail.length, 1);
  assert.equal(scope.configuration.length, 1);
  assert.equal(scope.panelRelationships.length, 1);
  assert.equal(scope.encryptionKeys.length, 1);

  // 2. Secret masking verification
  const masked = maskDisasterRecoverySecrets(scope);
  const jsonStr = JSON.stringify(masked);
  assert.doesNotMatch(jsonStr, /-----BEGIN RSA PRIVATE KEY-----/);
  assert.doesNotMatch(jsonStr, /very-secret-password-123/);
  assert.match(jsonStr, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(jsonStr, /\[REDACTED\]/);
  assert.equal(masked.encryptionKeys[0].privateKey, '[REDACTED_PRIVATE_KEY]');
  assert.equal(masked.encryptionKeys[0].keyPassword, '[REDACTED]');
});

test('PROD-08 Acceptance: Disaster recovery verified restore to empty authorized target with operational, integrity, RPO, and RTO validation', () => {
  const disasterTime = '2026-10-03T08:00:00.000Z';
  const snapshotTime = '2026-10-03T07:45:00.000Z'; // 15 mins = 900s RPO
  const recoveryStart = '2026-10-03T08:05:00.000Z';
  const recoveryEnd = '2026-10-03T08:25:00.000Z'; // 20 mins = 1200s RTO

  const restoreTarget = '/var/lib/yunpanel/websites/SiteA-Restored';

  const verification = verifyDisasterRecoveryRestore({
    restoreTarget,
    allowedTargetRoots: ['/var/lib/yunpanel/websites'],
    targetWasEmpty: true,
    operationalVerification: {
      siteRunning: true,
      httpStatus: 200,
      healthEndpoint: '/health',
      servicesActive: ['nginx', 'php8.3-fpm'],
    },
    integrityVerification: {
      filesVerified: true,
      databaseChecksumMatched: true,
      recordsValidated: true,
    },
    disasterTimestamp: disasterTime,
    snapshotTimestamp: snapshotTime,
    recoveryStartedAt: recoveryStart,
    recoveryCompletedAt: recoveryEnd,
    acceptableRpoSeconds: 1800, // 30 min tolerance
    targetRtoSeconds: 3600,     // 60 min target
  });

  assert.equal(verification.verified, true);
  assert.equal(verification.targetWasEmpty, true);
  assert.equal(verification.targetAuthorized, true);
  assert.equal(verification.operationalVerified, true);
  assert.equal(verification.integrityVerified, true);
  assert.equal(verification.metrics.rpoSeconds, 900);
  assert.equal(verification.metrics.rpoAccepted, true);
  assert.equal(verification.metrics.rtoSeconds, 1200);
  assert.equal(verification.metrics.rtoAccepted, true);

  // Also test sanitizeDisasterRecoveryRestoreResult with job
  const job = { id: 'dr-job-1', resourceId: siteAId };
  const sanitized = sanitizeDisasterRecoveryRestoreResult(job, {
    recoveryId: 'dr-job-1',
    websiteId: siteAId,
    targetPath: restoreTarget,
    targetWasEmpty: true,
    targetAuthorized: true,
    operationalVerified: true,
    integrityVerified: true,
    restoredCategories: [
      'site_files',
      'database',
      'mail',
      'configuration',
      'panel_relationships',
      'encryption_keys',
    ],
    metrics: {
      rpoSeconds: 900,
      acceptableRpoSeconds: 1800,
      rtoSeconds: 1200,
      targetRtoSeconds: 3600,
    },
    verified: true,
  });

  assert.equal(sanitized.verified, true);
  assert.equal(sanitized.restored, true);
  assert.equal(sanitized.secretsMasked, true);
  assert.equal(sanitized.metrics.dataLossAccepted, true);
  assert.equal(sanitized.metrics.recoveryTargetMet, true);
});

test('PROD-08 Acceptance: Disaster recovery rejects non-empty target or unauthorized target path', () => {
  // 1. Non-empty target
  assert.throws(
    () => verifyDisasterRecoveryRestore({
      restoreTarget: '/var/lib/yunpanel/websites/existing-site',
      targetWasEmpty: false,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
      disasterTimestamp: '2026-10-03T08:00:00.000Z',
      snapshotTimestamp: '2026-10-03T07:50:00.000Z',
      recoveryStartedAt: '2026-10-03T08:01:00.000Z',
      recoveryCompletedAt: '2026-10-03T08:10:00.000Z',
    }),
    (err) => err instanceof BackupPlanError && err.code === 'target_not_empty',
  );

  // 2. Unauthorized target path
  assert.throws(
    () => verifyDisasterRecoveryRestore({
      restoreTarget: '/etc/shadow',
      allowedTargetRoots: ['/var/lib/yunpanel/websites'],
      targetWasEmpty: true,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
      disasterTimestamp: '2026-10-03T08:00:00.000Z',
      snapshotTimestamp: '2026-10-03T07:50:00.000Z',
      recoveryStartedAt: '2026-10-03T08:01:00.000Z',
      recoveryCompletedAt: '2026-10-03T08:10:00.000Z',
    }),
    (err) => err instanceof BackupPlanError && err.code === 'target_unauthorized',
  );
});

test('PROD-08 Acceptance: Snapshot listing or backup file creation alone is rejected as insufficient evidence', () => {
  // 1. In verifyDisasterRecoveryRestore with snapshotListOnly
  assert.throws(
    () => verifyDisasterRecoveryRestore({
      restoreTarget: '/var/lib/yunpanel/websites/SiteA',
      targetWasEmpty: true,
      snapshotListOnly: true,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
      disasterTimestamp: '2026-10-03T08:00:00.000Z',
      snapshotTimestamp: '2026-10-03T07:50:00.000Z',
      recoveryStartedAt: '2026-10-03T08:01:00.000Z',
      recoveryCompletedAt: '2026-10-03T08:10:00.000Z',
    }),
    (err) => err instanceof BackupPlanError && err.code === 'disaster_recovery_insufficient_evidence',
  );

  // 2. In verifyDisasterRecoveryRestore with backupFileOnly
  assert.throws(
    () => verifyDisasterRecoveryRestore({
      restoreTarget: '/var/lib/yunpanel/websites/SiteA',
      targetWasEmpty: true,
      backupFileOnly: true,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
      disasterTimestamp: '2026-10-03T08:00:00.000Z',
      snapshotTimestamp: '2026-10-03T07:50:00.000Z',
      recoveryStartedAt: '2026-10-03T08:01:00.000Z',
      recoveryCompletedAt: '2026-10-03T08:10:00.000Z',
    }),
    (err) => err instanceof BackupPlanError && err.code === 'disaster_recovery_insufficient_evidence',
  );

  // 3. In sanitizeDisasterRecoveryRestoreResult
  assert.throws(
    () => sanitizeDisasterRecoveryRestoreResult({ id: 'job-1' }, {
      snapshotListOnly: true,
      targetWasEmpty: true,
      targetAuthorized: true,
      operationalVerified: true,
      integrityVerified: true,
      restoredCategories: ['site_files', 'database', 'mail', 'configuration', 'panel_relationships', 'encryption_keys'],
      metrics: { rpoSeconds: 100, acceptableRpoSeconds: 300, rtoSeconds: 200, targetRtoSeconds: 600 },
      verified: true,
    }),
    (err) => err instanceof DatabaseRestoreJobResultError && err.code === 'disaster_recovery_insufficient_evidence',
  );
});

test('PROD-08 Acceptance: RPO data loss and RTO duration bounds enforcement', () => {
  // Exceeded RPO (data loss too large)
  assert.throws(
    () => verifyDisasterRecoveryRestore({
      restoreTarget: '/var/lib/yunpanel/websites/SiteA',
      targetWasEmpty: true,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
      disasterTimestamp: '2026-10-03T12:00:00.000Z',
      snapshotTimestamp: '2026-10-03T00:00:00.000Z', // 12h = 43200s
      recoveryStartedAt: '2026-10-03T12:01:00.000Z',
      recoveryCompletedAt: '2026-10-03T12:10:00.000Z',
      acceptableRpoSeconds: 3600, // 1h max
      targetRtoSeconds: 7200,
    }),
    (err) => err instanceof BackupPlanError && err.code === 'disaster_recovery_rpo_exceeded',
  );

  // Exceeded RTO (recovery took too long)
  assert.throws(
    () => verifyDisasterRecoveryRestore({
      restoreTarget: '/var/lib/yunpanel/websites/SiteA',
      targetWasEmpty: true,
      operationalVerification: { siteRunning: true, httpStatus: 200 },
      integrityVerification: { filesVerified: true },
      disasterTimestamp: '2026-10-03T12:00:00.000Z',
      snapshotTimestamp: '2026-10-03T11:55:00.000Z',
      recoveryStartedAt: '2026-10-03T12:00:00.000Z',
      recoveryCompletedAt: '2026-10-03T16:00:00.000Z', // 4h = 14400s
      acceptableRpoSeconds: 3600,
      targetRtoSeconds: 3600, // 1h target
    }),
    (err) => err instanceof BackupPlanError && err.code === 'disaster_recovery_rto_exceeded',
  );
});

test('PROD-08 Acceptance: Plaintext private key leak in restore result is rejected', () => {
  assert.throws(
    () => sanitizeDisasterRecoveryRestoreResult({ id: 'job-1' }, {
      targetWasEmpty: true,
      targetAuthorized: true,
      operationalVerified: true,
      integrityVerified: true,
      restoredCategories: ['site_files', 'database', 'mail', 'configuration', 'panel_relationships', 'encryption_keys'],
      metrics: { rpoSeconds: 100, acceptableRpoSeconds: 300, rtoSeconds: 200, targetRtoSeconds: 600 },
      verified: true,
      scope: {
        rawPrivateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
      },
    }),
    (err) => err instanceof DatabaseRestoreJobResultError && err.code === 'disaster_recovery_secret_leak',
  );
});

test('PROD-13 Acceptance: Backup Manager browser projects 6 key fields and enforces tenant isolation', async (t) => {
  const { baseUrl, setAuth, operationRegistry } = await setupAcceptanceServer(t);

  // Record a completed restore operation in the durable operation registry
  const restoreOp = await operationRegistry.createOperation({
    websiteId: siteAId,
    serverId,
    repositoryId: repoId,
    kind: 'restore',
    snapshotId: 'aaaaaaaa',
    previewDigest,
    confirmation: restoreConfirm,
    selective: true,
    include: ['databases', 'paths'],
  });
  await operationRegistry.updateOperation(restoreOp.id, {
    status: 'succeeded',
    finishedAt: '2026-09-25T10:05:00.000Z',
    result: { preRestoreSnapshotId: 'pre-snap-123', selective: true, include: ['databases', 'paths'] },
  });

  setAuth({
    user: { id: 'user-site-a', role: 'site_manager', websiteIds: [siteAId] },
    access: { mode: 'site_management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  const res = await fetch(`${baseUrl}/api/websites/${siteAId}/backups`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const data = body.data;

  // 1. lastSuccessfulBackupAt
  assert.ok(data.lastSuccessfulBackupAt !== undefined);
  assert.equal(typeof data.lastSuccessfulBackupAt, 'string');
  assert.equal(data.lastSuccessfulBackupAt, '2026-09-25T10:00:00.000Z');

  // 2. nextScheduledRunAt
  assert.ok(data.nextScheduledRunAt !== undefined);

  // 3. scopeSummary
  assert.ok(data.scopeSummary);
  assert.equal(typeof data.scopeSummary.paths, 'number');
  assert.equal(typeof data.scopeSummary.databases, 'number');
  assert.equal(typeof data.scopeSummary.mailboxes, 'number');
  assert.equal(typeof data.scopeSummary.dnsZones, 'number');

  // 4. retentionPolicy
  assert.ok(data.retentionPolicy);
  assert.equal(data.retentionPolicy.keepLast, 7);

  // 5. remoteRepositoryStatus
  assert.ok(data.remoteRepositoryStatus);
  assert.equal(typeof (data.remoteRepositoryStatus.status ?? data.remoteRepositoryStatus), 'string');

  // 6. restoreOutcome
  assert.ok(data.restoreOutcome);
  assert.equal(data.restoreOutcome.status, 'succeeded');
  assert.equal(data.restoreOutcome.selective, true);
  assert.equal(data.restoreOutcome.operationId, restoreOp.id);
  assert.ok(data.restoreOutcome.finishedAt);

  // Isolation check: no secret target, password or host leaks
  const rawString = JSON.stringify(body);
  assert.doesNotMatch(rawString, /super-secret-pass/);
  assert.doesNotMatch(rawString, /\/secret\/var\/backups/);
  assert.doesNotMatch(rawString, /\/secret\/site-a/);
});

test('PROD-13 Acceptance: Failed and stale snapshots are distinctly marked and never presented as succeeded', async (t) => {
  const customSnapshots = [
    { id: '1'.repeat(64), shortId: '11111111', time: '2026-09-25T10:00:00.000Z', paths: ['/secret/site-a'], tags: [`website:${siteAId}`], hostname: 'host-a', username: 'root' },
    { id: '2'.repeat(64), shortId: '22222222', time: '2026-09-24T10:00:00.000Z', paths: ['/secret/site-a'], tags: [`website:${siteAId}`, 'failed'], hostname: 'host-a', username: 'root' },
    { id: '3'.repeat(64), shortId: '33333333', time: '2026-09-23T10:00:00.000Z', paths: ['/secret/site-a'], tags: [`website:${siteAId}`, 'stale'], hostname: 'host-a', username: 'root' },
  ];

  const { baseUrl, setAuth } = await setupAcceptanceServer(t, { customSnapshots });
  setAuth({
    user: { id: 'owner-1', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  const res = await fetch(`${baseUrl}/api/websites/${siteAId}/backups`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const repo = body.data.repositories[0];
  assert.equal(repo.snapshots.length, 3);

  const succeededSnap = repo.snapshots.find((s) => s.shortId === '11111111');
  const failedSnap = repo.snapshots.find((s) => s.shortId === '22222222');
  const staleSnap = repo.snapshots.find((s) => s.shortId === '33333333');

  assert.equal(succeededSnap.status, 'succeeded');
  assert.equal(failedSnap.status, 'failed');
  assert.equal(staleSnap.status, 'stale');

  // Strict check: failed and stale snapshots must NOT be marked as succeeded
  assert.notEqual(failedSnap.status, 'succeeded');
  assert.notEqual(staleSnap.status, 'succeeded');
});

test('PROD-13 Acceptance: Selective restore preview and execution operate through durable job engine with include paths', async (t) => {
  const { baseUrl, setAuth, operationRegistry } = await setupAcceptanceServer(t);
  setAuth({
    user: { id: 'owner-1', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  // 1. Preview selective restore
  const previewRes = await fetch(`${baseUrl}/api/websites/${siteAId}/restore/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repositoryId: repoId,
      snapshotId: 'aaaaaaaa',
      include: ['paths', 'databases'],
    }),
  });
  assert.equal(previewRes.status, 200);
  const previewBody = await previewRes.json();
  assert.equal(previewBody.data.selective, true);
  assert.deepEqual(previewBody.data.include, ['paths', 'databases']);

  // 2. Queue selective restore
  const queueRes = await fetch(`${baseUrl}/api/websites/${siteAId}/backup-operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'restore',
      repositoryId: repoId,
      snapshotId: 'aaaaaaaa',
      expectedPreviewDigest: previewDigest,
      confirmation: previewBody.data.confirmation,
      include: ['paths', 'databases'],
    }),
  });
  assert.equal(queueRes.status, 202);
  const queueBody = await queueRes.json();
  assert.equal(queueBody.data.kind, 'restore');
  assert.equal(queueBody.data.selective, true);
  assert.deepEqual(queueBody.data.include, ['paths', 'databases']);

  // 3. Verify operation persisted in registry
  const opRecord = await operationRegistry.getOperation(queueBody.data.id);
  assert.equal(opRecord.selective, true);
  assert.deepEqual(opRecord.include, ['paths', 'databases']);
});

test('PROD-13 Acceptance: Repository health check operates through durable job engine', async (t) => {
  const { baseUrl, setAuth } = await setupAcceptanceServer(t);
  setAuth({
    user: { id: 'owner-1', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  const res = await fetch(`${baseUrl}/api/websites/${siteAId}/backup-operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'check',
      repositoryId: repoId,
    }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.data.kind, 'check');
  assert.equal(body.data.repositoryId, repoId);

  // Poll for completion
  const opId = body.data.id;
  let status = body.data.status;
  for (let i = 0; i < 20; i++) {
    const pollRes = await fetch(`${baseUrl}/api/websites/${siteAId}/backup-operations/${opId}`);
    const pollBody = await pollRes.json();
    status = pollBody.data.status;
    if (['succeeded', 'failed'].includes(status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(status, 'succeeded');
});

test('PROD-13 Acceptance: Backup schedule and retention plan operates through durable job engine', async (t) => {
  const { baseUrl, setAuth } = await setupAcceptanceServer(t);
  setAuth({
    user: { id: 'owner-1', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  });

  const res = await fetch(`${baseUrl}/api/websites/${siteAId}/backup-operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'plan',
      repositoryId: repoId,
      schedule: '0 3 * * *',
      retentionPolicy: { keepLast: 14, keepDaily: 7 },
    }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.data.kind, 'plan');

  // Verify operation completes
  const opId = body.data.id;
  let opData = body.data;
  for (let i = 0; i < 20; i++) {
    const pollRes = await fetch(`${baseUrl}/api/websites/${siteAId}/backup-operations/${opId}`);
    const pollBody = await pollRes.json();
    opData = pollBody.data;
    if (['succeeded', 'failed'].includes(opData.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(opData.status, 'succeeded');
});
