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
    start: { mode: 'node', entryFile: 'dist/server.js', script: null },
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

async function queueStatus(registry) {
  return registry.enqueue({
    serverId: 'server-1',
    type: 'app.node.status',
    operation: OPERATIONS.APP_NODE_STATUS,
    payload: { applicationId: APPLICATION_ID, releaseId: RELEASE_ID, runtime: runtime() },
    resourceType: 'application',
    resourceId: APPLICATION_ID,
  });
}

test('Node status jobs persist only bounded process metadata', async () => {
  const registry = createJobRegistry();
  const job = await queueStatus(registry);
  await registry.claimNext('server-1');

  const completed = await registry.complete({
    serverId: 'server-1',
    jobId: job.id,
    status: 'succeeded',
    result: {
      releaseId: RELEASE_ID,
      serviceName: serviceName(),
      port: 3100,
      healthPath: '/health',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      restartCount: 2,
      mainPid: 4321,
      healthy: true,
      inspectionError: false,
      rawJournal: 'must not persist',
    },
  });

  assert.deepEqual(completed.result, {
    releaseId: RELEASE_ID,
    serviceName: serviceName(),
    port: 3100,
    healthPath: '/health',
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    restartCount: 2,
    mainPid: 4321,
    healthy: true,
    inspectionError: false,
  });
});

test('Node status jobs reject forged systemd state values', async () => {
  const registry = createJobRegistry();
  const job = await queueStatus(registry);
  await registry.claimNext('server-1');

  await assert.rejects(
    registry.complete({
      serverId: 'server-1',
      jobId: job.id,
      status: 'succeeded',
      result: {
        releaseId: RELEASE_ID,
        serviceName: serviceName(),
        port: 3100,
        healthPath: '/health',
        loadState: 'loaded; rm -rf /',
        activeState: 'active',
        subState: 'running',
        restartCount: 0,
        mainPid: 123,
        healthy: true,
        inspectionError: false,
      },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );

  assert.equal((await registry.getJob(job.id)).status, 'running');
});
