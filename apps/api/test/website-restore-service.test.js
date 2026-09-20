import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WebsiteRestoreError,
  createWebsiteRestoreService,
} from '../src/website-restore-service.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const otherServerId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';
const websiteId = '2c387b02-8747-458a-b509-8f531d4d149e';
const notFoundWebsiteId = '00000000-0000-4000-8000-000000000000';
const repositoryId = '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c';
const notFoundRepoId = '11111111-2222-4333-8444-555555555555';
const snapshotId = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const preRestoreSnapshotId = '9z8y7x6w5v4u3t2s1r0q9p8o7n6m5l4k';

function fixture({
  healthSatisfied = true,
  healthThrows = false,
  preRestoreFails = false,
  restoreExecutionFails = false,
  activeJobs = [],
} = {}) {
  const calls = {
    listSnapshots: [],
    createSnapshot: [],
    restore: [],
    healthInspect: [],
  };

  const website = {
    id: websiteId,
    serverId,
    name: 'TestApp',
    primaryDomain: 'example.com',
    runtimeType: 'node',
    revision: 3,
  };

  const repository = {
    id: repositoryId,
    serverId,
    name: 'default_repo',
    target: '/var/lib/yunpanel/backups/restic/repos/default_repo',
  };

  const snapshots = [
    {
      id: snapshotId,
      time: '2026-09-20T03:00:00.000Z',
      tags: [`website:${websiteId}`, 'env:production'],
      paths: ['/var/lib/yunpanel/apps/test/current', '/var/lib/yunpanel/data/test'],
    },
  ];

  const backupSet = {
    targetPaths: ['/var/lib/yunpanel/apps/test/current', '/var/lib/yunpanel/data/test'],
    excludePatterns: ['**/tmp/**'],
    tags: [`website:${websiteId}`, `server:${serverId}`],
  };

  const receipts = new Map();
  const receiptStore = {
    async read(id) {
      return receipts.get(id) ?? null;
    },
    async write(val) {
      const copy = { ...val, committedAt: new Date().toISOString() };
      receipts.set(val.transactionId, copy);
      return copy;
    },
  };

  const service = createWebsiteRestoreService({
    websiteRegistry: {
      async getWebsite(id) {
        return id === websiteId ? website : null;
      },
    },
    resticRepositoryRegistry: {
      async getRepository(id) {
        return id === repositoryId ? repository : null;
      },
      async revealPassword(id) {
        return id === repositoryId ? 'super_secret_password' : null;
      },
    },
    resticManager: {
      async listSnapshots(args) {
        calls.listSnapshots.push(args);
        return snapshots;
      },
      async createSnapshot(args) {
        calls.createSnapshot.push(args);
        if (preRestoreFails) {
          throw new Error('Disk full during pre-restore snapshot');
        }
        return { snapshotId: preRestoreSnapshotId };
      },
      async restore(args) {
        calls.restore.push(args);
        if (restoreExecutionFails && args.snapshotId === snapshotId) {
          throw new Error('Restic restore failed on corrupted pack file');
        }
        return { stdout: 'restored' };
      },
    },
    websiteBackupSetProvider: {
      async getWebsiteBackupSet({ websiteId: requestedWebsiteId }) {
        assert.equal(requestedWebsiteId, websiteId);
        return backupSet;
      },
    },
    healthInspector: {
      async inspect(args) {
        calls.healthInspect.push(args);
        if (healthThrows) {
          throw new Error('Connection refused to health endpoint');
        }
        return {
          satisfied: healthSatisfied,
          statusCode: healthSatisfied ? 200 : 502,
          attempts: healthSatisfied ? 1 : 3,
          error: healthSatisfied ? null : 'HTTP 502 Bad Gateway',
        };
      },
    },
    localServerId: serverId,
    jobRegistry: {
      async listJobs() {
        return activeJobs;
      },
    },
    receiptStore,
  });

  return { service, calls, website, repository, snapshots, backupSet, receipts, activeJobs };
}

test('previewRestore generates valid preview, digest, and confirmation for website snapshot', async () => {
  const { service, calls, repository } = fixture();

  const preview = await service.previewRestore({
    websiteId,
    repositoryId,
    snapshotId,
  });

  assert.equal(preview.websiteId, websiteId);
  assert.equal(preview.websiteRevision, 3);
  assert.equal(preview.repositoryId, repositoryId);
  assert.equal(preview.snapshotId, snapshotId);
  assert.deepEqual(preview.healthSpec, {
    primaryDomain: 'example.com',
    healthPath: '/health',
    timeoutSeconds: 30,
  });
  assert.equal(typeof preview.previewDigest, 'string');
  assert.equal(preview.previewDigest.length, 64);
  assert.equal(preview.confirmation, `restore:${websiteId}:${snapshotId}:${preview.previewDigest}`);
  assert.deepEqual(calls.listSnapshots[0], {
    repository: repository.target,
    password: 'super_secret_password',
    tags: [`website:${websiteId}`],
  });
});

test('previewRestore errors: missing website, missing repo, missing snapshot, invalid UUID', async () => {
  const { service } = fixture();

  await assert.rejects(
    () => service.previewRestore({ websiteId: notFoundWebsiteId, repositoryId, snapshotId }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'website_not_found' && err.status === 404,
  );

  await assert.rejects(
    () => service.previewRestore({ websiteId, repositoryId: notFoundRepoId, snapshotId }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'repository_not_found' && err.status === 404,
  );

  await assert.rejects(
    () => service.previewRestore({ websiteId, repositoryId, snapshotId: 'nonexistent-snapshot-id' }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'snapshot_not_found' && err.status === 404,
  );

  await assert.rejects(
    () => service.previewRestore({ websiteId: 'invalid-uuid', repositoryId, snapshotId }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'invalid_website_id' && err.status === 400,
  );
});

test('previewRestore and executeRestore reject when an active job exists on the website (resource locking)', async () => {
  const activeJobs = [
    {
      id: 'job-1',
      status: 'running',
      resourceType: 'website',
      resourceId: websiteId,
      operation: 'app.node.deploy',
    },
  ];
  const { service } = fixture({ activeJobs });

  await assert.rejects(
    () => service.previewRestore({ websiteId, repositoryId, snapshotId }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'website_job_conflict' && err.status === 409,
  );
});

test('executeRestore takes pre-restore snapshot, restores, checks health, and succeeds', async () => {
  const { service, calls, repository, backupSet, receipts } = fixture({ healthSatisfied: true });

  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });

  const result = await service.executeRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.snapshotId, snapshotId);
  assert.equal(result.preRestoreSnapshotId, preRestoreSnapshotId);
  assert.equal(result.healthCheck.satisfied, true);
  assert.equal(result.healthCheck.statusCode, 200);

  // Verify pre-restore snapshot was taken before restore
  assert.equal(calls.createSnapshot.length, 1);
  assert.ok(calls.createSnapshot[0].tags.includes('pre-restore'));
  assert.ok(calls.createSnapshot[0].tags.includes(`restore-of:${snapshotId}`));
  assert.equal(calls.createSnapshot[0].repository, repository.target);
  assert.deepEqual(calls.createSnapshot[0].paths, backupSet.targetPaths);
  assert.deepEqual(calls.createSnapshot[0].excludes, backupSet.excludePatterns);

  // Verify restore was called with target snapshot
  assert.equal(calls.restore.length, 1);
  assert.equal(calls.restore[0].snapshotId, snapshotId);
  assert.equal(calls.restore[0].repository, repository.target);

  // Verify health check was performed
  assert.equal(calls.healthInspect.length, 1);
  assert.equal(calls.healthInspect[0].primaryDomain, 'example.com');

  // Verify receipt was persisted with succeeded status
  assert.equal(receipts.size, 1);
  const [receipt] = receipts.values();
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.websiteRevision, 3);

  // Verify idempotent replay
  const replayResult = await service.executeRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(replayResult.status, 'succeeded');
  assert.equal(replayResult.idempotent, true);
  // calls to restore and createSnapshot must NOT have increased
  assert.equal(calls.restore.length, 1);
  assert.equal(calls.createSnapshot.length, 1);
});

test('executeRestore triggers automatic health rollback when health check fails', async () => {
  const { service, calls, receipts } = fixture({ healthSatisfied: false });

  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });

  const result = await service.executeRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  assert.equal(result.status, 'rolled_back');
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.snapshotId, snapshotId);
  assert.equal(result.preRestoreSnapshotId, preRestoreSnapshotId);
  assert.equal(result.rollbackReason, 'health_check_failed');
  assert.equal(result.healthCheck.satisfied, false);
  assert.equal(result.healthCheck.statusCode, 502);

  // Verify restore was called twice: 1st with target snapshot, 2nd with pre-restore snapshot
  assert.equal(calls.restore.length, 2);
  assert.equal(calls.restore[0].snapshotId, snapshotId);
  assert.equal(calls.restore[1].snapshotId, preRestoreSnapshotId);

  // Verify rolled_back receipt was persisted
  const [receipt] = receipts.values();
  assert.equal(receipt.status, 'rolled_back');
  assert.equal(receipt.rollbackReason, 'health_check_failed');

  // Verify idempotent replay of rolled back state
  const replay = await service.executeRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(replay.status, 'rolled_back');
  assert.equal(replay.idempotent, true);
  assert.equal(calls.restore.length, 2);
});

test('executeRestore aborts before mutation if pre-restore snapshot fails', async () => {
  const { service, calls } = fixture({ preRestoreFails: true });

  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });

  await assert.rejects(
    () => service.executeRestore({
      websiteId,
      repositoryId,
      snapshotId,
      expectedPreviewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'pre_restore_snapshot_failed' && err.status === 500,
  );

  // Verify that restore was NEVER executed
  assert.equal(calls.restore.length, 0);
});

test('executeRestore rejects stale preview digest or wrong confirmation', async () => {
  const { service, website } = fixture();

  const preview = await service.previewRestore({ websiteId, repositoryId, snapshotId });

  await assert.rejects(
    () => service.executeRestore({
      websiteId,
      repositoryId,
      snapshotId,
      expectedPreviewDigest: '0'.repeat(64),
      confirmation: preview.confirmation,
    }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'restore_preview_stale' && err.status === 409,
  );

  await assert.rejects(
    () => service.executeRestore({
      websiteId,
      repositoryId,
      snapshotId,
      expectedPreviewDigest: preview.previewDigest,
      confirmation: 'wrong-confirmation',
    }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'restore_confirmation_invalid' && err.status === 409,
  );

  // Revision change causes stale preview
  website.revision = 4;
  await assert.rejects(
    () => service.executeRestore({
      websiteId,
      repositoryId,
      snapshotId,
      expectedPreviewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (err) => err instanceof WebsiteRestoreError && err.code === 'restore_preview_stale' && err.status === 409,
  );
});
