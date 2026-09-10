import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningDatabaseDeleteRecoveryFromStores } from '../src/job-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'db-host';

test('database delete recovery runtime binds private context, receipt and read-only DB state', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const result = await runRunningDatabaseDeleteRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname }; },
    }),
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => {
      calls.push(['context.create', filePath]);
      return { async read(id) { calls.push(['context.read', id]); return { id, payload: { name: 'app_db' } }; } };
    },
    deletionReceiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) {
        calls.push(['receipt.read', receiptServerId, receiptJobId]);
        return { serverId, jobId, databaseName: 'app_db', result: { deleted: true } };
      },
    }),
    databaseManagerFactory: () => ({
      async inspect() {
        calls.push(['database.inspect']);
        return { engine: 'mariadb', version: '11.4.5-MariaDB', databases: [] };
      },
      async dropDatabase() { throw new Error('must not mutate'); },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId, payload: { name: 'app_db' } });
      assert.deepEqual(await input.readDeletionReceipt(serverId, jobId), {
        serverId, jobId, databaseName: 'app_db', result: { deleted: true },
      });
      assert.deepEqual(await input.inspectDatabaseState(), {
        engine: 'mariadb', version: '11.4.5-MariaDB', databases: [],
      });
      return {
        serverId,
        jobId,
        operation: 'database.delete',
        status: 'succeeded',
        recoveryMethod: 'verified_database_deletion_receipt_and_absence',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['context.create', '/work/state/jobs.json'],
    ['context.read', jobId],
    ['receipt.read', serverId, jobId],
    ['database.inspect'],
  ]);
});

test('database delete recovery rejects wrong host before context, receipt or DB inspection factories', async () => {
  let contextFactories = 0;
  let receiptFactories = 0;
  let databaseFactories = 0;
  await assert.rejects(
    runRunningDatabaseDeleteRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => { contextFactories += 1; return { read: async () => ({}) }; },
      deletionReceiptStoreFactory: () => { receiptFactories += 1; return { read: async () => ({}) }; },
      databaseManagerFactory: () => { databaseFactories += 1; return { inspect: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(contextFactories, 0);
  assert.equal(receiptFactories, 0);
  assert.equal(databaseFactories, 0);
});
