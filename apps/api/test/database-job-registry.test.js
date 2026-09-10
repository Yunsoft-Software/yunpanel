import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const serverId = 'server-db';

async function queueAndClaim(registry, operation, payload = {}, resourceId = serverId) {
  const job = await registry.enqueue({
    serverId,
    type: operation,
    operation,
    payload,
    resourceType: 'database',
    resourceId,
  });
  const claimed = await registry.claimNext(serverId);
  assert.equal(claimed.job.id, job.id);
  assert.equal(claimed.envelope.operation, operation);
  return job;
}

test('database inspect jobs use the durable queue and persist only sanitized inventory metadata', async () => {
  const registry = createJobRegistry();
  const job = await queueAndClaim(registry, OPERATIONS.DATABASE_INSPECT);
  const completed = await registry.complete({
    serverId,
    jobId: job.id,
    status: 'succeeded',
    result: {
      engine: 'mariadb',
      version: '10.11.13-MariaDB',
      databases: [{ name: 'app_main', sizeBytes: 2048, sql: 'SECRET' }],
      socketPath: '/run/mysqld/mysqld.sock',
      stdout: 'must not persist',
    },
  });
  assert.deepEqual(completed.result, {
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    databases: [{ name: 'app_main', sizeBytes: 2048 }],
  });
});

test('database create/delete jobs require exact queued identity and preserve registry error semantics', async () => {
  const registry = createJobRegistry();
  const createJob = await queueAndClaim(registry, OPERATIONS.DATABASE_CREATE, { name: 'customer_42' }, 'customer_42');
  const created = await registry.complete({
    serverId,
    jobId: createJob.id,
    status: 'succeeded',
    result: {
      engine: 'mysql',
      version: '8.0.43',
      database: { name: 'customer_42', sizeBytes: 0, raw: 'drop-me' },
      created: true,
      command: 'must not persist',
    },
  });
  assert.deepEqual(created.result, {
    engine: 'mysql', version: '8.0.43', database: { name: 'customer_42', sizeBytes: 0 }, created: true,
  });

  const deleteJob = await queueAndClaim(registry, OPERATIONS.DATABASE_DELETE, { name: 'customer_42' }, 'customer_42');
  await assert.rejects(
    registry.complete({
      serverId,
      jobId: deleteJob.id,
      status: 'succeeded',
      result: {
        engine: 'mysql', version: '8.0.43', database: { name: 'another_db', sizeBytes: 0 }, deleted: true,
      },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );
  const unchanged = await registry.getJob(deleteJob.id);
  assert.equal(unchanged.status, 'running');
  assert.equal(unchanged.result, null);
});

test('database payload validation still occurs before a job can enter the queue', async () => {
  const registry = createJobRegistry();
  await assert.rejects(
    registry.enqueue({
      serverId,
      type: OPERATIONS.DATABASE_CREATE,
      operation: OPERATIONS.DATABASE_CREATE,
      payload: { name: 'app_main', sql: 'DROP DATABASE mysql' },
      resourceType: 'database',
      resourceId: 'app_main',
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_operation_payload',
  );
  assert.equal((await registry.listJobs()).length, 0);
});
