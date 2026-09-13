import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations } from '../src/local-host-operations.js';

const jobId = '12345678-1234-4234-8234-123456789012';
const backupId = '22345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';
const digest = 'a'.repeat(64);
const preRestoreDigest = 'b'.repeat(64);
const payload = Object.freeze({ databaseName, backupId, expectedBackupSha256: digest });
const execution = Object.freeze({ jobId, resourceType: 'database', resourceId: databaseName });

function result() {
  return {
    version: 1,
    transactionId: jobId,
    backupId,
    preRestoreBackupId: `pre-restore:${jobId}`,
    databaseName,
    engine: 'mariadb',
    dumpSha256: digest,
    preRestoreDumpSha256: preRestoreDigest,
    restored: true,
    verified: true,
    sideEffects: true,
  };
}

test('database restore maps coarse manager progress into bounded secret-free job logs', async () => {
  const logs = [];
  const managerCalls = [];
  const operations = createLocalHostOperations({
    databaseRestoreManager: {
      async restore(input, options) {
        managerCalls.push([structuredClone(input), typeof options?.recordProgress]);
        await options.recordProgress({ stage: 'source', percent: 10 });
        await options.recordProgress({ stage: 'pre_backup', percent: 30 });
        await options.recordProgress({ stage: 'apply', percent: 40 });
        await options.recordProgress({ stage: 'verify', percent: 80 });
        await options.recordProgress({ stage: 'receipt', percent: 90 });
        await options.recordProgress({ stage: 'done', percent: 100 });
        return result();
      },
    },
    jobLogStore: {
      async record(entry) {
        logs.push(structuredClone(entry));
        return entry;
      },
    },
  });

  await operations.executeOperation(OPERATIONS.DATABASE_RESTORE, payload, execution);

  assert.deepEqual(managerCalls, [[{
    transactionId: jobId,
    backupId,
    databaseName,
    expectedBackupSha256: digest,
  }, 'function']]);
  assert.deepEqual(logs, [
    { jobId, stage: 'db.restore.source', level: 'info', message: 'progress=10' },
    { jobId, stage: 'db.restore.pre_backup', level: 'info', message: 'progress=30' },
    { jobId, stage: 'db.restore.apply', level: 'info', message: 'progress=40' },
    { jobId, stage: 'db.restore.verify', level: 'info', message: 'progress=80' },
    { jobId, stage: 'db.restore.receipt', level: 'info', message: 'progress=90' },
    { jobId, stage: 'db.restore.done', level: 'info', message: 'progress=100' },
  ]);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /dump\.sql|\/var\/lib|CREATE TABLE|password|socket|raw/i);
});

test('database restore keeps progress optional when no job log store is configured', async () => {
  let progress = 'unset';
  const operations = createLocalHostOperations({
    databaseRestoreManager: {
      async restore(_input, options) {
        progress = options?.recordProgress ?? null;
        return result();
      },
    },
  });

  const restored = await operations.executeOperation(OPERATIONS.DATABASE_RESTORE, payload, execution);
  assert.equal(progress, null);
  assert.deepEqual(restored, result());
});
