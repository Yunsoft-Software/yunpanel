import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry } from '../src/job-registry.js';
import { createLocalJobExecutor } from '../src/local-job-executor.js';

const serverId = 'local-server';
const packageResult = {
  packageName: 'yunpanel',
  installed: false,
  installedVersion: null,
  candidateVersion: null,
  updateAvailable: false,
};

function executorFor(jobRegistry, supportsOperation, calls = []) {
  return createLocalJobExecutor({
    serverId,
    jobRegistry,
    supportsOperation,
    executeOperation: async (operation, payload) => {
      calls.push({ operation, payload });
      return packageResult;
    },
    reconcileCompletedJob: async () => ({ reconciled: true }),
  });
}

test('local executor leaves an unmigrated head operation queued without incrementing attempts', async () => {
  const jobRegistry = createJobRegistry();
  const legacy = await jobRegistry.enqueue({
    serverId,
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'example.com',
      aliases: [],
      targetType: 'proxy',
      target: { upstreamPort: 3000 },
    },
    resourceType: 'domain',
    resourceId: 'domain-1',
  });
  const local = await jobRegistry.enqueue({
    serverId,
    type: 'system.packages.inspect',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId: serverId,
  });
  const calls = [];
  const executor = executorFor(jobRegistry, (operation) => operation === OPERATIONS.SYSTEM_PACKAGES_INSPECT, calls);

  await assert.rejects(
    executor.runOnce(),
    (error) => error.code === 'local_operation_not_migrated' && error.phase === 'select' && error.jobId === legacy.id,
  );
  assert.equal(executor.failure(), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(
    (await jobRegistry.listJobs({ serverId })).map(({ id, status, attempts }) => ({ id, status, attempts })),
    [
      { id: legacy.id, status: 'queued', attempts: 0 },
      { id: local.id, status: 'queued', attempts: 0 },
    ],
  );

  await jobRegistry.cancel(legacy.id);
  const completed = await executor.runOnce();
  assert.equal(completed.claimed, true);
  assert.equal(completed.job.id, local.id);
  assert.equal(completed.job.status, 'succeeded');
  assert.equal(calls.length, 1);
});

test('operation selection validates the claimed identity before host execution', async () => {
  let executions = 0;
  const executor = createLocalJobExecutor({
    serverId,
    supportsOperation: (operation) => operation === OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    jobRegistry: {
      listJobs: async () => [{
        id: 'expected-job-123',
        serverId,
        status: 'queued',
        operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
      }],
      claimNext: async () => ({
        job: {
          id: 'another-job-1234',
          serverId,
          status: 'running',
          operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
        },
        envelope: {
          id: 'another-job-1234',
          operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
          payload: {},
        },
      }),
      complete: async () => { throw new Error('must not complete'); },
    },
    executeOperation: async () => { executions += 1; return packageResult; },
    reconcileCompletedJob: async () => ({ reconciled: true }),
  });

  await assert.rejects(executor.runOnce(), { code: 'local_claim_invalid', phase: 'execute' });
  assert.equal(executions, 0);
  assert.equal(executor.failure()?.code, 'local_claim_invalid');
});

test('operation selection requires queue listing and accepts only an explicit selector function', () => {
  const base = {
    serverId,
    jobRegistry: { claimNext: async () => null, complete: async () => null },
    executeOperation: async () => packageResult,
    reconcileCompletedJob: async () => ({ reconciled: true }),
  };
  assert.throws(() => createLocalJobExecutor({ ...base, supportsOperation: true }), /selector must be a function/);
  assert.throws(() => createLocalJobExecutor({ ...base, supportsOperation: () => true }), /requires job listing/);
});
