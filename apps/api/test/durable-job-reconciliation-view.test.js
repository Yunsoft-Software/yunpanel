import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';

const serverId = 'local-server';
const resourceId = 'local-server';
const result = Object.freeze({
  packageName: 'yunpanel',
  installed: false,
  installedVersion: null,
  candidateVersion: null,
  updateAvailable: false,
});

async function persistedRegistry() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-durable-reconcile-'));
  const filePath = path.join(directory, 'jobs.json');
  const registry = createDurableJobRegistry({
    filePath,
    registryFactory: createJobRegistry,
    automaticReconciliation: true,
  });
  await registry.init();
  return { directory, filePath, registry };
}

async function leaveTerminalReconciliationPending(registry) {
  const queued = await registry.enqueue({
    serverId,
    type: 'system.packages.inspect',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId,
  });
  await registry.claimNext(serverId);
  await registry.beginReconciliation({ serverId, jobId: queued.id });
  await registry.complete({
    serverId,
    jobId: queued.id,
    status: 'succeeded',
    result,
  });
  return queued.id;
}

test('restart recovery can read payload privately without exposing it through public job views', async () => {
  const { filePath, registry } = await persistedRegistry();
  const jobId = await leaveTerminalReconciliationPending(registry);

  const restarted = createDurableJobRegistry({
    filePath,
    registryFactory: createJobRegistry,
    automaticReconciliation: true,
  });
  await restarted.init();

  assert.deepEqual(restarted.recovery()?.jobs, [{ jobId, serverId }]);
  const publicJob = await restarted.getJob(jobId);
  assert.equal(Object.hasOwn(publicJob, 'payload'), false);

  const reconciliationJob = await restarted.getReconciliationJob(jobId);
  assert.deepEqual(reconciliationJob.payload, {});
  assert.deepEqual(reconciliationJob.result, result);
  assert.equal(reconciliationJob.status, 'succeeded');

  const acknowledged = await restarted.acknowledgeReconciliation({ serverId, jobId });
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(restarted.recovery(), null);
});

test('private reconciliation view rejects jobs that are not pending terminal reconciliation', async () => {
  const { registry } = await persistedRegistry();
  const queued = await registry.enqueue({
    serverId,
    type: 'system.packages.inspect',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId,
  });

  await assert.rejects(
    registry.getReconciliationJob(queued.id),
    (error) => error?.code === 'durable_job_reconciliation_not_pending',
  );
});
