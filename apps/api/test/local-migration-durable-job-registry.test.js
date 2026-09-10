import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry } from '../src/job-registry.js';
import { createMigrationJobRegistry } from '../src/local-migration-cli.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-migration-durable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'jobs.json');
}

async function persistRunningJob(filePath) {
  const registry = createJobRegistry({ filePath });
  await registry.init();
  const job = await registry.enqueue({
    serverId: 'server-1',
    type: 'system.packages.inspect',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId: 'server-1',
  });
  await registry.claimNext('server-1');
  return job;
}

test('migration job registry detects persisted running work and creates durable recovery state', async (t) => {
  const filePath = await fixture(t);
  const job = await persistRunningJob(filePath);
  const registry = createMigrationJobRegistry({ filePath });
  await registry.init();
  assert.deepEqual(registry.recovery(), {
    code: 'durable_job_reconciliation_required',
    jobs: [{ jobId: job.id, serverId: 'server-1' }],
  });
  assert.deepEqual((await registry.listJobs({ status: 'running' })).map((entry) => entry.id), [job.id]);
});

test('migration job registry keeps terminal reconciliation sidecar visible after restart', async (t) => {
  const filePath = await fixture(t);
  const job = await persistRunningJob(filePath);
  const first = createMigrationJobRegistry({ filePath });
  await first.init();
  await first.beginReconciliation({ serverId: 'server-1', jobId: job.id });
  await first.complete({
    serverId: 'server-1',
    jobId: job.id,
    status: 'failed',
    error: { code: 'host_failed', message: 'Host operation failed' },
  });

  const restarted = createMigrationJobRegistry({ filePath });
  await restarted.init();
  assert.deepEqual(restarted.recovery(), {
    code: 'durable_job_reconciliation_required',
    jobs: [{ jobId: job.id, serverId: 'server-1' }],
  });
  assert.equal((await restarted.getJob(job.id)).status, 'failed');
});
