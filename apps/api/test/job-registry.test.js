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
