import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJobExecutor } from '../src/local-job-executor.js';

const serverId = 'server-1';
const jobId = 'job-00001';

function claim() {
  return {
    job: {
      id: jobId,
      serverId,
      status: 'running',
      operation: 'system.packages.inspect',
    },
    envelope: {
      id: jobId,
      operation: 'system.packages.inspect',
      payload: {},
    },
  };
}

function fixture({ beginError = null, acknowledgeError = null } = {}) {
  const events = [];
  const jobRegistry = {
    async claimNext(inputServerId) {
      events.push('claim');
      assert.equal(inputServerId, serverId);
      return claim();
    },
    async beginReconciliation(identity) {
      events.push('begin');
      assert.deepEqual(identity, { serverId, jobId });
      if (beginError) throw beginError;
      return { ...identity, status: 'running', pending: true };
    },
    async complete(input) {
      events.push('complete');
      assert.equal(input.serverId, serverId);
      assert.equal(input.jobId, jobId);
      return {
        id: jobId,
        serverId,
        status: input.status,
        operation: 'system.packages.inspect',
      };
    },
    async acknowledgeReconciliation(identity) {
      events.push('acknowledge');
      assert.deepEqual(identity, { serverId, jobId });
      if (acknowledgeError) throw acknowledgeError;
      return { ...identity, status: 'succeeded', acknowledged: true };
    },
  };
  const executor = createLocalJobExecutor({
    serverId,
    jobRegistry,
    executeOperation: async () => {
      events.push('execute');
      return { packages: [] };
    },
    reconcileCompletedJob: async (job) => {
      events.push('reconcile');
      assert.equal(job.id, jobId);
      return { reconciled: true };
    },
  });
  return { events, executor };
}

test('local executor journals after host execution and acknowledges only after reconciliation', async () => {
  const fx = fixture();
  const result = await fx.executor.runOnce();
  assert.equal(result.claimed, true);
  assert.equal(result.job.status, 'succeeded');
  assert.deepEqual(fx.events, ['claim', 'execute', 'begin', 'complete', 'reconcile', 'acknowledge']);
  assert.equal(fx.executor.failure(), null);
});

test('journal-open failure halts before terminal completion and never repeats the host operation', async () => {
  const fx = fixture({ beginError: new Error('recovery store unavailable SECRET=must-not-leak') });
  await assert.rejects(
    fx.executor.runOnce(),
    (error) => error.code === 'local_completion_unconfirmed' && error.phase === 'complete' && error.jobId === jobId,
  );
  assert.deepEqual(fx.events, ['claim', 'execute', 'begin']);
  assert.deepEqual(fx.executor.failure(), {
    code: 'local_completion_unconfirmed',
    message: 'Host execution ended but its saved result could not be confirmed. Do not repeat the host operation.',
    phase: 'complete',
    jobId,
  });
  await assert.rejects(fx.executor.runOnce(), { code: 'local_completion_unconfirmed' });
  assert.deepEqual(fx.events, ['claim', 'execute', 'begin']);
});

test('journal acknowledgement failure leaves terminal work in reconciliation fault state', async () => {
  const fx = fixture({ acknowledgeError: new Error('/private/path SECRET=must-not-leak') });
  await assert.rejects(
    fx.executor.runOnce(),
    (error) => error.code === 'local_reconciliation_failed' && error.phase === 'reconcile' && error.jobId === jobId,
  );
  assert.deepEqual(fx.events, ['claim', 'execute', 'begin', 'complete', 'reconcile', 'acknowledge']);
  await assert.rejects(fx.executor.runOnce(), { code: 'local_reconciliation_failed' });
  assert.equal(fx.events.filter((event) => event === 'execute').length, 1);
});

test('local executor rejects a half-wired durable reconciliation boundary', () => {
  assert.throws(
    () => createLocalJobExecutor({
      serverId,
      jobRegistry: {
        claimNext: async () => null,
        complete: async () => null,
        beginReconciliation: async () => null,
      },
      executeOperation: async () => null,
      reconcileCompletedJob: async () => null,
    }),
    /durable reconciliation boundary is incomplete/,
  );
});
