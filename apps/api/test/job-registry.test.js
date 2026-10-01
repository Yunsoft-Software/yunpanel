import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createJobRegistry,
  isNewlyEnqueuedJob,
  jobPublicView,
  JobRegistryError,
  classifyJobError,
  isTransientJobError,
  isPermanentJobError,
  TRANSIENT_JOB_ERROR_CODES,
} from '../src/job-registry.js';

test('agent jobs move through queued, running and succeeded states exactly once', async () => {
  let clock = Date.parse('2026-09-08T21:00:00.000Z');
  const registry = createJobRegistry({ now: () => clock });

  const job = await registry.enqueue({
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'example.com',
      aliases: [],
      targetType: 'proxy',
      target: { upstreamPort: 3008 },
    },
    resourceType: 'domain',
    resourceId: 'domain-1',
  });

  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, 0);

  clock += 1_000;
  const claimed = await registry.claimNext('server-1');
  assert.equal(claimed.job.id, job.id);
  assert.equal(claimed.job.status, 'running');
  assert.equal(claimed.job.attempts, 1);
  assert.equal(claimed.envelope.operation, OPERATIONS.DOMAIN_STAGE);
  assert.equal(await registry.claimNext('server-1'), null);

  clock += 2_000;
  const completed = await registry.complete({
    serverId: 'server-1',
    jobId: job.id,
    status: 'succeeded',
    result: {
      checksum: 'a'.repeat(64),
      configName: 'yunpanel-example.com.conf',
      bytes: 512,
      unsafeExtra: 'ignored',
    },
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.checksum, 'a'.repeat(64));
  assert.equal(completed.result.configName, 'yunpanel-example.com.conf');
  assert.equal('unsafeExtra' in completed.result, false);

  const replayed = await registry.complete({
    serverId: 'server-1',
    jobId: job.id,
    status: 'succeeded',
    result: { checksum: 'f'.repeat(64), configName: 'ignored.conf', bytes: 1 },
  });
  assert.deepEqual(replayed, completed);

  await assert.rejects(
    registry.complete({ serverId: 'server-1', jobId: job.id, status: 'failed', error: { code: 'late_failure' } }),
    (error) => error instanceof JobRegistryError && error.code === 'job_already_completed',
  );
});

test('private Website provisioning authorization survives durable claim without entering public job views', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-auth-'));
  const filePath = path.join(directory, 'jobs.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authorization = {
    kind: 'website_provisioning',
    version: 1,
    operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16',
    websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
    stepId: 'domain_activation',
  };
  const input = {
    serverId: 'server-1',
    type: 'website.domain.activate',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example.com', checksum: 'b'.repeat(64) },
    resourceType: 'domain',
    resourceId: 'domain-1',
    idempotencyKey: 'website.domain.activate:test-operation',
    authorization,
  };
  const registry = createJobRegistry({ filePath });
  const queued = await registry.enqueue(input);
  assert.equal(Object.hasOwn(queued, 'authorization'), false);
  assert.doesNotMatch(JSON.stringify(queued), /website_provisioning|9ae512c0/);

  const reopened = createJobRegistry({ filePath });
  const claim = await reopened.claimNext('server-1');
  assert.equal(claim.job.id, queued.id);
  assert.equal(Object.hasOwn(claim.job, 'authorization'), false);
  assert.deepEqual(claim.authorization, authorization);
  assert.deepEqual(claim.envelope.payload, input.payload);
});

test('idempotent enqueue may add missing private provisioning authorization without changing work digest', async () => {
  const registry = createJobRegistry();
  const base = {
    serverId: 'server-1',
    type: 'website.domain.activate',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example.com', checksum: 'c'.repeat(64) },
    resourceType: 'domain',
    resourceId: 'domain-2',
    idempotencyKey: 'website.domain.activate:authorization-upgrade',
  };
  const first = await registry.enqueue(base);
  const second = await registry.enqueue({
    ...base,
    authorization: {
      kind: 'website_provisioning',
      version: 1,
      operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16',
      websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
      stepId: 'domain_activation',
    },
  });
  assert.equal(second.id, first.id);
  const claim = await registry.claimNext('server-1');
  assert.equal(claim.authorization.operationId, '9ae512c0-a717-4611-943c-6ce2ab0abf16');
});

test('idempotent enqueue safely requeues only provisioning auth-preflight failures', async () => {
  const authorization = {
    kind: 'website_provisioning',
    version: 1,
    operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16',
    websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
    stepId: 'domain_activation',
  };
  const input = {
    serverId: 'server-1',
    type: 'website.domain.activate',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example.com', checksum: 'd'.repeat(64) },
    resourceType: 'domain',
    resourceId: 'domain-auth-retry',
    idempotencyKey: 'website.domain.activate:auth-preflight-retry',
    authorization,
  };
  const registry = createJobRegistry();
  const queued = await registry.enqueue(input);
  const firstClaim = await registry.claimNext('server-1');
  assert.equal(firstClaim.job.id, queued.id);
  assert.equal(firstClaim.job.attempts, 1);
  const denied = await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'website_provisioning_job_actor_forbidden' },
  });
  assert.equal(denied.status, 'failed');
  assert.equal(denied.error.code, 'website_provisioning_job_actor_forbidden');

  const retried = await registry.enqueue(input);
  assert.equal(retried.id, queued.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.error, null);
  assert.equal(retried.finishedAt, null);
  assert.equal(retried.attempts, 1);
  const secondClaim = await registry.claimNext('server-1');
  assert.equal(secondClaim.job.id, queued.id);
  assert.equal(secondClaim.job.attempts, 2);
  assert.deepEqual(secondClaim.authorization, authorization);

  const other = createJobRegistry();
  const otherQueued = await other.enqueue({ ...input, resourceId: 'domain-real-failure', idempotencyKey: 'website.domain.activate:real-failure' });
  await other.claimNext('server-1');
  await other.complete({
    serverId: 'server-1',
    jobId: otherQueued.id,
    status: 'failed',
    error: { code: 'nginx_config_invalid' },
  });
  const unchanged = await other.enqueue({ ...input, resourceId: 'domain-real-failure', idempotencyKey: 'website.domain.activate:real-failure' });
  assert.equal(unchanged.status, 'failed');
  assert.equal(unchanged.error.code, 'nginx_config_invalid');
});

test('legacy unscoped provisioning failure upgrades in place on explicit authorized retry', async () => {
  const authorization = {
    kind: 'website_provisioning',
    version: 1,
    operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16',
    websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
    stepId: 'certificate',
  };
  const base = {
    serverId: 'server-1',
    type: 'website.ssl.issue:9ae512c0-a717-4611-943c-6ce2ab0abf16',
    operation: OPERATIONS.SSL_ISSUE,
    payload: { domains: ['example.com'], email: 'owner@example.com', staging: false },
    resourceType: 'certificate',
    resourceId: 'certificate-legacy',
    idempotencyKey: 'website.cert.issue:legacy:certificate',
  };
  const registry = createJobRegistry();
  const legacy = await registry.enqueue(base);
  const claimed = await registry.claimNext('server-1');
  assert.equal(claimed.job.id, legacy.id);
  assert.equal(claimed.authorization, null);
  const quarantined = await registry.complete({
    serverId: 'server-1',
    jobId: legacy.id,
    status: 'failed',
    error: { code: 'website_provisioning_job_authorization_required' },
  });
  assert.equal(quarantined.status, 'failed');
  assert.equal(quarantined.error.code, 'website_provisioning_job_authorization_required');

  const recovered = await registry.enqueue({ ...base, authorization });
  assert.equal(recovered.id, legacy.id);
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.error, null);
  assert.equal(recovered.attempts, 1);

  const retryClaim = await registry.claimNext('server-1');
  assert.equal(retryClaim.job.id, legacy.id);
  assert.equal(retryClaim.job.attempts, 2);
  assert.deepEqual(retryClaim.authorization, authorization);
});

test('DNS record jobs retain only provider-safe confirmed state', async () => {
  const registry = createJobRegistry();
  const payload = {
    provider: 'cloudflare',
    credentialId: '10714f5d-8646-4f9a-a8e9-b80439ff6305',
    dnsZoneId: '822fa920-166c-4a7a-a26b-476c81d82165',
    zoneName: 'example.test', action: 'upsert',
    record: { type: 'A', name: 'app.example.test', content: '203.0.113.10', ttl: 300, proxied: false },
    expectedSnapshotDigest: 'a'.repeat(64),
  };
  const job = await registry.enqueue({
    serverId: 'server-1', type: 'dns.record.apply', operation: OPERATIONS.DNS_RECORD_APPLY,
    payload, resourceType: 'dns_zone', resourceId: payload.dnsZoneId,
  });
  await registry.claimNext('server-1');
  const completed = await registry.complete({
    serverId: 'server-1', jobId: job.id, status: 'succeeded',
    result: {
      provider: 'cloudflare', action: 'upsert', zoneName: 'example.test', record: payload.record,
      changed: true, state: 'present', providerRecordId: 'must-not-persist', token: 'must-not-persist',
    },
  });
  assert.deepEqual(completed.result, {
    provider: 'cloudflare', action: 'upsert', zoneName: 'example.test', record: payload.record,
    changed: true, state: 'present',
  });
  assert.doesNotMatch(JSON.stringify(completed), /providerRecordId|token|must-not-persist/);
});

test('invalid successful result does not transition a running job', async () => {
  const registry = createJobRegistry();
  const job = await registry.enqueue({
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'example.com', aliases: [], targetType: 'proxy', target: { upstreamPort: 3008 } },
    resourceType: 'domain',
    resourceId: 'domain-1',
  });
  await registry.claimNext('server-1');

  await assert.rejects(
    registry.complete({
      serverId: 'server-1',
      jobId: job.id,
      status: 'succeeded',
      result: { checksum: '../invalid' },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );

  const unchanged = await registry.getJob(job.id);
  assert.equal(unchanged.status, 'running');
  assert.equal(unchanged.result, null);
});

test('failed job results keep only authored safe error metadata and actionable diagnosis', async () => {
  const registry = createJobRegistry();
  const job = await registry.enqueue({
    serverId: 'server-2',
    type: 'domain.activate',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example.com', checksum: 'b'.repeat(64) },
    resourceType: 'domain',
    resourceId: 'domain-2',
  });
  await registry.claimNext('server-2');

  const failed = await registry.complete({
    serverId: 'server-2',
    jobId: job.id,
    status: 'failed',
    error: {
      code: 'nginx_config_invalid',
      message: 'TOKEN=PRIVATE /etc/letsencrypt/live/example.com/privkey.pem',
      stack: 'must never persist',
      secret: 'must never persist',
    },
  });

  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'nginx_config_invalid');
  assert.equal(failed.error.message, 'Nginx rejected the staged configuration.');
  assert.equal('stack' in failed.error, false);
  assert.equal('secret' in failed.error, false);
  const publicView = jobPublicView(failed);
  assert.equal(publicView.diagnosis.code, 'nginx_config_invalid');
  assert.match(publicView.diagnosis.action, /stage a new revision/);
  assert.doesNotMatch(JSON.stringify(publicView), /PRIVATE|letsencrypt|privkey/);

  const legacyHostile = jobPublicView({
    ...failed,
    error: { code: 'token_deadbeef', message: 'PRIVATE /etc/letsencrypt/live/example.com/privkey.pem' },
  });
  assert.equal(legacyHostile.error.code, 'local_operation_failed');
  assert.equal(legacyHostile.diagnosis.code, 'nginx_operation_failed');
  assert.doesNotMatch(JSON.stringify(legacyHostile), /token_deadbeef|PRIVATE|letsencrypt|privkey/);
});

test('public certificate job results omit every managed material path', async () => {
  const registry = createJobRegistry();
  const job = await registry.enqueue({
    serverId: 'server-1', type: 'ssl.issue', operation: OPERATIONS.SSL_ISSUE,
    payload: { domains: ['example.com'], email: 'ops@example.com', staging: false },
    resourceType: 'certificate', resourceId: 'certificate-1',
  });
  await registry.claimNext('server-1');
  const completed = await registry.complete({
    serverId: 'server-1', jobId: job.id, status: 'succeeded',
    result: {
      certName: 'example.com', domains: ['example.com'], staging: false, status: 'issued',
      certificatePath: '/etc/letsencrypt/live/example.com/cert.pem',
      fullchainPath: '/etc/letsencrypt/live/example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
      validFrom: '2026-09-01T00:00:00.000Z', validTo: '2026-12-01T00:00:00.000Z',
      fingerprint256: Array.from({ length: 32 }, () => 'AA').join(':'),
      subject: 'token=PRIVATE',
    },
  });
  assert.equal(completed.result.privateKeyPath, '/etc/letsencrypt/live/example.com/privkey.pem');
  const view = jobPublicView(completed);
  assert.equal(view.result.certName, 'example.com');
  assert.equal(Object.hasOwn(view.result, 'certificatePath'), false);
  assert.equal(Object.hasOwn(view.result, 'fullchainPath'), false);
  assert.equal(Object.hasOwn(view.result, 'privateKeyPath'), false);
  assert.equal(view.result.subject, 'token=[REDACTED]');
  assert.doesNotMatch(JSON.stringify(view), /letsencrypt|privkey|PRIVATE/);
});

test('job registry only accepts explicitly supported async mutation operations', async () => {
  const registry = createJobRegistry();

  await assert.rejects(
    registry.enqueue({
      serverId: 'server-1',
      type: 'shell',
      operation: 'shell.exec',
      payload: { command: 'id' },
      resourceType: 'server',
      resourceId: 'server-1',
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_operation',
  );

  await assert.rejects(
    registry.enqueue({
      serverId: 'server-1',
      type: 'inspection',
      operation: OPERATIONS.SERVER_INSPECT,
      payload: {},
      resourceType: 'server',
      resourceId: 'server-1',
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_operation',
  );

  await assert.rejects(
    registry.enqueue({
      serverId: 'server-1',
      type: 'bad-domain-stage',
      operation: OPERATIONS.DOMAIN_STAGE,
      payload: { primaryDomain: 'example.com', targetType: 'proxy', target: null },
      resourceType: 'domain',
      resourceId: 'domain-1',
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_operation_payload',
  );
});

test('only queued jobs can be cancelled', async () => {
  const registry = createJobRegistry();
  const job = await registry.enqueue({
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'example.com', aliases: [], targetType: 'static', target: { root: '/var/www/example' } },
    resourceType: 'domain',
    resourceId: 'domain-1',
  });

  const cancelled = await registry.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(await registry.claimNext('server-1'), null);
});

test('active resource jobs are locked and durable idempotency keys replay only identical work', async () => {
  const registry = createJobRegistry();
  const input = {
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'example.com', aliases: [], targetType: 'static', target: { root: '/var/www/example' } },
    resourceType: 'domain',
    resourceId: 'domain-1',
    idempotencyKey: 'github:9d4a4727-1aba-4d35-95fe-21db67042ce9:12345678-1234-4234-9234-123456789012',
  };
  const created = await registry.enqueue(input);
  assert.equal(isNewlyEnqueuedJob(created), true);

  const found = await registry.findIdempotentJob(input);
  assert.equal(found.id, created.id);
  assert.equal(found.status, 'queued');
  assert.equal(JSON.stringify(found).includes(input.idempotencyKey), false);
  assert.equal(await registry.findIdempotentJob({
    ...input,
    idempotencyKey: 'github:missing-idempotency-key-1234567890',
  }), null);
  await assert.rejects(
    registry.findIdempotentJob({
      ...input,
      payload: { ...input.payload, primaryDomain: 'changed.example.com' },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'job_idempotency_conflict',
  );

  const replayed = await registry.enqueue(input);
  assert.equal(replayed.id, created.id);
  assert.equal(isNewlyEnqueuedJob(replayed), false);

  await assert.rejects(
    registry.enqueue({ ...input, idempotencyKey: null }),
    (error) => error instanceof JobRegistryError && error.code === 'domain_job_conflict',
  );
  await assert.rejects(
    registry.enqueue({ ...input, payload: { ...input.payload, primaryDomain: 'changed.example.com' } }),
    (error) => error instanceof JobRegistryError && error.code === 'job_idempotency_conflict',
  );

  const listed = await registry.listJobs();
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(input.idempotencyKey), false);
});

test('idempotent enqueue identity survives reopening the private job store', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-idempotency-'));
  const filePath = path.join(directory, 'jobs.json');
  const input = {
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'example.com', aliases: [], targetType: 'static', target: { root: '/var/www/example' } },
    resourceType: 'domain',
    resourceId: 'domain-1',
    idempotencyKey: 'github:9d4a4727-1aba-4d35-95fe-21db67042ce9:12345678-1234-4234-9234-123456789012',
  };
  try {
    const firstRegistry = createJobRegistry({ filePath });
    const first = await firstRegistry.enqueue(input);
    const reopened = createJobRegistry({ filePath });
    await reopened.init();
    const replayed = await reopened.enqueue(input);
    assert.equal(replayed.id, first.id);
    assert.equal(isNewlyEnqueuedJob(replayed), false);
    assert.equal((await reopened.listJobs()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('job registry enforces persistent retry budget and bounded backoff for preflight auth retries', async () => {
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  const authorization = {
    kind: 'website_provisioning',
    version: 1,
    operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16',
    websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
    stepId: 'domain_stage',
  };
  const input = {
    serverId: 'server-1',
    type: 'website.domain.stage:9ae512c0-a717-4611-943c-6ce2ab0abf16',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'example.com', aliases: [], targetType: 'proxy', target: { upstreamPort: 3000 } },
    resourceType: 'domain',
    resourceId: 'domain-retry-budget',
    idempotencyKey: 'website.domain.stage:auth-preflight-budget-test',
    authorization,
  };
  const registry = createJobRegistry({
    now: () => clock,
    retryBudget: 3,
    retryBackoffBaseMs: 1000,
    retryBackoffMaxMs: 4000,
  });

  const queued = await registry.enqueue(input);
  assert.equal(queued.status, 'queued');

  // Attempt 1: claim and fail with retryable preflight auth error
  const claim1 = await registry.claimNext('server-1');
  assert.equal(claim1.job.attempts, 1);
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'website_provisioning_job_actor_forbidden' },
  });

  // Retry 1 (attempts = 1 < 3): requeued with backoff
  clock += 500;
  const retry1 = await registry.enqueue(input);
  assert.equal(retry1.status, 'queued');
  assert.equal(retry1.attempts, 1);
  // Before backoff expires (delay = 1000ms, elapsed = 500ms), cannot be claimed yet
  assert.equal(await registry.claimNext('server-1'), null);

  // Advance time past backoff
  clock += 1000;
  const claim2 = await registry.claimNext('server-1');
  assert.equal(claim2.job.id, queued.id);
  assert.equal(claim2.job.attempts, 2);
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'website_provisioning_job_actor_forbidden' },
  });

  // Retry 2 (attempts = 2 < 3): requeued with exponential backoff (2000ms)
  const retry2 = await registry.enqueue(input);
  assert.equal(retry2.status, 'queued');
  assert.equal(retry2.attempts, 2);

  clock += 2500;
  const claim3 = await registry.claimNext('server-1');
  assert.equal(claim3.job.attempts, 3);
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'website_provisioning_job_actor_forbidden' },
  });

  // Retry 3 (attempts = 3 >= 3): persistent budget exhausted! Retains failure and does not requeue
  const exhausted = await registry.enqueue(input);
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.error.code, 'website_provisioning_job_actor_forbidden');
  assert.equal(exhausted.attempts, 3);
  assert.equal(await registry.claimNext('server-1'), null);
});

test('classifyJobError accurately distinguishes transient recoverable errors from permanent failures', () => {
  for (const code of TRANSIENT_JOB_ERROR_CODES) {
    assert.equal(isTransientJobError(code), true, `code ${code} should be transient`);
    assert.equal(isPermanentJobError(code), false, `code ${code} should not be permanent`);
    assert.equal(classifyJobError(code), 'transient');
    assert.equal(classifyJobError({ code }), 'transient');
  }

  // OS networking transient error codes
  for (const osCode of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EBUSY']) {
    assert.equal(isTransientJobError(osCode), true);
    assert.equal(classifyJobError(osCode), 'transient');
    assert.equal(classifyJobError(new Error(osCode)), 'transient');
  }

  // Permanent failure codes
  const permanentCodes = [
    'nginx_config_invalid',
    'invalid_domain_spec',
    'certbot_failed',
    'job_not_found',
    'job_status_conflict',
    'unknown_error',
  ];
  for (const code of permanentCodes) {
    assert.equal(isTransientJobError(code), false, `code ${code} should not be transient`);
    assert.equal(isPermanentJobError(code), true, `code ${code} should be permanent`);
    assert.equal(classifyJobError(code), 'permanent');
    assert.equal(classifyJobError({ code }), 'permanent');
  }
});

test('transient backend errors trigger automatic retry with bounded exponential backoff up to budget', async () => {
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  const input = {
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'transient.example.com', aliases: [], targetType: 'proxy', target: { upstreamPort: 3000 } },
    resourceType: 'domain',
    resourceId: 'domain-transient-1',
    idempotencyKey: 'transient-retry-test-key-1',
  };
  const registry = createJobRegistry({
    now: () => clock,
    retryBudget: 3,
    retryBackoffBaseMs: 1000,
    retryBackoffMaxMs: 4000,
  });

  const queued = await registry.enqueue(input);
  assert.equal(queued.status, 'queued');

  // Attempt 1: fails with transient error (dns_provider_rate_limited)
  const claim1 = await registry.claimNext('server-1');
  assert.equal(claim1.job.attempts, 1);
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'dns_provider_rate_limited' },
  });

  // Re-enqueue: transient error allows auto-retry; backoff delay is 1000ms
  clock += 400;
  const retry1 = await registry.enqueue(input);
  assert.equal(retry1.status, 'queued');
  assert.equal(retry1.attempts, 1);
  assert.equal(await registry.claimNext('server-1'), null, 'cannot claim before backoff expires');

  clock += 700; // total 1100ms elapsed >= 1000ms
  const claim2 = await registry.claimNext('server-1');
  assert.equal(claim2.job.id, queued.id);
  assert.equal(claim2.job.attempts, 2);

  // Attempt 2: fails with transient error (database_connection_unavailable)
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'database_connection_unavailable' },
  });

  // Re-enqueue: backoff is 2000ms
  clock += 1000;
  const retry2 = await registry.enqueue(input);
  assert.equal(retry2.status, 'queued');
  assert.equal(retry2.attempts, 2);
  assert.equal(await registry.claimNext('server-1'), null);

  clock += 1500; // 2500ms elapsed >= 2000ms
  const claim3 = await registry.claimNext('server-1');
  assert.equal(claim3.job.attempts, 3);

  // Attempt 3: fails with transient error (apt_update_failed)
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'apt_update_failed' },
  });

  // Re-enqueue: persistent budget (3) is exhausted! Job stays failed, not requeued
  const exhausted = await registry.enqueue(input);
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.retryExhausted, true);
  assert.equal(exhausted.attempts, 3);
  assert.equal(await registry.claimNext('server-1'), null);
});

test('permanent failures do NOT automatically retry regardless of attempt budget', async () => {
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  const input = {
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'permanent.example.com', aliases: [], targetType: 'proxy', target: { upstreamPort: 3000 } },
    resourceType: 'domain',
    resourceId: 'domain-perm-1',
    idempotencyKey: 'perm-no-retry-test-key-1',
  };
  const registry = createJobRegistry({
    now: () => clock,
    retryBudget: 5,
  });

  const queued = await registry.enqueue(input);
  const claim1 = await registry.claimNext('server-1');
  assert.equal(claim1.job.attempts, 1);

  // Fails with a permanent error code
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'nginx_config_invalid' },
  });

  // Re-enqueuing should NOT requeue even though attempts (1) < retryBudget (5)
  clock += 10000;
  const result = await registry.enqueue(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'nginx_config_invalid');
  assert.equal(result.attempts, 1);
  assert.equal(await registry.claimNext('server-1'), null, 'permanent failure must not be auto-reclaimed');
});

test('authorized users can initiate manual retry after automatic budget exhaustion without exceeding maxAttempts', async () => {
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  const authorization = {
    actorId: 'user-admin',
    role: 'site_manager',
    websiteId: 'website-1',
  };
  const input = {
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'manual-retry.example.com', aliases: [], targetType: 'proxy', target: { upstreamPort: 3000 } },
    resourceType: 'domain',
    resourceId: 'domain-manual-1',
    idempotencyKey: 'manual-retry-test-key-1',
    authorization,
  };
  const registry = createJobRegistry({
    now: () => clock,
    retryBudget: 2,
    maxAttempts: 3,
  });

  const queued = await registry.enqueue(input);
  // Attempt 1: fail transient
  const claim1 = await registry.claimNext('server-1');
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'dns_provider_rate_limited' },
  });

  // Auto-retry 1
  clock += 5000;
  await registry.enqueue(input);
  const claim2 = await registry.claimNext('server-1');
  assert.equal(claim2.job.attempts, 2);
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'dns_provider_rate_limited' },
  });

  // Auto-retry budget (2) exhausted: re-enqueue returns failed
  const exhausted = await registry.enqueue(input);
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.retryExhausted, true);

  // Unauthorized actor fails to manual retry
  await assert.rejects(
    registry.retryJob(queued.id, { authorization: { actorId: 'stranger', role: 'site_manager', websiteId: 'website-other' } }),
    (err) => err instanceof JobRegistryError && err.code === 'job_authorization_required' && err.status === 403,
  );

  // Authorized user initiates manual retry
  const manualRetried = await registry.retryJob(queued.id, { authorization });
  assert.equal(manualRetried.status, 'queued');
  assert.equal(manualRetried.manualRetry, true);
  assert.equal(manualRetried.retryExhausted, false);
  assert.equal(manualRetried.attempts, 2);

  // Can now be claimed
  const claim3 = await registry.claimNext('server-1');
  assert.equal(claim3.job.id, queued.id);
  assert.equal(claim3.job.attempts, 3);

  // Attempt 3 fails
  await registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'database_connection_unavailable' },
  });

  // maxAttempts (3) reached: further manual retry is rejected with 409 retry_limit_exceeded
  await assert.rejects(
    registry.retryJob(queued.id, { authorization }),
    (err) => err instanceof JobRegistryError && err.code === 'retry_limit_exceeded' && err.status === 409,
  );
  await assert.rejects(
    registry.manualRetry(queued.id, { authorization }),
    (err) => err instanceof JobRegistryError && err.code === 'retry_limit_exceeded' && err.status === 409,
  );
});

test('shared resource locking prevents concurrent retry when another job for the resource is active', async () => {
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  const authorization = { actorId: 'user-admin', role: 'owner' };
  const registry = createJobRegistry({ now: () => clock, maxAttempts: 5 });

  const jobA = await registry.enqueue({
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'lock-test.example.com', aliases: [], targetType: 'proxy', target: { upstreamPort: 3000 } },
    resourceType: 'domain',
    resourceId: 'domain-shared-lock',
    authorization,
  });

  // Claim and fail jobA
  await registry.claimNext('server-1');
  await registry.complete({
    serverId: 'server-1',
    jobId: jobA.id,
    status: 'failed',
    error: { code: 'dns_provider_rate_limited' },
  });

  // Enqueue a different jobB on the same resource which is now 'queued'
  const jobB = await registry.enqueue({
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'lock-test.example.com', aliases: [], targetType: 'proxy', target: { upstreamPort: 3001 } },
    resourceType: 'domain',
    resourceId: 'domain-shared-lock',
    authorization,
  });
  assert.equal(jobB.status, 'queued');

  // Attempting manual retry on jobA must reject with resource conflict (409 domain_job_conflict)
  await assert.rejects(
    registry.retryJob(jobA.id, { authorization }),
    (err) => err instanceof JobRegistryError && err.code === 'domain_job_conflict' && err.status === 409,
  );
});
