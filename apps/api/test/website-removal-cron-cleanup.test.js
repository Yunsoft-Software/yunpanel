import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceWebsiteRemovalCronCleanup, WebsiteRemovalCronCleanupError } from '../src/website-removal-cron-cleanup.js';
import { appId, jobFor, serverId, siteId, task, taskId, otherId } from './fixtures/cron-removal-fixture.js';

function removalOperation() {
  return {
    id: 'ws-rem-test-operation',
    websiteId: siteId,
    serverId,
    applicationId: appId,
    plan: { additional: { crons: { status: 'available', ids: [taskId] } } },
  };
}

function removalStep(result = null) {
  return {
    id: `001:cron_cleanup:${siteId}`,
    kind: 'cron_cleanup',
    resourceId: siteId,
    status: 'running',
    result,
  };
}

function checkpointRegistry(operation, step, { failAt = null } = {}) {
  let calls = 0;
  let stored = step.result;
  return {
    get stored() { return stored; },
    get calls() { return calls; },
    checkpointStep: async (operationId, stepId, result) => {
      calls += 1;
      if (failAt === calls) throw new Error('simulated checkpoint write failure');
      assert.equal(operationId, operation.id);
      assert.equal(stepId, step.id);
      stored = structuredClone(result);
      return {
        ...operation,
        status: 'running',
        updatedAt: new Date(calls).toISOString(),
        steps: [{ ...step, status: 'running', result: stored }],
      };
    },
  };
}

test('queued cron removal is checkpointed and only completes after verified job and metadata absence', async () => {
  const operation = removalOperation();
  const step = removalStep();
  const checkpoints = checkpointRegistry(operation, step);
  let currentTask = task();
  let existingJob = null;
  let enqueues = 0;
  const websiteCronRegistry = {
    listTasks: async () => (currentTask ? [currentTask] : []),
    getTask: async () => currentTask,
  };
  const jobRegistry = {
    findIdempotentJob: async () => existingJob,
    enqueue: async () => {
      enqueues += 1;
      existingJob = jobFor(currentTask, { status: 'queued' });
      return existingJob;
    },
  };

  const waiting = await advanceWebsiteRemovalCronCleanup({
    operation,
    step,
    operationRegistry: checkpoints,
    websiteCronRegistry,
    jobRegistry,
  });
  assert.equal(waiting.complete, false);
  assert.equal(enqueues, 1);
  assert.equal(checkpoints.stored.tasks[0].status, 'queued');
  assert.ok(checkpoints.stored.tasks[0].jobId);
  assert.doesNotMatch(JSON.stringify(checkpoints.stored), /\/bin\/true|\*\/5/);

  currentTask = null;
  existingJob = jobFor(task(), { status: 'succeeded', id: checkpoints.stored.tasks[0].jobId });
  const completed = await advanceWebsiteRemovalCronCleanup({
    operation,
    step: removalStep(checkpoints.stored),
    operationRegistry: checkpoints,
    websiteCronRegistry,
    jobRegistry,
  });
  assert.equal(completed.complete, true);
  assert.equal(enqueues, 1);
  assert.deepEqual(completed.result.taskIds, [taskId]);
  assert.deepEqual(completed.result.jobIds, [existingJob.id]);
});

test('prepared checkpoint recovers the idempotent cron job after an enqueue-to-checkpoint crash', async () => {
  const operation = removalOperation();
  const step = removalStep();
  const checkpoints = checkpointRegistry(operation, step, { failAt: 2 });
  let currentTask = task();
  let existingJob = null;
  let enqueues = 0;
  const websiteCronRegistry = {
    listTasks: async () => (currentTask ? [currentTask] : []),
    getTask: async () => currentTask,
  };
  const jobRegistry = {
    findIdempotentJob: async () => existingJob,
    enqueue: async () => {
      enqueues += 1;
      existingJob = jobFor(currentTask, { status: 'queued' });
      return existingJob;
    },
  };

  await assert.rejects(advanceWebsiteRemovalCronCleanup({
    operation,
    step,
    operationRegistry: checkpoints,
    websiteCronRegistry,
    jobRegistry,
  }), /checkpoint write failure/);
  assert.equal(enqueues, 1);
  assert.equal(checkpoints.stored.tasks[0].status, 'prepared');
  assert.equal(checkpoints.stored.tasks[0].jobId, null);

  currentTask = null;
  existingJob = jobFor(task(), { status: 'succeeded', id: existingJob.id });
  const recoveredRegistry = checkpointRegistry(operation, removalStep(checkpoints.stored));
  const completed = await advanceWebsiteRemovalCronCleanup({
    operation,
    step: removalStep(checkpoints.stored),
    operationRegistry: recoveredRegistry,
    websiteCronRegistry,
    jobRegistry,
  });
  assert.equal(completed.complete, true);
  assert.equal(enqueues, 1);
});

test('cron inventory drift blocks Website removal before any cron job is enqueued', async () => {
  const operation = removalOperation();
  const step = removalStep();
  const checkpoints = checkpointRegistry(operation, step);
  let enqueues = 0;
  await assert.rejects(advanceWebsiteRemovalCronCleanup({
    operation,
    step,
    operationRegistry: checkpoints,
    websiteCronRegistry: {
      listTasks: async () => [task({ id: otherId })],
      getTask: async () => null,
    },
    jobRegistry: {
      findIdempotentJob: async () => null,
      enqueue: async () => { enqueues += 1; return null; },
    },
  }), (error) => error instanceof WebsiteRemovalCronCleanupError
    && error.code === 'website_removal_cleanup_unverified');
  assert.equal(enqueues, 0);
  assert.equal(checkpoints.calls, 0);
});

for (const status of ['failed', 'cancelled']) {
  test(`${status} cron removal job remains a blocker and is never blindly re-enqueued`, async () => {
    const operation = removalOperation();
    const step = removalStep();
    const checkpoints = checkpointRegistry(operation, step);
    let existingJob = jobFor(task(), { status });
    let enqueues = 0;
    await assert.rejects(advanceWebsiteRemovalCronCleanup({
      operation,
      step,
      operationRegistry: checkpoints,
      websiteCronRegistry: {
        listTasks: async () => [task()],
        getTask: async () => task(),
      },
      jobRegistry: {
        findIdempotentJob: async () => existingJob,
        enqueue: async () => { enqueues += 1; return existingJob; },
      },
    }), (error) => error instanceof WebsiteRemovalCronCleanupError
      && error.code === 'website_removal_cron_job_failed');
    assert.equal(enqueues, 0);
    assert.equal(checkpoints.stored.tasks[0].status, status);
  });
}
