import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry } from '../src/job-registry.js';
import { createLocalJobExecutor } from '../src/local-job-executor.js';

const serverId = 'local-server';
const packageResult = {
  packageName: 'yunpanel',
  installed: false,
  installedVersion: null,
  candidateVersion: null,
  updateAvailable: false,
};

async function queuedJob(jobRegistry, resourceId = serverId) {
  return jobRegistry.enqueue({
    serverId,
    type: 'system.packages.inspect',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId,
  });
}

test('local executor claims, sanitizes, completes and reconciles a queued job', async () => {
  const jobRegistry = createJobRegistry();
  const queued = await queuedJob(jobRegistry);
  const calls = [];
  const executor = createLocalJobExecutor({
    serverId,
    jobRegistry,
    executeOperation: async (operation, payload) => {
      calls.push({ operation, payload });
      return { ...packageResult, ignored: 'job registry must remove this field' };
    },
    reconcileCompletedJob: async (job) => { calls.push({ reconciled: job.id, status: job.status }); return { reconciled: true }; },
  });

  const result = await executor.runOnce();
  assert.equal(result.claimed, true);
  assert.equal(result.job.id, queued.id);
  assert.equal(result.job.status, 'succeeded');
  assert.deepEqual(result.job.result, packageResult);
  assert.deepEqual(calls[0], { operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT, payload: {} });
  assert.deepEqual(calls[1], { reconciled: queued.id, status: 'succeeded' });
  assert.equal((await jobRegistry.getJob(queued.id)).status, 'succeeded');
});

test('local operation failure becomes a terminal failed job and still reconciles', async () => {
  const jobRegistry = createJobRegistry();
  const queued = await queuedJob(jobRegistry, 'system-2');
  let reconciled;
  const executor = createLocalJobExecutor({
    serverId,
    jobRegistry,
    executeOperation: async () => { const error = new Error('apt failed with private details'); error.code = 'apt_inspection_failed'; throw error; },
    reconcileCompletedJob: async (job) => { reconciled = job; return { reconciled: true }; },
  });

  const result = await executor.runOnce();
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.error.code, 'apt_inspection_failed');
  assert.equal(result.job.error.message, 'Unable to inspect the YunPanel APT package.');
  assert.equal(reconciled.id, queued.id);
  assert.equal(reconciled.status, 'failed');
});

test('concurrent runOnce calls share one claim and do not execute a job twice', async () => {
  const jobRegistry = createJobRegistry();
  await queuedJob(jobRegistry, 'system-3');
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executor = createLocalJobExecutor({
    serverId,
    jobRegistry,
    executeOperation: async () => { executions += 1; await gate; return packageResult; },
    reconcileCompletedJob: async () => ({ reconciled: true }),
  });

  const first = executor.runOnce();
  const second = executor.runOnce();
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executions, 1);
  release();
  await first;
  assert.equal(executions, 1);
});

test('empty queue returns without invoking host operations', async () => {
  const jobRegistry = createJobRegistry();
  let calls = 0;
  const executor = createLocalJobExecutor({
    serverId,
    jobRegistry,
    executeOperation: async () => { calls += 1; return packageResult; },
    reconcileCompletedJob: async () => ({ reconciled: true }),
  });
  assert.deepEqual(await executor.runOnce(), { claimed: false, job: null, reconciliation: null });
  assert.equal(calls, 0);
});
