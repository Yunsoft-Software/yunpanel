import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry, DurableJobRegistryError } from '../src/durable-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-durable-reconciliation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'jobs.json');
}

function durable(filePath) {
  return createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
}

async function runningSystemJob(registry, suffix = 'one') {
  const job = await registry.enqueue({
    serverId: 'server-1',
    type: `system.packages.inspect.${suffix}`,
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId: 'server-1',
  });
  const claim = await registry.claimNext('server-1');
  assert.equal(claim.job.id, job.id);
  return job;
}

const failedCompletion = (jobId) => ({
  serverId: 'server-1',
  jobId,
  status: 'failed',
  error: { code: 'host_operation_failed', message: 'Host operation failed' },
});

test('reconciliation journal blocks new mutations until terminal state is acknowledged', async (t) => {
  const filePath = await fixture(t);
  const registry = durable(filePath);
  await registry.init();
  const job = await runningSystemJob(registry);

  assert.deepEqual(await registry.beginReconciliation({ serverId: 'server-1', jobId: job.id }), {
    jobId: job.id,
    serverId: 'server-1',
    status: 'running',
    pending: true,
  });
  assert.deepEqual(registry.recovery().jobs, [{ jobId: job.id, serverId: 'server-1' }]);
  assert.deepEqual(registry.recoveryRecord().jobs, [{ jobId: job.id, serverId: 'server-1' }]);

  const terminal = await registry.complete(failedCompletion(job.id));
  assert.equal(terminal.status, 'failed');
  assert.deepEqual(registry.recovery().jobs, [{ jobId: job.id, serverId: 'server-1' }]);
  await assert.rejects(
    registry.enqueue({
      serverId: 'server-1',
      type: 'system.packages.inspect.two',
      operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
      payload: {},
      resourceType: 'system',
      resourceId: 'server-1',
    }),
    (error) => error instanceof DurableJobRegistryError && error.code === 'durable_job_reconciliation_required',
  );

  assert.deepEqual(await registry.acknowledgeReconciliation({ serverId: 'server-1', jobId: job.id }), {
    jobId: job.id,
    serverId: 'server-1',
    status: 'failed',
    acknowledged: true,
  });
  assert.equal(registry.recovery(), null);
  assert.deepEqual(registry.recoveryRecord().jobs, []);
  const next = await registry.enqueue({
    serverId: 'server-1',
    type: 'system.packages.inspect.two',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId: 'server-1',
  });
  assert.equal(next.status, 'queued');
});

test('terminal reconciliation journal survives restart and is not mistaken for completed recovery', async (t) => {
  const filePath = await fixture(t);
  const first = durable(filePath);
  await first.init();
  const job = await runningSystemJob(first);
  await first.beginReconciliation({ serverId: 'server-1', jobId: job.id });
  const detectedAt = first.recoveryRecord().detectedAt;
  await first.complete(failedCompletion(job.id));

  const restarted = durable(filePath);
  await restarted.init();
  assert.deepEqual(restarted.recovery(), {
    code: 'durable_job_reconciliation_required',
    jobs: [{ jobId: job.id, serverId: 'server-1' }],
  });
  assert.equal(restarted.recoveryRecord().detectedAt, detectedAt);
  assert.equal((await restarted.getJob(job.id)).status, 'failed');
  assert.deepEqual(await restarted.beginReconciliation({ serverId: 'server-1', jobId: job.id }), {
    jobId: job.id,
    serverId: 'server-1',
    status: 'failed',
    pending: true,
  });
  await restarted.acknowledgeReconciliation({ serverId: 'server-1', jobId: job.id });
  assert.equal(restarted.recovery(), null);
});

test('reconciliation cannot be acknowledged while the journaled job is still running', async (t) => {
  const filePath = await fixture(t);
  const registry = durable(filePath);
  await registry.init();
  const job = await runningSystemJob(registry);
  await registry.beginReconciliation({ serverId: 'server-1', jobId: job.id });
  await assert.rejects(
    registry.acknowledgeReconciliation({ serverId: 'server-1', jobId: job.id }),
    (error) => error instanceof DurableJobRegistryError && error.code === 'durable_job_reconciliation_not_ready',
  );
  assert.deepEqual(registry.recoveryRecord().jobs, [{ jobId: job.id, serverId: 'server-1' }]);
});

test('already-acknowledged terminal jobs make reconciliation acknowledgement idempotent', async (t) => {
  const filePath = await fixture(t);
  const registry = durable(filePath);
  await registry.init();
  const job = await runningSystemJob(registry);
  await registry.beginReconciliation({ serverId: 'server-1', jobId: job.id });
  await registry.complete(failedCompletion(job.id));
  await registry.acknowledgeReconciliation({ serverId: 'server-1', jobId: job.id });
  assert.deepEqual(await registry.acknowledgeReconciliation({ serverId: 'server-1', jobId: job.id }), {
    jobId: job.id,
    serverId: 'server-1',
    status: 'failed',
    acknowledged: false,
  });
});
