import assert from 'node:assert/strict';
import test from 'node:test';
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
const previewDigest = 'a'.repeat(64);
const confirmation = `backup:${websiteId}:${repositoryId}:${previewDigest}`;

function createFixture({
  backupSucceeds = true,
  restoreResult = { status: 'succeeded', snapshotId: 'snap-1', preRestoreSnapshotId: 'pre-snap-1', healthCheck: { satisfied: true } },
} = {}) {
  const registry = createWebsiteBackupOperationRegistry();
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

  const service = createWebsiteBackupOperationService({
    registry,
    websiteBackupService,
    websiteRestoreService,
  });

  return { registry, service, calls, restoreConfirmation };
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
    () => service.queueBackup({ websiteId, repositoryId, expectedPreviewDigest: 'wrong-digest', confirmation }),
    (err) => err instanceof WebsiteBackupOperationServiceError && err.code === 'backup_preview_stale' && err.status === 409,
  );

  await assert.rejects(
    () => service.queueBackup({ websiteId, repositoryId, expectedPreviewDigest: previewDigest, confirmation: 'wrong-confirm' }),
    (err) => err instanceof WebsiteBackupOperationServiceError && err.code === 'backup_confirmation_invalid' && err.status === 409,
  );

  const op = await service.queueBackup({ websiteId, repositoryId, expectedPreviewDigest: previewDigest, confirmation });
  assert.equal(op.kind, 'backup');
  assert.equal(op.status, 'queued');

  // Wait for setImmediate background execution
  await new Promise((resolve) => setTimeout(resolve, 50));

  const completed = await registry.getOperation(op.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.snapshotId, 'snap-backup-123');
  assert.equal(completed.result?.status, 'succeeded');
  assert.ok(completed.finishedAt);
  assert.deepEqual(completed.steps.map((s) => s.status), ['succeeded', 'succeeded', 'succeeded']);
});

test('queueBackup records failure in operation when executeBackup throws', async () => {
  const { service, registry } = createFixture({ backupSucceeds: false });

  const op = await service.queueBackup({ websiteId, repositoryId, expectedPreviewDigest: previewDigest, confirmation });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const failed = await registry.getOperation(op.id);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error?.message.includes('Restic backup execution failed'));
  assert.ok(failed.finishedAt);
});

test('queueRestore executes pre-restore snapshot, health check and records success', async () => {
  const { service, registry, restoreConfirmation } = createFixture();

  const op = await service.queueRestore({
    websiteId,
    repositoryId,
    snapshotId: 'snap-1',
    expectedPreviewDigest: previewDigest,
    confirmation: restoreConfirmation,
  });
  assert.equal(op.kind, 'restore');
  assert.equal(op.status, 'queued');

  await new Promise((resolve) => setTimeout(resolve, 50));

  const completed = await registry.getOperation(op.id);
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
    websiteId,
    repositoryId,
    snapshotId: 'snap-1',
    expectedPreviewDigest: previewDigest,
    confirmation: restoreConfirmation,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const rolledBack = await registry.getOperation(op.id);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.result?.rollbackReason, 'health_check_failed');
  assert.equal(rolledBack.result?.preRestoreSnapshotId, 'pre-snap-1');
  assert.equal(rolledBack.steps.find((s) => s.name === 'health_check')?.status, 'rolled_back');
});

test('reconcileInterruptedOperations recovers crash-interrupted restore operations from receipts', async () => {
  const registry = createWebsiteBackupOperationRegistry();
  const op = await registry.createOperation({
    websiteId,
    repositoryId,
    kind: 'restore',
    snapshotId: 'snap-1',
    previewDigest,
    confirmation: 'restore-confirm',
  });
  await registry.updateOperation(op.id, { status: 'running' });

  // Receipt shows pre_restore_created (process crashed mid-restore)
  const receipts = new Map([
    [`restore:${websiteId}:${previewDigest.slice(0, 32)}`, {
      status: 'pre_restore_created',
      websiteId,
      snapshotId: 'snap-1',
      preRestoreSnapshotId: 'pre-snap-recovery-1',
    }],
  ]);

  const resticCalls = [];
  const resticManager = {
    async restore(args) {
      resticCalls.push(args);
    },
  };
  const resticRepositoryRegistry = {
    async getRepository(id) {
      return { id, target: '/var/backups/repo' };
    },
    async revealPassword(id) {
      return 'secret-pass';
    },
  };
  const receiptStore = {
    async read(key) { return receipts.get(key) ?? null; },
    async write(record) { receipts.set(`restore:${record.websiteId}:${record.previewDigest?.slice(0, 32) ?? previewDigest.slice(0, 32)}`, record); },
  };

  const reconciled = await registry.reconcileInterruptedOperations({
    resticManager,
    resticRepositoryRegistry,
    receiptStore,
  });

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'rolled_back');
  assert.equal(reconciled[0].restartEvidence?.status, 'recovered_via_rollback');
  assert.equal(reconciled[0].preRestoreSnapshotId, 'pre-snap-recovery-1');
  assert.equal(resticCalls.length, 1);
  assert.equal(resticCalls[0].snapshotId, 'pre-snap-recovery-1');
});

test('reconcileInterruptedOperations recovers crash-interrupted backup operation from restic snapshots', async () => {
  const registry = createWebsiteBackupOperationRegistry();
  const op = await registry.createOperation({
    websiteId,
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
        tags: [`website:${websiteId}`],
      }];
    },
  };
  const resticRepositoryRegistry = {
    async getRepository() { return { target: '/var/backups/repo' }; },
    async revealPassword() { return 'secret-pass'; },
  };

  const reconciled = await registry.reconcileInterruptedOperations({
    resticManager,
    resticRepositoryRegistry,
  });

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'succeeded');
  assert.equal(reconciled[0].snapshotId, 'snapshot-found-in-repo');
  assert.equal(reconciled[0].restartEvidence?.status, 'reconciled_from_snapshot');
});
