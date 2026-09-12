import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const serverId = randomUUID();
const mailDomainId = randomUUID();
const previewDigest = 'a'.repeat(64);
const configurationSha256 = 'b'.repeat(64);
const payload = Object.freeze({
  mailDomainId,
  expectedKeyRevision: 3,
  previewDigest,
  configurationSha256,
});

function enqueue(registry) {
  return registry.enqueue({
    serverId,
    type: OPERATIONS.MAIL_DKIM_APPLY,
    operation: OPERATIONS.MAIL_DKIM_APPLY,
    payload,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
  });
}

test('durable job registry admits, claims and completes managed DKIM apply with exact secret-free result', async () => {
  const registry = createJobRegistry();
  await registry.init();
  const queued = await enqueue(registry);
  assert.equal(queued.operation, OPERATIONS.MAIL_DKIM_APPLY);
  assert.equal(queued.status, 'queued');

  const claimed = await registry.claimNext(serverId);
  assert.equal(claimed.job.id, queued.id);
  assert.equal(claimed.envelope.operation, OPERATIONS.MAIL_DKIM_APPLY);
  assert.deepEqual(claimed.envelope.payload, payload);

  const completed = await registry.complete({
    serverId,
    jobId: queued.id,
    status: 'succeeded',
    result: {
      version: 1,
      mailDomainId,
      expectedKeyRevision: 3,
      previewDigest,
      configurationSha256,
      applied: true,
      sideEffects: true,
    },
  });
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.result, {
    version: 1,
    mailDomainId,
    expectedKeyRevision: 3,
    previewDigest,
    configurationSha256,
    applied: true,
    sideEffects: true,
  });
  assert.doesNotMatch(JSON.stringify(completed), /PRIVATE KEY|password|token/i);
});

test('managed DKIM completion rejects stale identity and leaves the running job unresolved', async () => {
  const registry = createJobRegistry();
  await registry.init();
  const queued = await enqueue(registry);
  await registry.claimNext(serverId);

  await assert.rejects(
    registry.complete({
      serverId,
      jobId: queued.id,
      status: 'succeeded',
      result: {
        version: 1,
        mailDomainId,
        expectedKeyRevision: 4,
        previewDigest,
        configurationSha256,
        applied: true,
        sideEffects: true,
      },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );
  assert.equal((await registry.getJob(queued.id)).status, 'running');
});
