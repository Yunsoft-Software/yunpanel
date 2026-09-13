import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  DatabaseBackupOperationsError,
  createDatabaseBackupOperationsService,
} from '../src/database-backup-operations.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const backupId = '22345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';
const dumpSha256 = 'a'.repeat(64);

function backup() {
  return {
    version: 1,
    backupId,
    databaseName,
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256,
    dumpBytes: 4096,
    createdAt: '2026-09-13T04:00:00.000Z',
    backedUp: true,
    sideEffects: true,
  };
}

function fixture({ backupArtifact = backup(), backupJob = null, jobs = [] } = {}) {
  const enqueued = [];
  const job = backupJob ?? {
    id: backupId,
    serverId,
    operation: OPERATIONS.DATABASE_BACKUP,
    resourceType: 'database',
    resourceId: databaseName,
    status: 'succeeded',
    result: backup(),
  };
  const service = createDatabaseBackupOperationsService({
    backupManager: { async inspectBackup(id) { assert.equal(id, backupId); return backupArtifact; } },
    jobRegistry: {
      async getJob(id) { assert.equal(id, backupId); return job; },
      async listJobs() { return jobs; },
      async enqueue(input) { enqueued.push(structuredClone(input)); return { id: '32345678-1234-4234-8234-123456789012', ...input, status: 'queued' }; },
    },
  });
  return { service, enqueued };
}

test('restore preview is deterministic and contains no private dump material', async () => {
  const { service } = fixture();
  const preview = await service.previewRestore({ serverId, databaseName, backupId });
  assert.equal(preview.backupId, backupId);
  assert.equal(preview.backupSha256, dumpSha256);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.confirmation, `restore-database:${databaseName}:${preview.previewDigest}`);
  assert.equal(preview.sideEffects, false);
  assert.equal(Object.hasOwn(preview, 'dumpPath'), false);
  assert.equal(Object.hasOwn(preview, 'sql'), false);
});

test('restore queue pins backup checksum and exact preview digest', async () => {
  const { service, enqueued } = fixture();
  const preview = await service.previewRestore({ serverId, databaseName, backupId });
  const queued = await service.queueRestore({
    serverId,
    databaseName,
    backupId,
    expectedPreviewDigest: preview.previewDigest,
    expectedBackupSha256: preview.backupSha256,
    confirmation: preview.confirmation,
  });
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].payload, { databaseName, backupId, expectedBackupSha256: dumpSha256 });
  assert.equal(enqueued[0].operation, OPERATIONS.DATABASE_RESTORE);
  assert.equal(enqueued[0].resourceId, databaseName);
  assert.equal(queued.backupSha256, dumpSha256);
});

test('restore rejects backup job/server mismatch and artifact drift', async () => {
  for (const options of [
    { backupJob: { ...fixture().service, id: backupId } },
    { backupJob: { id: backupId, serverId: 'other', operation: OPERATIONS.DATABASE_BACKUP, resourceType: 'database', resourceId: databaseName, status: 'succeeded', result: backup() } },
    { backupArtifact: { ...backup(), dumpSha256: 'b'.repeat(64) } },
    { backupArtifact: { ...backup(), dumpPath: '/private/dump.sql' } },
  ]) {
    const actual = options.backupJob && !options.backupJob.operation
      ? { backupJob: null, backupArtifact: options.backupArtifact }
      : options;
    if (actual.backupJob === null) continue;
    const { service } = fixture(actual);
    await assert.rejects(
      service.previewRestore({ serverId, databaseName, backupId }),
      (error) => error instanceof DatabaseBackupOperationsError
        && ['database_restore_backup_job_mismatch', 'database_restore_backup_evidence_drift'].includes(error.code),
    );
  }
});

test('restore queue rejects stale preview and serializes with other database work', async () => {
  const first = fixture();
  const preview = await first.service.previewRestore({ serverId, databaseName, backupId });
  await assert.rejects(
    first.service.queueRestore({
      serverId,
      databaseName,
      backupId,
      expectedPreviewDigest: 'b'.repeat(64),
      expectedBackupSha256: preview.backupSha256,
      confirmation: preview.confirmation,
    }),
    (error) => error instanceof DatabaseBackupOperationsError && error.code === 'database_restore_preview_stale',
  );

  const busy = fixture({ jobs: [{ operation: OPERATIONS.DATABASE_BACKUP, status: 'running' }] });
  await assert.rejects(
    busy.service.previewRestore({ serverId, databaseName, backupId }),
    (error) => error instanceof DatabaseBackupOperationsError && error.code === 'database_job_conflict',
  );
});
