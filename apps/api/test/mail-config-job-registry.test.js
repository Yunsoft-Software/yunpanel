import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const MAIL_DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
const PREVIEW_DIGEST = 'a'.repeat(64);
const CONFIG_DIGEST = 'b'.repeat(64);
const PLAN_DIGEST = 'c'.repeat(64);
const READINESS_DIGEST = 'd'.repeat(64);

function payload() {
  return {
    mailDomainId: MAIL_DOMAIN_ID,
    expectedRevision: 1,
    desiredStatus: 'enabled',
    previewDigest: PREVIEW_DIGEST,
    configurationSha256: CONFIG_DIGEST,
  };
}

function result(overrides = {}) {
  return {
    version: 1,
    mailDomainId: MAIL_DOMAIN_ID,
    desiredStatus: 'enabled',
    previewDigest: PREVIEW_DIGEST,
    configurationSha256: CONFIG_DIGEST,
    planSha256: PLAN_DIGEST,
    readinessSha256: READINESS_DIGEST,
    applied: true,
    sideEffects: true,
    ...overrides,
  };
}

test('managed mail configuration jobs queue, claim and complete with a bounded result', async () => {
  const registry = createJobRegistry();
  const queued = await registry.enqueue({
    serverId: 'local-server',
    type: 'mail.config.apply',
    operation: OPERATIONS.MAIL_CONFIG_APPLY,
    payload: payload(),
    resourceType: 'mail_domain',
    resourceId: MAIL_DOMAIN_ID,
    idempotencyKey: `mail-config:${MAIL_DOMAIN_ID}:${PREVIEW_DIGEST}`,
  });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.resourceType, 'mail_domain');
  assert.equal(queued.operation, OPERATIONS.MAIL_CONFIG_APPLY);

  const claimed = await registry.claimNext('local-server');
  assert.equal(claimed.job.id, queued.id);
  assert.deepEqual(claimed.envelope.payload, payload());

  const completed = await registry.complete({
    serverId: 'local-server',
    jobId: queued.id,
    status: 'succeeded',
    result: result(),
  });
  assert.deepEqual(completed.result, result());
  assert.equal(JSON.stringify(completed).includes('password'), false);
  assert.equal(JSON.stringify(completed).includes('argon2'), false);
});

test('managed mail configuration result must match the queued transition exactly', async () => {
  for (const invalid of [
    result({ desiredStatus: 'disabled' }),
    result({ configurationSha256: 'e'.repeat(64) }),
    result({ previewDigest: 'f'.repeat(64) }),
    result({ planSha256: 'short' }),
    result({ applied: false }),
    result({ sideEffects: false }),
  ]) {
    const registry = createJobRegistry();
    const queued = await registry.enqueue({
      serverId: 'local-server',
      type: 'mail.config.apply',
      operation: OPERATIONS.MAIL_CONFIG_APPLY,
      payload: payload(),
      resourceType: 'mail_domain',
      resourceId: MAIL_DOMAIN_ID,
    });
    await registry.claimNext('local-server');
    await assert.rejects(
      registry.complete({ serverId: 'local-server', jobId: queued.id, status: 'succeeded', result: invalid }),
      (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
    );
  }
});
