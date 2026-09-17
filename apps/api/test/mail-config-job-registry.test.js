import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const MAIL_DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
const PREVIEW_DIGEST = 'a'.repeat(64);
const CONFIG_DIGEST = 'b'.repeat(64);
const PLAN_DIGEST = 'c'.repeat(64);
const READINESS_DIGEST = 'd'.repeat(64);
const BACKUP_DIGEST = 'e'.repeat(64);
const COMPENSATION_DIGEST = 'f'.repeat(64);

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
    version: 3,
    mailDomainId: MAIL_DOMAIN_ID,
    previousRevision: 1,
    previousStatus: 'disabled',
    desiredStatus: 'enabled',
    previewDigest: PREVIEW_DIGEST,
    configurationSha256: CONFIG_DIGEST,
    planSha256: PLAN_DIGEST,
    backupSha256: BACKUP_DIGEST,
    readinessSha256: READINESS_DIGEST,
    applied: true,
    sideEffects: true,
    ...overrides,
  };
}

function rollbackPayload() {
  return {
    mailDomainId: MAIL_DOMAIN_ID,
    sourceApplyJobId: 'mail-job-source-0001',
    previousRevision: 1,
    expectedCurrentRevision: 2,
    currentStatus: 'enabled',
    targetStatus: 'disabled',
    currentConfigurationSha256: CONFIG_DIGEST,
    sourcePlanSha256: PLAN_DIGEST,
    backupSha256: BACKUP_DIGEST,
    previewDigest: PREVIEW_DIGEST,
  };
}

function rollbackResult(overrides = {}) {
  return {
    version: 1,
    ...rollbackPayload(),
    compensationBackupSha256: COMPENSATION_DIGEST,
    restored: true,
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
    result({ backupSha256: 'short' }),
    result({ previousRevision: 2 }),
    result({ previousStatus: 'ready' }),
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

test('legacy managed mail result remains readable for pre-backup-binding recovery', async () => {
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
  const legacy = result({ version: 1 });
  delete legacy.backupSha256;
  delete legacy.previousRevision;
  delete legacy.previousStatus;

  const completed = await registry.complete({
    serverId: 'local-server', jobId: queued.id, status: 'succeeded', result: legacy,
  });
  assert.equal(completed.result.version, 1);
  assert.equal(Object.hasOwn(completed.result, 'backupSha256'), false);
});

test('backup-bound version two managed mail result remains readable without previous control-plane identity', async () => {
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
  const backupBound = result({ version: 2 });
  delete backupBound.previousRevision;
  delete backupBound.previousStatus;

  const completed = await registry.complete({
    serverId: 'local-server', jobId: queued.id, status: 'succeeded', result: backupBound,
  });
  assert.equal(completed.result.version, 2);
  assert.equal(completed.result.backupSha256, BACKUP_DIGEST);
  assert.equal(Object.hasOwn(completed.result, 'previousStatus'), false);
});

test('managed mail rollback result is exact, bounded and tied to its compensation snapshot', async () => {
  const registry = createJobRegistry();
  const queued = await registry.enqueue({
    serverId: 'local-server',
    type: OPERATIONS.MAIL_CONFIG_ROLLBACK,
    operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
    payload: rollbackPayload(),
    resourceType: 'mail_domain',
    resourceId: MAIL_DOMAIN_ID,
  });
  await registry.claimNext('local-server');
  const completed = await registry.complete({
    serverId: 'local-server', jobId: queued.id, status: 'succeeded', result: rollbackResult(),
  });
  assert.deepEqual(completed.result, rollbackResult());
  assert.doesNotMatch(JSON.stringify(completed), /password|content|path/i);
});

test('managed mail rollback result rejects payload drift, malformed evidence and expanded fields', async () => {
  for (const invalid of [
    rollbackResult({ targetStatus: 'enabled' }),
    rollbackResult({ backupSha256: 'a'.repeat(64) }),
    rollbackResult({ compensationBackupSha256: 'short' }),
    rollbackResult({ restored: false }),
    rollbackResult({ backupPath: '/forbidden' }),
  ]) {
    const registry = createJobRegistry();
    const queued = await registry.enqueue({
      serverId: 'local-server',
      type: OPERATIONS.MAIL_CONFIG_ROLLBACK,
      operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
      payload: rollbackPayload(),
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
