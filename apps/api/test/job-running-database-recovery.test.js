import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningDatabaseCreate } from '../src/job-running-database-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const databaseName = 'app_db';

function fixture({ operation = OPERATIONS.DATABASE_CREATE, databases = [{ name: databaseName, sizeBytes: 4096 }] } = {}) {
  const events = [];
  let status = 'running';
  const jobRegistry = {
    async getJob() {
      events.push('get');
      return { id: jobId, serverId, status, operation, resourceType: 'database', resourceId: databaseName };
    },
    async beginReconciliation() {
      events.push('begin');
      return { serverId, jobId, status: 'running', pending: true };
    },
    async complete(input) {
      events.push('complete');
      status = input.status;
      assert.deepEqual(input.result, {
        engine: 'mariadb',
        version: '11.4.5-MariaDB',
        database: { name: databaseName, sizeBytes: 4096 },
        created: true,
      });
      return { id: jobId, serverId, status, operation, resourceType: 'database', resourceId: databaseName, result: input.result };
    },
    async acknowledgeReconciliation() {
      events.push('ack');
      return { serverId, jobId, status: 'succeeded', acknowledged: true };
    },
  };

  return {
    events,
    options: {
      serverId,
      jobId,
      jobRegistry,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({
        jobs: [{ jobId, serverId, status: 'running', operation, resourceType: 'database', resourceId: databaseName }],
      }),
      loadJobContext: async () => {
        events.push('context');
        return { id: jobId, serverId, status: 'running', operation, resourceType: 'database', resourceId: databaseName, payload: { name: databaseName } };
      },
      inspectDatabaseState: async () => {
        events.push('evidence');
        return { engine: 'mariadb', version: '11.4.5-MariaDB', databases };
      },
      reconcile: async () => {
        events.push('reconcile');
        return { reconciled: true, error: null };
      },
    },
  };
}

test('database create recovery verifies exact persisted intent and host presence before journal', async () => {
  const fx = fixture();
  const result = await recoverRunningDatabaseCreate(fx.options);
  assert.equal(result.recoveryMethod, 'verified_database_presence');
  assert.deepEqual(fx.events, ['get', 'context', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
});

test('missing database presence leaves running recovery untouched', async () => {
  const fx = fixture({ databases: [] });
  await assert.rejects(recoverRunningDatabaseCreate(fx.options), { code: 'job_database_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'evidence']);
});

test('database delete cannot enter create recovery', async () => {
  const fx = fixture({ operation: OPERATIONS.DATABASE_DELETE });
  await assert.rejects(recoverRunningDatabaseCreate(fx.options), { code: 'job_database_recovery_job_mismatch' });
  assert.deepEqual(fx.events, []);
});

test('private database context mismatch is rejected before host inspection', async () => {
  const fx = fixture();
  fx.options.loadJobContext = async () => ({
    id: jobId,
    serverId,
    status: 'running',
    operation: OPERATIONS.DATABASE_CREATE,
    resourceType: 'database',
    resourceId: databaseName,
    payload: { name: 'other_db' },
  });
  await assert.rejects(recoverRunningDatabaseCreate(fx.options), { code: 'job_database_recovery_context_mismatch' });
  assert.deepEqual(fx.events, ['get']);
});

test('reconciliation failure keeps database completion journal open', async () => {
  const fx = fixture();
  fx.options.reconcile = async () => { fx.events.push('reconcile'); throw new Error('private socket /run/mysqld'); };
  await assert.rejects(
    recoverRunningDatabaseCreate(fx.options),
    (error) => error.code === 'job_database_recovery_reconciliation_failed' && !error.message.includes('/run/mysqld'),
  );
  assert.deepEqual(fx.events, ['get', 'context', 'evidence', 'begin', 'complete', 'reconcile']);
});
