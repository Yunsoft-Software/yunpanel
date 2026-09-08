import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const RELEASE_ID = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

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

async function queuedRestart(registry) {
  return registry.enqueue({
    serverId: 'server-1',
    type: 'app.node.restart',
    operation: OPERATIONS.APP_NODE_RESTART,
    payload: { applicationId: APPLICATION_ID, releaseId: RELEASE_ID, runtime: runtime() },
    resourceType: 'application',
    resourceId: APPLICATION_ID,
  });
}

test('Node restart jobs persist only validated managed service state', async () => {
  const registry = createJobRegistry();
  const job = await queuedRestart(registry);
  const claimed = await registry.claimNext('server-1');

  assert.equal(claimed.envelope.operation, OPERATIONS.APP_NODE_RESTART);
  assert.equal(claimed.envelope.payload.releaseId, RELEASE_ID);

  const completed = await registry.complete({
    serverId: 'server-1',
    jobId: job.id,
    status: 'succeeded',
    result: {
      releaseId: RELEASE_ID,
      serviceName: serviceName(),
      port: 3100,
      healthPath: '/health',
      healthy: true,
      restarted: true,
      ignored: 'not persisted',
    },
  });

  assert.deepEqual(completed.result, {
    releaseId: RELEASE_ID,
    serviceName: serviceName(),
    port: 3100,
    healthPath: '/health',
    healthy: true,
    restarted: true,
  });
});

test('Node restart jobs reject forged release results', async () => {
  const registry = createJobRegistry();
  const job = await queuedRestart(registry);
  await registry.claimNext('server-1');

  await assert.rejects(
    registry.complete({
      serverId: 'server-1',
      jobId: job.id,
      status: 'succeeded',
      result: {
        releaseId: 'ff830043-9752-4640-83b4-3a1998de78a0',
        serviceName: serviceName(),
        port: 3100,
        healthPath: '/health',
        healthy: true,
        restarted: true,
      },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );

  assert.equal((await registry.getJob(job.id)).status, 'running');
});
