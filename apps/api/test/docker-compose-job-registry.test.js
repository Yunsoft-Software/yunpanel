import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry } from '../src/job-registry.js';

const serverId = 'local-server';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';

function pinnedPayload(overrides = {}) {
  return {
    projectId,
    expectedProjectRevision: 3,
    expectedEnvironmentRevision: 2,
    expectedComposeSha256: 'a'.repeat(64),
    credentialRevisions: [],
    ...overrides,
  };
}

function queueInput(operation, overrides = {}) {
  return {
    serverId,
    type: operation,
    operation,
    payload: pinnedPayload(),
    resourceType: 'docker_project',
    resourceId: projectId,
    idempotencyKey: `docker-compose-${operation.split('.').at(-1)}-0001`,
    ...overrides,
  };
}

function successfulResult(action, runtimeState) {
  return {
    version: 1,
    projectId,
    projectRevision: 3,
    environmentRevision: 2,
    composeSha256: 'a'.repeat(64),
    action,
    runtimeState,
    executed: true,
    sideEffects: true,
  };
}

test('docker compose lifecycle jobs use the common resource lock and completion sanitizer', async () => {
  const registry = createJobRegistry();
  await registry.init();

  const queued = await registry.enqueue(queueInput(OPERATIONS.DOCKER_COMPOSE_START));
  assert.equal(queued.resourceType, 'docker_project');
  assert.equal(queued.resourceId, projectId);
  assert.equal(queued.status, 'queued');

  await assert.rejects(
    registry.enqueue(queueInput(OPERATIONS.DOCKER_COMPOSE_RESTART, {
      idempotencyKey: 'docker-compose-restart-0002',
    })),
    (error) => error?.code === 'docker_project_job_conflict' && error?.status === 409,
  );

  const claimed = await registry.claimNext(serverId);
  assert.equal(claimed.job.id, queued.id);
  assert.equal(claimed.envelope.operation, OPERATIONS.DOCKER_COMPOSE_START);
  assert.deepEqual(claimed.envelope.payload, pinnedPayload());

  const completed = await registry.complete({
    serverId,
    jobId: queued.id,
    status: 'succeeded',
    result: successfulResult('start', 'running'),
  });
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.result, successfulResult('start', 'running'));
});

test('docker compose completion rejects results that drift from queued desired state', async () => {
  const registry = createJobRegistry();
  await registry.init();

  const queued = await registry.enqueue(queueInput(OPERATIONS.DOCKER_COMPOSE_PULL, {
    idempotencyKey: 'docker-compose-pull-0003',
  }));
  await registry.claimNext(serverId);

  await assert.rejects(
    registry.complete({
      serverId,
      jobId: queued.id,
      status: 'succeeded',
      result: {
        ...successfulResult('pull', null),
        composeSha256: 'b'.repeat(64),
      },
    }),
    (error) => error?.code === 'invalid_job_result'
      && /does not match the queued desired state/.test(error?.message ?? ''),
  );

  assert.equal((await registry.getJob(queued.id)).status, 'running');
});
