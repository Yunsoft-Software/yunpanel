import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { runRunningDatabaseRestoreRecoveryFromStores } from '../src/job-running-database-restore-recovery-runtime.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const jobId = '22345678-1234-4234-8234-123456789012';
const hostname = 'host-1';

test('database restore recovery runtime verifies host identity before opening private receipt and live evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const receipt = { transactionId: jobId };
  const backup = { backupId: 'backup-0001' };
  const live = { databaseName: 'app_main' };

  const result = await runRunningDatabaseRestoreRecoveryFromStores({
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
      async getServer(id) { return { id, hostname }; },
    }),
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => {
      calls.push(['durable.create', filePath]);
      return fakeJobRegistry;
    },
    contextReaderFactory: ({ filePath }) => ({
      async read(id) { calls.push(['context.read', filePath, id]); return { id }; },
    }),
    databaseDumpManagerFactory: () => ({
      async inspectBackup(id) { calls.push(['backup.inspect', id]); return backup; },
    }),
    restoreReceiptStoreFactory: () => ({
      async read(id) { calls.push(['receipt.read', id]); return receipt; },
    }),
    restoreEvidenceInspectorFactory: () => ({
      async inspectLive(input) { calls.push(['live.inspect', input]); return live; },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId });
      assert.equal(await input.readRestoreReceipt(jobId), receipt);
      assert.equal(await input.inspectBackup('backup-0001'), backup);
      assert.equal(await input.inspectLive({ databaseName: 'app_main', engine: 'mariadb' }), live);
      return {
        serverId,
        jobId,
        operation: OPERATIONS.DATABASE_RESTORE,
        status: 'succeeded',
        recoveryMethod: 'verified_database_restore_receipt_backups_and_live_digest',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.statePaths.jobStore, '/work/state/jobs.json');
  assert.ok(calls.some(([name]) => name === 'receipt.read'));
  assert.ok(calls.some(([name]) => name === 'backup.inspect'));
  assert.ok(calls.some(([name]) => name === 'live.inspect'));
});

test('wrong host is rejected before database restore private evidence providers are constructed', async () => {
  let privateStateOpened = 0;
  await assert.rejects(
    runRunningDatabaseRestoreRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({
        async init() {},
        async getServer() { return { id: serverId, hostname: 'other-host' }; },
      }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => ({ read: async () => ({}) }),
      databaseDumpManagerFactory: () => {
        privateStateOpened += 1;
        return { inspectBackup: async () => null };
      },
      restoreReceiptStoreFactory: () => {
        privateStateOpened += 1;
        return { read: async () => null };
      },
      restoreEvidenceInspectorFactory: () => {
        privateStateOpened += 1;
        return { inspectLive: async () => null };
      },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(privateStateOpened, 0);
});
