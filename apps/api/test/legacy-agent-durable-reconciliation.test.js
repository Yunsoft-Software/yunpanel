import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-legacy-reconciliation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'jobs.json');
}

function durable(filePath, automaticReconciliation = true) {
  return createDurableJobRegistry({
    filePath,
    registryFactory: createJobRegistry,
    automaticReconciliation,
  });
}

async function claimSystemJob(registry) {
  const queued = await registry.enqueue({
    serverId: 'server-1',
    type: 'system.packages.inspect',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId: 'server-1',
  });
  const claimed = await registry.claimNext('server-1');
  assert.equal(claimed.job.id, queued.id);
  return queued;
}

async function failJob(registry, jobId) {
  return registry.complete({
    serverId: 'server-1',
    jobId,
    status: 'failed',
    error: { code: 'host_operation_failed', message: 'Host operation failed' },
  });
}

const emptyRegistries = Object.freeze({
  domainRegistry: {},
  certificateRegistry: {},
  applicationRegistry: {},
});

test('automatic durable reconciliation journals a legacy completion until shared reconciliation succeeds', async (t) => {
  const registry = durable(await fixture(t));
  await registry.init();
  const queued = await claimSystemJob(registry);
  const completed = await failJob(registry, queued.id);

  assert.equal(completed.status, 'failed');
  assert.deepEqual(registry.recovery(), {
    code: 'durable_job_reconciliation_required',
    jobs: [{ jobId: queued.id, serverId: 'server-1' }],
  });
  assert.deepEqual(registry.recoveryRecord().jobs, [{ jobId: queued.id, serverId: 'server-1' }]);

  const reconciliation = await reconcileCompletedJob({ ...emptyRegistries, job: completed });
  assert.deepEqual(reconciliation, { reconciled: true, error: null });
  assert.equal(registry.recovery(), null);
  assert.deepEqual(registry.recoveryRecord().jobs, []);
});

test('explicit local reconciliation is not auto-acknowledged by the legacy completion hook', async (t) => {
  const registry = durable(await fixture(t));
  await registry.init();
  const queued = await claimSystemJob(registry);
  await registry.beginReconciliation({ serverId: 'server-1', jobId: queued.id });
  const completed = await failJob(registry, queued.id);

  await reconcileCompletedJob({ ...emptyRegistries, job: completed });
  assert.deepEqual(registry.recoveryRecord().jobs, [{ jobId: queued.id, serverId: 'server-1' }]);

  const acknowledged = await registry.acknowledgeReconciliation({ serverId: 'server-1', jobId: queued.id });
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(registry.recovery(), null);
});

test('automatic reconciliation remains opt-in outside the production registry', async (t) => {
  const registry = durable(await fixture(t), false);
  await registry.init();
  const queued = await claimSystemJob(registry);
  const completed = await failJob(registry, queued.id);
  assert.equal(completed.status, 'failed');
  assert.equal(registry.recovery(), null);
});

test('automatic reconciliation mode rejects non-boolean configuration', () => {
  assert.throws(
    () => createDurableJobRegistry({ filePath: '/virtual/jobs.json', registryFactory: createJobRegistry, automaticReconciliation: 'yes' }),
    { code: 'durable_job_reconciliation_mode_invalid' },
  );
});
