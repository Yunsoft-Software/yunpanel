import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import {
  jobReconciliationInternals,
  JobReconciliationError,
  reconcileCompletedJob,
} from '../src/job-reconciliation.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-reconciliation-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'jobs.json');
}

async function failedDomainJob(registry) {
  const queued = await registry.enqueue({
    serverId: 'server-1',
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'failure.example.com',
      aliases: [],
      targetType: 'static',
      target: { root: '/var/www/failure' },
    },
    resourceType: 'domain',
    resourceId: 'domain-1',
  });
  const claimed = await registry.claimNext('server-1');
  assert.equal(claimed.job.id, queued.id);
  return registry.complete({
    serverId: 'server-1',
    jobId: queued.id,
    status: 'failed',
    error: { code: 'host_operation_failed', message: 'Host operation failed' },
  });
}

test('reconciliation failures throw a safe control-plane error and keep durable recovery pending', async (t) => {
  const registry = createDurableJobRegistry({
    filePath: await fixture(t),
    registryFactory: createJobRegistry,
    automaticReconciliation: true,
  });
  await registry.init();
  const job = await failedDomainJob(registry);
  let attempts = 0;
  const failingDomainRegistry = {
    async markFailed() {
      attempts += 1;
      const error = new Error('SECRET=/private/path must-not-leak');
      error.code = 'SECRET=/private/path';
      throw error;
    },
  };

  await assert.rejects(
    reconcileCompletedJob({
      domainRegistry: failingDomainRegistry,
      certificateRegistry: {},
      applicationRegistry: {},
      job,
    }),
    (error) => error instanceof JobReconciliationError
      && error.code === 'reconcile_failed'
      && error.message === 'Completed job reconciliation failed'
      && !error.message.includes('SECRET')
      && !error.message.includes('/private/path'),
  );
  assert.equal(attempts, 2);
  assert.deepEqual(registry.recoveryRecord().jobs, [{ jobId: job.id, serverId: 'server-1' }]);

  const recovered = await reconcileCompletedJob({
    domainRegistry: { async markFailed() {} },
    certificateRegistry: {},
    applicationRegistry: {},
    job,
  });
  assert.deepEqual(recovered, { reconciled: true, error: null });
  assert.equal(registry.recovery(), null);
});

test('reconciliation error codes accept only bounded diagnostic identifiers', () => {
  assert.equal(jobReconciliationInternals.safeReconciliationCode({ code: 'domain_write_failed' }), 'reconcile_domain_write_failed');
  assert.equal(jobReconciliationInternals.safeReconciliationCode({ code: 'SECRET=/private/path' }), 'reconcile_failed');
  assert.equal(jobReconciliationInternals.safeReconciliationCode({ code: 'x'.repeat(81) }), 'reconcile_failed');
  assert.equal(jobReconciliationInternals.safeReconciliationCode(new Error('SECRET')), 'reconcile_failed');
});
