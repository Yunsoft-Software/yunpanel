import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobRegistry } from '../src/job-registry.js';
import { OPERATIONS } from '@yunpanel/protocol';
import { websiteRestoreTransactionId } from '../src/website-restore-service.js';
import {
  createWebsiteBackupOperationRegistry,
  WebsiteBackupOperationRegistryError,
  websiteBackupOperationPublicView,
} from '../src/website-backup-operation-registry.js';
import {
  createWebsiteBackupOperationService,
  WebsiteBackupOperationServiceError,
} from '../src/website-backup-operation-service.js';

const websiteId = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const repositoryId = '33333333-3333-4333-8333-333333333333';
const actor = { sessionId: '44444444-4444-4444-8444-444444444444', userId: '55555555-5555-4555-8555-555555555555', role: 'owner' };
const previewDigest = 'a'.repeat(64);
const confirmation = `backup:${websiteId}:${repositoryId}:${previewDigest}`;

function createFixture({
  backupSucceeds = true,
  restoreResult = { status: 'succeeded', snapshotId: 'snap-1', preRestoreSnapshotId: 'pre-snap-1', healthCheck: { satisfied: true } },
} = {}) {
  const registry = { ...createWebsiteBackupOperationRegistry() };
  const calls = {
    previewBackup: [],
    executeBackup: [],
    previewRestore: [],
    executeRestore: [],
  };

  const websiteBackupService = {
    async previewBackup(args) {
      calls.previewBackup.push(args);
      return {
        websiteId,
        repositoryId,
        backupSetDigest: previewDigest,
        confirmation,
        databases: ['db1'],
      };
    },
    async executeBackup(args) {
      calls.executeBackup.push(args);
      if (!backupSucceeds) {
        throw new Error('Restic backup execution failed');
      }
      return {
        status: 'succeeded',
        websiteId,
        repositoryId,
        snapshot: { snapshotId: 'snap-backup-123' },
        backupSetDigest: previewDigest,
      };
    },
  };

  const restoreConfirmation = `restore:${websiteId}:${repositoryId}:snap-1:${previewDigest}`;
  const websiteRestoreService = {
    async previewRestore(args) {
      calls.previewRestore.push(args);
      return {
        websiteId,
        repositoryId,
        snapshotId: args.snapshotId ?? 'snap-1',
        previewDigest,
        confirmation: restoreConfirmation,
        healthSpec: { healthPath: '/health', timeoutSeconds: 30 },
      };
    },
    async executeRestore(args) {
      calls.executeRestore.push(args);
      return restoreResult;
    },
  };

  const jobRegistry = createJobRegistry();
  const service = createWebsiteBackupOperationService({
    registry,
    websiteBackupService,
    websiteRestoreService, jobRegistry,
    websiteRegistry: { async getWebsite() { return { id: websiteId, serverId, revision: 1, applicationId: null }; } },
    resticRepositoryRegistry: { async getRepository() { return { id: repositoryId, serverId }; } },
    authorizeActor: async input => input, siteMutationLock: { withSiteLock: async (_identity, action) => action() },
  });

  registry.executeQueued = async () => {
    const { job } = await jobRegistry.claimNext(serverId);
    assert.equal(job.operation, OPERATIONS.WEBSITE_BACKUP_ACTION);
    try {
      const result = await service.execute(job.payload, { serverId, jobId: job.id, resourceType: job.resourceType, resourceId: job.resourceId });
      await jobRegistry.complete({ serverId, jobId: job.id, status: 'succeeded', result });
    } catch (error) { await jobRegistry.complete({ serverId, jobId: job.id, status: 'failed', error: { code: error.code ?? 'backup_execution_failed', message: 'Execution failed' } }); }
  };
  return { registry, service, calls, restoreConfirmation, jobRegistry };
}

async function waitForOperationTerminal(registry, id, timeoutMs = 3000) {
  await registry.executeQueued();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const op = await registry.getOperation(id);
    if (op && (op.status === 'succeeded' || op.status === 'failed' || op.status === 'rolled_back')) {
      return op;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return registry.getOperation(id);
}

test('createWebsiteBackupOperationRegistry validates inputs and serializes operations per website', async () => {
  const registry = createWebsiteBackupOperationRegistry();

  await assert.rejects(
    () => registry.createOperation({ websiteId: 'invalid', repositoryId, kind: 'backup', previewDigest, confirmation }),
    (err) => err instanceof WebsiteBackupOperationRegistryError && err.code === 'invalid_website_id',
  );

  await assert.rejects(
    () => registry.createOperation({ websiteId, repositoryId: 'invalid', kind: 'backup', previewDigest, confirmation }),
    (err) => err instanceof WebsiteBackupOperationRegistryError && err.code === 'invalid_repository_id',
  );

  await assert.rejects(
    () => registry.createOperation({ websiteId, repositoryId, kind: 'invalid_kind', previewDigest, confirmation }),
    (err) => err instanceof WebsiteBackupOperationRegistryError && err.code === 'invalid_operation_kind',
  );

  const op = await registry.createOperation({ websiteId, repositoryId, kind: 'backup', previewDigest, confirmation });
  assert.equal(op.websiteId, websiteId);
  assert.equal(op.status, 'queued');
  assert.equal(op.kind, 'backup');
  assert.equal(op.steps.length, 3);

  // Active operation prevents concurrent operation on same website
  await assert.rejects(
    () => registry.createOperation({ websiteId, repositoryId, kind: 'backup', previewDigest, confirmation }),
    (err) => err instanceof WebsiteBackupOperationRegistryError && err.code === 'website_backup_operation_conflict' && err.status === 409,
  );

  // Once terminal, a new operation can be created
  await registry.updateOperation(op.id, { status: 'succeeded' });
  const op2 = await registry.createOperation({ websiteId, repositoryId, kind: 'restore', previewDigest, confirmation: 'restore-confirm' });
  assert.equal(op2.kind, 'restore');
  assert.equal(op2.status, 'queued');
});

test('queueBackup validates digest and confirmation, enqueues operation and advances steps to success', async () => {
  const { service, registry } = createFixture();

  await assert.rejects(
    () => service.queueBackup({ actor, websiteId, repositoryId, expectedPreviewDigest: 'wrong-digest', confirmation }),
    (err) => err instanceof WebsiteBackupOperationServiceError && err.code === 'backup_preview_stale' && err.status === 409,
  );

  await assert.rejects(
    () => service.queueBackup({ actor, websiteId, repositoryId, expectedPreviewDigest: previewDigest, confirmation: 'wrong-confirm' }),
    (err) => err instanceof WebsiteBackupOperationServiceError && err.code === 'backup_confirmation_invalid' && err.status === 409,
  );

  const op = await service.queueBackup({ actor, websiteId, repositoryId, expectedPreviewDigest: previewDigest, confirmation });
  assert.equal(op.kind, 'backup');
  assert.equal(op.status, 'queued');

  // Wait for background execution to complete
  const completed = await waitForOperationTerminal(registry, op.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.snapshotId, 'snap-backup-123');
  assert.equal(completed.result?.status, 'succeeded');
  assert.ok(completed.finishedAt);
  assert.deepEqual(completed.steps.map((s) => s.status), ['succeeded', 'succeeded', 'succeeded']);
});

test('queueBackup records failure in operation when executeBackup throws', async () => {
  const { service, registry } = createFixture({ backupSucceeds: false });

  const op = await service.queueBackup({ actor, websiteId, repositoryId, expectedPreviewDigest: previewDigest, confirmation });
  const failed = await waitForOperationTerminal(registry, op.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.message, 'İşlem tamamlanamadı; kayıtlı hata ve geri alma durumunu kontrol edin');
  assert.ok(failed.finishedAt);
});

test('queueRestore executes pre-restore snapshot, health check and records success', async () => {
  const { service, registry, restoreConfirmation } = createFixture();

  const op = await service.queueRestore({
    actor,
    websiteId,
    repositoryId,
    snapshotId: 'snap-1',
    expectedPreviewDigest: previewDigest,
    confirmation: restoreConfirmation,
  });
  assert.equal(op.kind, 'restore');
  assert.equal(op.status, 'queued');

  const completed = await waitForOperationTerminal(registry, op.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.preRestoreSnapshotId, 'pre-snap-1');
  assert.equal(completed.result?.healthCheck?.satisfied, true);
  assert.deepEqual(completed.steps.map((s) => s.status), ['succeeded', 'succeeded', 'succeeded']);
});

test('queueRestore handles automatic health rollback when health check fails', async () => {
  const { service, registry, restoreConfirmation } = createFixture({
    restoreResult: {
      status: 'rolled_back',
      snapshotId: 'snap-1',
      preRestoreSnapshotId: 'pre-snap-1',
      rollbackReason: 'health_check_failed',
      healthCheck: { satisfied: false, statusCode: 500 },
    },
  });

  const op = await service.queueRestore({
    actor,
    websiteId,
    repositoryId,
    snapshotId: 'snap-1',
    expectedPreviewDigest: previewDigest,
    confirmation: restoreConfirmation,
  });

  const rolledBack = await waitForOperationTerminal(registry, op.id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.result?.rollbackReason, 'health_check_failed');
  assert.equal(rolledBack.result?.preRestoreSnapshotId, 'pre-snap-1');
  assert.equal(rolledBack.steps.find((s) => s.name === 'health_check')?.status, 'rolled_back');
});

test('reconcileInterruptedOperations recovers crash-interrupted restore operations from receipts', async () => {
  const registry = createWebsiteBackupOperationRegistry();
  const op = await registry.createOperation({
    websiteId, serverId,
    repositoryId,
    kind: 'restore',
    snapshotId: 'snap-1',
    previewDigest,
    confirmation: 'restore-confirm',
  });
  await registry.updateOperation(op.id, { status: 'running' });

  // Receipt shows pre_restore_created (process crashed mid-restore)
  const transactionId = websiteRestoreTransactionId({ websiteId, previewDigest, operationId: op.id });
  const receipts = new Map([
    [transactionId, {
      status: 'pre_restore_created',
      websiteId,
      snapshotId: 'snap-1', repositoryId, previewDigest, rollbackPaths: ['/var/lib/yunpanel/data/site-one'],
      preRestoreSnapshotId: 'pre-snap-recovery-1',
    }],
  ]);

  const resticCalls = [];
  const resticManager = {
    async listSnapshots() { return [{ id: 'pre-snap-recovery-1', tags: [`website:${websiteId}`, 'pre-restore', `tx:${transactionId}`] }]; },
    async restore(args) {
      resticCalls.push(args);
    },
  };
  const resticRepositoryRegistry = {
    async getRepository(id) {
      return { id, serverId, target: '/var/backups/repo' };
    },
    async revealPassword(id) {
      return 'secret-pass';
    },
  };
  const receiptStore = {
    async read(key) { return receipts.get(key) ?? null; },
    async write(record) { receipts.set(record.transactionId ?? transactionId, record); },
  };

  const reconciled = await registry.reconcileInterruptedOperations({
    resticManager,
    resticRepositoryRegistry,
    receiptStore,
    websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId }) },
    websiteBackupSetProvider: { getWebsiteBackupSet: async () => ({ targetPaths: ['/var/lib/yunpanel/data/site-one'] }) },
    siteMutationLock: { withSiteLock: async (_identity, action) => action() },
  });

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'rolled_back');
  assert.equal(reconciled[0].restartEvidence?.status, 'recovered_via_rollback');
  assert.equal(reconciled[0].preRestoreSnapshotId, 'pre-snap-recovery-1');
  assert.equal(resticCalls.length, 1);
  assert.equal(resticCalls[0].snapshotId, 'pre-snap-recovery-1');
});

test('startup recovery never treats an earlier restore receipt as success for a new request', async () => {
  const registry = createWebsiteBackupOperationRegistry({ now: () => '2026-10-10T12:00:00.000Z' });
  const op = await registry.createOperation({ websiteId, serverId, repositoryId,
    kind: 'restore', snapshotId: 'snap-1', previewDigest, confirmation: 'restore-confirm' });
  await registry.updateOperation(op.id, { status: 'running' });
  const earlier = { websiteId, repositoryId, previewDigest, snapshotId: 'snap-1',
    status: 'succeeded', healthCheck: { satisfied: true }, committedAt: '2026-10-10T11:00:00.000Z' };
  const legacyId = websiteRestoreTransactionId({ websiteId, previewDigest });
  const reconciled = await registry.reconcileInterruptedOperations({
    receiptStore: { read: async id => id === legacyId ? earlier : null },
    websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId }) },
    websiteBackupSetProvider: { getWebsiteBackupSet: async () => ({ targetPaths: ['/var/lib/yunpanel/data/site-one'] }) },
    resticRepositoryRegistry: { getRepository: async () => ({ id: repositoryId, serverId }), revealPassword: async () => 'private-fixture' },
    siteMutationLock: { withSiteLock: async (_identity, action) => action() },
  });
  assert.equal(reconciled[0].status, 'failed');
  assert.equal(reconciled[0].error.code, 'interrupted_by_restart');
});

test('startup recovery can reconcile a legacy receipt written during its own interrupted request', async () => {
  const registry = createWebsiteBackupOperationRegistry({ now: () => '2026-10-10T12:00:00.000Z' });
  const op = await registry.createOperation({ websiteId, serverId, repositoryId,
    kind: 'restore', snapshotId: 'snap-1', previewDigest, confirmation: 'restore-confirm' });
  await registry.updateOperation(op.id, { status: 'running' });
  const receipt = { websiteId, repositoryId, previewDigest, snapshotId: 'snap-1',
    status: 'succeeded', healthCheck: { satisfied: true }, committedAt: '2026-10-10T12:01:00.000Z' };
  const legacyId = websiteRestoreTransactionId({ websiteId, previewDigest });
  const reconciled = await registry.reconcileInterruptedOperations({
    receiptStore: { read: async id => id === legacyId ? receipt : null },
    websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId }) },
    websiteBackupSetProvider: { getWebsiteBackupSet: async () => ({ targetPaths: ['/var/lib/yunpanel/data/site-one'] }) },
    resticRepositoryRegistry: { getRepository: async () => ({ id: repositoryId, serverId }), revealPassword: async () => 'private-fixture' },
    siteMutationLock: { withSiteLock: async (_identity, action) => action() },
  });
  assert.equal(reconciled[0].status, 'succeeded');
  assert.equal(reconciled[0].restartEvidence.status, 'reconciled_from_receipt');
});

test('reconcileInterruptedOperations recovers crash-interrupted backup operation from restic snapshots', async () => {
  const registry = createWebsiteBackupOperationRegistry();
  const op = await registry.createOperation({
    websiteId, serverId,
    repositoryId,
    kind: 'backup',
    previewDigest,
    confirmation,
  });
  await registry.updateOperation(op.id, { status: 'running', startedAt: new Date().toISOString() });

  const resticManager = {
    async listSnapshots() {
      return [{
        id: 'snapshot-found-in-repo',
        time: new Date().toISOString(),
        tags: [`website:${websiteId}`, `operation:${op.id}`, `backup-set:${previewDigest}`],
      }];
    },
  };
  resticManager.listSnapshotFiles = async () => [{ type: 'file', path: '/var/lib/yunpanel/data/site-one/proof.txt' }];
  const resticRepositoryRegistry = {
    async getRepository() { return { serverId, target: '/var/backups/repo' }; },
    async revealPassword() { return 'secret-pass'; },
  };

  const reconciled = await registry.reconcileInterruptedOperations({
    resticManager,
    resticRepositoryRegistry,
    websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId }) },
    websiteBackupSetProvider: { getWebsiteBackupSet: async () => ({ targetPaths: ['/var/lib/yunpanel/data/site-one'] }) },
    siteMutationLock: { withSiteLock: async (_identity, action) => action() },
  });

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'succeeded');
  assert.equal(reconciled[0].snapshotId, 'snapshot-found-in-repo');
  assert.equal(reconciled[0].restartEvidence?.status, 'reconciled_from_snapshot');
});


test('backup queue never dispatches in-process and missing worker dependencies fail closed', async () => {
  const { service, registry, calls, jobRegistry } = createFixture();
  const op = await service.queueBackup({ websiteId, repositoryId, expectedPreviewDigest: previewDigest, confirmation, actor });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.executeBackup.length, 0);
  assert.equal((await registry.getOperation(op.id)).status, 'queued');
  assert.equal((await jobRegistry.getJob(op.jobId)).status, 'queued');
  const unavailable = createWebsiteBackupOperationService({ registry: createWebsiteBackupOperationRegistry(), websiteBackupService: { previewBackup: async () => ({ backupSetDigest: previewDigest, confirmation }) } });
  await assert.rejects(unavailable.queueBackup({ websiteId, repositoryId, expectedPreviewDigest: previewDigest, confirmation, actor }), error => error.code === 'website_backup_runtime_unavailable');
});

test('native backup worker rejects another actor or resource before any host operation', async () => {
  const { service, registry, calls, jobRegistry } = createFixture();
  const op = await service.queueBackup({ websiteId, repositoryId, expectedPreviewDigest: previewDigest, confirmation, actor });
  const { job } = await jobRegistry.claimNext(serverId);
  const context = { serverId, jobId: job.id, resourceType: 'backup', resourceId: op.id };
  await assert.rejects(service.execute({ ...job.payload, actorUserId: '66666666-6666-4666-8666-666666666666' }, context), error => error.code === 'website_backup_execution_invalid');
  await assert.rejects(service.execute(job.payload, { ...context, resourceId: repositoryId }), error => error.code === 'website_backup_execution_invalid');
  assert.equal(calls.executeBackup.length, 0);
  assert.equal((await registry.getOperation(op.id)).status, 'queued');
});
