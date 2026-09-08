import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

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

  await assert.rejects(
    registry.complete({ serverId: 'server-1', jobId: job.id, status: 'succeeded' }),
    (error) => error instanceof JobRegistryError && error.code === 'job_not_running',
  );
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

test('failed job results keep only bounded safe error metadata', async () => {
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
      message: 'x'.repeat(1_000),
      stack: 'must never persist',
      secret: 'must never persist',
    },
  });

  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'nginx_config_invalid');
  assert.equal(failed.error.message.length, 500);
  assert.equal('stack' in failed.error, false);
  assert.equal('secret' in failed.error, false);
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
