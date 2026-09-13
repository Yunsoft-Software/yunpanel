import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const backupId = '22345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';
const selectedSha = 'a'.repeat(64);
const preRestoreSha = 'b'.repeat(64);

function result(jobId, overrides = {}) {
  return {
    version: 1,
    transactionId: jobId,
    backupId,
    preRestoreBackupId: `pre-restore:${jobId}`,
    databaseName,
    engine: 'mariadb',
    dumpSha256: selectedSha,
    preRestoreDumpSha256: preRestoreSha,
    restored: true,
    verified: true,
    sideEffects: true,
    ...overrides,
  };
}

async function claimedRestore() {
  const registry = createJobRegistry({ now: () => Date.parse('2026-09-13T04:20:00.000Z') });
  await registry.init();
  const queued = await registry.enqueue({
    serverId,
    type: OPERATIONS.DATABASE_RESTORE,
    operation: OPERATIONS.DATABASE_RESTORE,
    payload: { databaseName, backupId, expectedBackupSha256: selectedSha },
    resourceType: 'database',
    resourceId: databaseName,
    idempotencyKey: `database-restore:${serverId}:${databaseName}:${selectedSha}`,
  });
  const claimed = await registry.claimNext(serverId);
  return { registry, queued, claimed };
}

test('database restore enqueues, claims and completes with only pinned public evidence', async () => {
  const { registry, queued, claimed } = await claimedRestore();
  assert.equal(queued.operation, OPERATIONS.DATABASE_RESTORE);
  assert.equal(claimed.envelope.operation, OPERATIONS.DATABASE_RESTORE);
  assert.deepEqual(claimed.envelope.payload, { databaseName, backupId, expectedBackupSha256: selectedSha });

  const completed = await registry.complete({
    serverId,
    jobId: queued.id,
    status: 'succeeded',
    result: result(queued.id),
  });
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.result, result(queued.id));
  assert.equal(Object.hasOwn(completed.result, 'dumpPath'), false);
  assert.equal(JSON.stringify(completed).includes('CREATE TABLE'), false);
});

test('database restore completion rejects stale identity, digest drift and private fields', async () => {
  for (const mutate of [
    (jobId) => result('32345678-1234-4234-8234-123456789012'),
    (jobId) => result(jobId, { backupId: '42345678-1234-4234-8234-123456789012' }),
    (jobId) => result(jobId, { dumpSha256: 'c'.repeat(64) }),
    (jobId) => result(jobId, { preRestoreBackupId: 'pre-restore:other-job' }),
    (jobId) => ({ ...result(jobId), dumpPath: '/var/lib/yunpanel/backups/databases/private/dump.sql' }),
    (jobId) => ({ ...result(jobId), sql: 'CREATE TABLE secret (id INT)' }),
  ]) {
    const { registry, queued } = await claimedRestore();
    await assert.rejects(
      registry.complete({ serverId, jobId: queued.id, status: 'succeeded', result: mutate(queued.id) }),
      (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
    );
    assert.equal((await registry.getJob(queued.id)).status, 'running');
  }
});
