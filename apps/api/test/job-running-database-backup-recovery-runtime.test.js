import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { runRunningDatabaseBackupRecoveryFromStores } from '../src/job-running-database-backup-recovery-runtime.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const jobId = '22345678-1234-4234-8234-123456789012';
const hostname = 'host-1';

test('database backup recovery runtime verifies host identity before reading private backup evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const evidence = {
    version: 1,
    backupId: jobId,
    databaseName: 'app_main',
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: 'a'.repeat(64),
    dumpBytes: 1024,
    createdAt: '2026-09-13T04:00:00.000Z',
    backedUp: true,
    sideEffects: true,
  };

  const result = await runRunningDatabaseBackupRecoveryFromStores({
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
      async inspectBackup(id) { calls.push(['backup.inspect', id]); return evidence; },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId });
      assert.equal(await input.inspectBackup(jobId), evidence);
      return {
        serverId,
        jobId,
        operation: OPERATIONS.DATABASE_BACKUP,
        status: 'succeeded',
        recoveryMethod: 'verified_private_database_backup_artifact',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.statePaths.jobStore, '/work/state/jobs.json');
  assert.ok(calls.some(([name]) => name === 'backup.inspect'));
});

test('wrong host is rejected before the database backup evidence provider is constructed', async () => {
  let privateStateOpened = 0;
  await assert.rejects(
    runRunningDatabaseBackupRecoveryFromStores({
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
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(privateStateOpened, 0);
});
