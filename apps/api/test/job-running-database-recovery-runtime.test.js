import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningDatabaseCreateRecoveryFromStores } from '../src/job-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'db-host';

test('database create recovery runtime binds exact host, private context and read-only DB inspection', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const result = await runRunningDatabaseCreateRecoveryFromStores({
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
    databaseManagerFactory: () => ({
      async inspect() {
        calls.push(['database.inspect']);
        return { engine: 'mysql', version: '8.4.0', databases: [{ name: 'app_db', sizeBytes: 1024 }] };
      },
      async createDatabase() { throw new Error('must not mutate'); },
      async dropDatabase() { throw new Error('must not mutate'); },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId, payload: { name: 'app_db' } });
      assert.deepEqual(await input.inspectDatabaseState(), {
        engine: 'mysql', version: '8.4.0', databases: [{ name: 'app_db', sizeBytes: 1024 }],
      });
      return { serverId, jobId, operation: 'database.create', status: 'succeeded', recoveryMethod: 'verified_database_presence', reconciled: true };
    },
  });

  assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['context.create', '/work/state/jobs.json'],
    ['context.read', jobId],
    ['database.inspect'],
  ]);
});

test('database create recovery refuses a different host before context or DB manager construction', async () => {
  let contextFactories = 0;
  let databaseFactories = 0;
  await assert.rejects(
    runRunningDatabaseCreateRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => { contextFactories += 1; return { read: async () => ({}) }; },
      databaseManagerFactory: () => { databaseFactories += 1; return { inspect: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(contextFactories, 0);
  assert.equal(databaseFactories, 0);
});
