import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningDatabaseDelete } from '../src/job-running-database-delete-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const databaseName = 'app_db';
const receipt = Object.freeze({
  serverId,
  jobId,
  databaseName,
  result: {
    engine: 'mariadb',
    version: '11.4.5-MariaDB',
    database: { name: databaseName, sizeBytes: 4096 },
    deleted: true,
  },
});

function fixture({
  operation = OPERATIONS.DATABASE_DELETE,
  storedReceipt = receipt,
  databases = [],
  engine = 'mariadb',
} = {}) {
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
      assert.deepEqual(input.result, receipt.result);
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
      readDeletionReceipt: async () => {
        events.push('receipt');
        return storedReceipt;
      },
      inspectDatabaseState: async () => {
        events.push('evidence');
        return { engine, version: '11.4.5-MariaDB', databases };
      },
      reconcile: async () => {
        events.push('reconcile');
        return { reconciled: true, error: null };
      },
    },
  };
}

test('database delete recovery requires receipt and current absence before journal', async () => {
  const fx = fixture();
  const result = await recoverRunningDatabaseDelete(fx.options);
  assert.equal(result.recoveryMethod, 'verified_database_deletion_receipt_and_absence');
  assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
});

test('missing deletion receipt leaves running job untouched', async () => {
  const fx = fixture({ storedReceipt: null });
  await assert.rejects(recoverRunningDatabaseDelete(fx.options), { code: 'job_database_delete_recovery_receipt_missing' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt']);
});

test('database reappearing after receipt blocks deletion recovery', async () => {
  const fx = fixture({ databases: [{ name: databaseName, sizeBytes: 0 }] });
  await assert.rejects(recoverRunningDatabaseDelete(fx.options), { code: 'job_database_delete_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'evidence']);
});

test('database engine drift blocks receipt-backed deletion recovery', async () => {
  const fx = fixture({ engine: 'mysql' });
  await assert.rejects(recoverRunningDatabaseDelete(fx.options), { code: 'job_database_delete_recovery_engine_drift' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'evidence']);
});

test('database create cannot enter deletion recovery', async () => {
  const fx = fixture({ operation: OPERATIONS.DATABASE_CREATE });
  await assert.rejects(recoverRunningDatabaseDelete(fx.options), { code: 'job_database_delete_recovery_job_mismatch' });
  assert.deepEqual(fx.events, []);
});

test('receipt identity mismatch is rejected before host inspection', async () => {
  const fx = fixture({ storedReceipt: { ...receipt, databaseName: 'other_db' } });
  await assert.rejects(recoverRunningDatabaseDelete(fx.options), { code: 'job_database_delete_recovery_receipt_mismatch' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt']);
});
