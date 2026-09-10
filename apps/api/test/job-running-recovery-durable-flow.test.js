import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { recoverRunningInspection } from '../src/job-running-recovery.js';
import { createJobRegistry } from '../src/job-registry.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-running-recovery-flow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'jobs.json');
}

async function persistRunningPackageInspection(filePath) {
  const registry = createJobRegistry({ filePath });
  await registry.init();
  const job = await registry.enqueue({
    serverId: 'server-1',
    type: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId: 'server-1',
  });
  const claim = await registry.claimNext('server-1');
  assert.equal(claim.job.id, job.id);
  return job;
}

test('safe read-only recovery closes a persisted running package inspection after restart', async (t) => {
  const filePath = await fixture(t);
  const original = await persistRunningPackageInspection(filePath);
  const durable = createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
  await durable.init();
  assert.deepEqual(durable.recovery(), {
    code: 'durable_job_reconciliation_required',
    jobs: [{ jobId: original.id, serverId: 'server-1' }],
  });

  const executions = [];
  const result = await recoverRunningInspection({
    serverId: 'server-1',
    jobId: original.id,
    jobRegistry: durable,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    executeOperation: async (operation, payload) => {
      executions.push([operation, payload]);
      return {
        packageName: 'yunpanel',
        installed: true,
        installedVersion: '0.3.0',
        candidateVersion: '0.3.0',
        updateAvailable: false,
      };
    },
  });

  assert.deepEqual(executions, [[OPERATIONS.SYSTEM_PACKAGES_INSPECT, {}]]);
  assert.equal(result.status, 'succeeded');
  assert.equal((await durable.getJob(original.id)).status, 'succeeded');
  assert.equal(durable.recovery(), null);
  assert.deepEqual(durable.recoveryRecord(), { version: 1, detectedAt: null, jobs: [] });

  const restarted = createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery(), null);
  assert.equal((await restarted.getJob(original.id)).status, 'succeeded');
});

test('failed read-only probe leaves persisted running recovery intact across another restart', async (t) => {
  const filePath = await fixture(t);
  const original = await persistRunningPackageInspection(filePath);
  const durable = createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
  await durable.init();

  await assert.rejects(
    recoverRunningInspection({
      serverId: 'server-1',
      jobId: original.id,
      jobRegistry: durable,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      executeOperation: async () => { throw new Error('SECRET=/private/path'); },
    }),
    { code: 'job_running_recovery_probe_failed' },
  );
  assert.equal((await durable.getJob(original.id)).status, 'running');

  const restarted = createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
  await restarted.init();
  assert.deepEqual(restarted.recovery()?.jobs, [{ jobId: original.id, serverId: 'server-1' }]);
  assert.equal((await restarted.getJob(original.id)).status, 'running');
});
