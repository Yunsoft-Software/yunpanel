import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDatabaseDeletionReceiptStore } from '../src/database-deletion-receipt.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { recoverRunningDatabaseDelete } from '../src/job-running-database-delete-recovery.js';
import { createJobRegistry } from '../src/job-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-delete-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobStore = path.join(root, 'jobs.json');
  const serverId = 'server-1';
  const databaseName = 'app_db';

  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId,
    type: OPERATIONS.DATABASE_DELETE,
    operation: OPERATIONS.DATABASE_DELETE,
    payload: { name: databaseName },
    resourceType: 'database',
    resourceId: databaseName,
  });
  const claimed = await first.claimNext(serverId);
  assert.equal(claimed.job.id, queued.id);
  assert.equal(claimed.envelope.payload.name, databaseName);

  const result = {
    engine: 'mariadb',
    version: '11.4.5-MariaDB',
    database: { name: databaseName, sizeBytes: 8192 },
    deleted: true,
  };
  const receiptStore = createDatabaseDeletionReceiptStore({ root: path.join(root, 'receipts') });
  await receiptStore.write({ serverId, jobId: queued.id, databaseName, result });

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);
  const contextReader = createJobRecoveryContextReader({ filePath: jobStore });

  return { serverId, databaseName, jobId: queued.id, result, jobRegistry: restarted, contextReader, receiptStore };
}

test('private delete receipt plus current absence closes the original durable job', async (t) => {
  const fx = await fixture(t);
  const publicJob = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(Object.hasOwn(publicJob, 'payload'), false);

  const recovered = await recoverRunningDatabaseDelete({
    serverId: fx.serverId,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    loadJobContext: (id) => fx.contextReader.read(id),
    readDeletionReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
    inspectDatabaseState: async () => ({
      engine: 'mariadb',
      version: '11.4.5-MariaDB',
      databases: [],
    }),
  });

  assert.equal(recovered.recoveryMethod, 'verified_database_deletion_receipt_and_absence');
  assert.equal(fx.jobRegistry.recovery(), null);
  assert.deepEqual(fx.jobRegistry.recoveryRecord().jobs, []);
  const terminal = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(terminal.status, 'succeeded');
  assert.deepEqual(terminal.result, fx.result);
});

test('recreated database keeps receipt-backed durable deletion unresolved', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    recoverRunningDatabaseDelete({
      serverId: fx.serverId,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      loadJobContext: (id) => fx.contextReader.read(id),
      readDeletionReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
      inspectDatabaseState: async () => ({
        engine: 'mariadb',
        version: '11.4.5-MariaDB',
        databases: [{ name: fx.databaseName, sizeBytes: 0 }],
      }),
    }),
    { code: 'job_database_delete_recovery_evidence_not_satisfied' },
  );

  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
});
