import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const TARGET_RELEASE = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const CURRENT_RELEASE = 'ff830043-9752-4640-83b4-3a1998de78a0';

function runtime() {
  return {
    nodeMajor: 24,
    installMode: 'ci',
    buildScript: 'build',
    startMode: 'node',
    entryFile: 'dist/server.js',
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 10,
    restartPolicy: 'on-failure',
  };
}

function serviceName() {
  const digest = createHash('sha256').update(APPLICATION_ID).digest('hex').slice(0, 16);
  return `yunpanel-node-${digest}.service`;
}

async function queuedRollback(registry) {
  return registry.enqueue({
    serverId: 'server-1',
    type: 'app.node.rollback',
    operation: OPERATIONS.APP_NODE_ROLLBACK,
    payload: { applicationId: APPLICATION_ID, releaseId: TARGET_RELEASE, runtime: runtime() },
    resourceType: 'application',
    resourceId: APPLICATION_ID,
  });
}

test('Node rollback jobs preserve only validated managed service state', async () => {
  const registry = createJobRegistry();
  const job = await queuedRollback(registry);
  const claimed = await registry.claimNext('server-1');

  assert.equal(claimed.envelope.operation, OPERATIONS.APP_NODE_ROLLBACK);
  assert.equal(claimed.envelope.payload.releaseId, TARGET_RELEASE);

  const completed = await registry.complete({
    serverId: 'server-1',
    jobId: job.id,
    status: 'succeeded',
    result: {
      releaseId: TARGET_RELEASE,
      previousReleaseId: CURRENT_RELEASE,
      serviceName: serviceName(),
      port: 3100,
      healthPath: '/health',
      healthy: true,
      active: true,
      secret: 'ignored',
    },
  });

  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.result, {
    releaseId: TARGET_RELEASE,
    previousReleaseId: CURRENT_RELEASE,
    serviceName: serviceName(),
    port: 3100,
    healthPath: '/health',
    healthy: true,
    active: true,
  });
});

test('Node rollback jobs reject forged service identities without completing the job', async () => {
  const registry = createJobRegistry();
  const job = await queuedRollback(registry);
  await registry.claimNext('server-1');

  await assert.rejects(
    registry.complete({
      serverId: 'server-1',
      jobId: job.id,
      status: 'succeeded',
      result: {
        releaseId: TARGET_RELEASE,
        previousReleaseId: CURRENT_RELEASE,
        serviceName: 'yunpanel-node-0000000000000000.service',
        port: 3100,
        healthPath: '/health',
        healthy: true,
        active: true,
      },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );

  const unchanged = await registry.getJob(job.id);
  assert.equal(unchanged.status, 'running');
  assert.equal(unchanged.result, null);
});
