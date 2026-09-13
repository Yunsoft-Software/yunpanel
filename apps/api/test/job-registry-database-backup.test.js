import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';
const digest = 'a'.repeat(64);

function result(jobId, overrides = {}) {
  return {
    version: 1,
    backupId: jobId,
    databaseName,
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: digest,
    dumpBytes: 4096,
    createdAt: '2026-09-13T04:00:00.000Z',
    backedUp: true,
    sideEffects: true,
    ...overrides,
  };
}

async function claimedBackup() {
  const registry = createJobRegistry({ now: () => Date.parse('2026-09-13T04:00:00.000Z') });
  await registry.init();
  const queued = await registry.enqueue({
    serverId,
    type: OPERATIONS.DATABASE_BACKUP,
    operation: OPERATIONS.DATABASE_BACKUP,
    payload: { databaseName },
    resourceType: 'database',
    resourceId: databaseName,
    idempotencyKey: `database.backup:${serverId}:${databaseName}`,
  });
  const claimed = await registry.claimNext(serverId);
  return { registry, queued, claimed };
}

test('database backup enqueues, claims and completes with only safe manifest metadata', async () => {
  const { registry, queued, claimed } = await claimedBackup();
  assert.equal(queued.operation, OPERATIONS.DATABASE_BACKUP);
  assert.deepEqual(claimed.envelope.payload, { databaseName });
  assert.equal(claimed.envelope.operation, OPERATIONS.DATABASE_BACKUP);
  assert.equal(claimed.job.id, queued.id);

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

test('database backup completion rejects identity drift, bad digest and private result fields', async () => {
  for (const mutate of [
    (jobId) => result('22345678-1234-4234-8234-123456789012'),
    (jobId) => result(jobId, { databaseName: 'other_db' }),
    (jobId) => result(jobId, { dumpSha256: 'bad' }),
    (jobId) => ({ ...result(jobId), dumpPath: '/var/lib/yunpanel/backups/databases/private/dump.sql' }),
    (jobId) => ({ ...result(jobId), sql: 'CREATE TABLE secret (id INT)' }),
  ]) {
    const { registry, queued } = await claimedBackup();
    await assert.rejects(
      registry.complete({ serverId, jobId: queued.id, status: 'succeeded', result: mutate(queued.id) }),
      (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
    );
    assert.equal((await registry.getJob(queued.id)).status, 'running');
  }
});
