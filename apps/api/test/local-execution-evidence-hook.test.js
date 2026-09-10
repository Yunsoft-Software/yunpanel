import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJobExecutor } from '../src/local-job-executor.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

function fixture({ executeError = null, evidenceError = null } = {}) {
  const events = [];
  let claimed = false;
  const jobRegistry = {
    async claimNext() {
      if (claimed) return null;
      claimed = true;
      events.push('claim');
      return {
        job: {
          id: jobId,
          serverId,
          status: 'running',
          operation: 'database.delete',
          resourceType: 'database',
          resourceId: 'app_db',
        },
        envelope: { id: jobId, operation: 'database.delete', payload: { name: 'app_db' } },
      };
    },
    async beginReconciliation() {
      events.push('begin');
      return { serverId, jobId, status: 'running', pending: true };
    },
    async complete(input) {
      events.push(['complete', input.status]);
      return {
        id: jobId,
        serverId,
        status: input.status,
        operation: 'database.delete',
        resourceType: 'database',
        resourceId: 'app_db',
        result: input.result ?? null,
        error: input.error ?? null,
      };
    },
    async acknowledgeReconciliation() {
      events.push('ack');
      return { serverId, jobId, status: executeError ? 'failed' : 'succeeded', acknowledged: true };
    },
  };
  const executor = createLocalJobExecutor({
    serverId,
    jobRegistry,
    executeOperation: async () => {
      events.push('execute');
      if (executeError) throw executeError;
      return {
        engine: 'mariadb',
        version: '11.4.5-MariaDB',
        database: { name: 'app_db', sizeBytes: 4096 },
        deleted: true,
      };
    },
    recordExecutionEvidence: async (input) => {
      events.push('evidence');
      assert.equal(input.jobId, jobId);
      assert.equal(input.resourceType, 'database');
      assert.equal(input.resourceId, 'app_db');
      assert.deepEqual(input.payload, { name: 'app_db' });
      input.payload.name = 'mutated-copy';
      if (evidenceError) throw evidenceError;
    },
    reconcileCompletedJob: async () => { events.push('reconcile'); return { reconciled: true }; },
  });
  return { executor, events };
}

test('successful host execution records evidence before durable completion', async () => {
  const fx = fixture();
  const result = await fx.executor.runOnce();
  assert.equal(result.job.status, 'succeeded');
  assert.deepEqual(fx.events, ['claim', 'execute', 'evidence', 'begin', ['complete', 'succeeded'], 'reconcile', 'ack']);
});

test('evidence recorder failure does not strand a successful host operation', async () => {
  const fx = fixture({ evidenceError: new Error('receipt disk full') });
  const result = await fx.executor.runOnce();
  assert.equal(result.job.status, 'succeeded');
  assert.equal(fx.executor.failure(), null);
  assert.deepEqual(fx.events, ['claim', 'execute', 'evidence', 'begin', ['complete', 'succeeded'], 'reconcile', 'ack']);
});

test('failed host execution never records success evidence', async () => {
  const error = Object.assign(new Error('drop failed'), { code: 'database_drop_failed' });
  const fx = fixture({ executeError: error });
  const result = await fx.executor.runOnce();
  assert.equal(result.job.status, 'failed');
  assert.deepEqual(fx.events, ['claim', 'execute', 'begin', ['complete', 'failed'], 'reconcile', 'ack']);
});
