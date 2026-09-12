import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const serverId = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const payload = Object.freeze({
  previewSha256: 'a'.repeat(64),
  configSha256: 'b'.repeat(64),
  fpmSha256: 'c'.repeat(64),
});

async function runningRoundcubeJob() {
  const registry = createJobRegistry();
  const job = await registry.enqueue({
    serverId,
    type: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
    operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
    payload,
    resourceType: 'server',
    resourceId: serverId,
  });
  const claimed = await registry.claimNext(serverId);
  return { registry, job, claimed };
}

test('Roundcube jobs enqueue, claim and complete with secret-free exact durable state', async () => {
  const { registry, job, claimed } = await runningRoundcubeJob();

  assert.equal(job.status, 'queued');
  assert.equal(claimed.job.status, 'running');
  assert.equal(claimed.envelope.operation, OPERATIONS.ROUNDCUBE_CONFIG_APPLY);
  assert.deepEqual(claimed.envelope.payload, payload);
  assert.equal(Object.keys(claimed.envelope.payload).length, 3);

  const completed = await registry.complete({
    serverId,
    jobId: job.id,
    status: 'succeeded',
    result: {
      version: 1,
      ...payload,
      nginxSha256: 'd'.repeat(64),
      databaseCreated: true,
      httpHealthy: true,
      applied: true,
      sideEffects: true,
    },
  });

  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.result, {
    version: 1,
    ...payload,
    nginxSha256: 'd'.repeat(64),
    databaseCreated: true,
    httpHealthy: true,
    applied: true,
    sideEffects: true,
  });
  assert.doesNotMatch(JSON.stringify(completed), /des_key|password|privateKey|configContent|fpmContent|nginxContent/i);
});

test('Roundcube completion fails closed on unhealthy, mismatched or secret-bearing result', async () => {
  for (const result of [
    {
      version: 1,
      ...payload,
      nginxSha256: 'd'.repeat(64),
      databaseCreated: true,
      httpHealthy: false,
      applied: true,
      sideEffects: true,
    },
    {
      version: 1,
      ...payload,
      configSha256: 'e'.repeat(64),
      nginxSha256: 'd'.repeat(64),
      databaseCreated: true,
      httpHealthy: true,
      applied: true,
      sideEffects: true,
    },
    {
      version: 1,
      ...payload,
      nginxSha256: 'd'.repeat(64),
      databaseCreated: true,
      httpHealthy: true,
      applied: true,
      sideEffects: true,
      desKey: 'must-not-persist',
    },
  ]) {
    const { registry, job } = await runningRoundcubeJob();
    await assert.rejects(
      registry.complete({ serverId, jobId: job.id, status: 'succeeded', result }),
      (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
    );
    const unchanged = await registry.getJob(job.id);
    assert.equal(unchanged.status, 'running');
    assert.equal(unchanged.result, null);
  }
});
