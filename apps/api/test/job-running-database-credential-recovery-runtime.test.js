import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { runRunningDatabaseCredentialRecoveryFromStores } from '../src/job-running-database-credential-recovery-runtime.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const jobId = 'database-credential-job-0001';
const hostname = 'host-1';
const credentialId = '22345678-1234-4234-8234-123456789012';
const bindingId = '32345678-1234-4234-8234-123456789012';
const desired = 'a'.repeat(64);

function registry(calls, label, extra = {}) {
  return ({ filePath }) => ({
    async init() { calls.push([`${label}.init`, filePath]); },
    ...extra,
  });
}

test('database credential recovery runtime reconstructs current public desired state and live evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const fakeBindingRegistry = {
    async init() { calls.push(['binding.init']); },
    async getBinding(id) { return { id, serverId, databaseName: 'app_main', websiteId: 'w', applicationId: 'a', unixUser: 'yunapp-0123456789ab', revision: 2 }; },
  };
  const fakeCredentialRegistry = {
    async init() { calls.push(['credential.init']); },
    async getCredential(id) { return { id, databaseBindingId: bindingId, serverId, databaseName: 'app_main', websiteId: 'w', applicationId: 'a', siteUnixUser: 'yunapp-0123456789ab', username: 'ydb_0123456789abcdef01234567', host: 'localhost', privileges: ['SELECT'], revision: 3, passwordUpdatedAt: '2026-09-13T03:00:00.000Z' }; },
    async materializeCredential() { throw new Error('recovery must not open secret material'); },
  };
  const materialized = {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 2,
    desiredStateSha256: desired,
    databaseName: 'app_main',
    username: 'ydb_0123456789abcdef01234567',
    host: 'localhost',
    privileges: ['SELECT'],
  };

  const result = await runRunningDatabaseCredentialRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
      YUNPANEL_APPLICATION_STORE: '/work/state/applications.json',
      YUNPANEL_WEBSITE_STORE: '/work/state/websites.json',
      YUNPANEL_DOCKER_WORKLOAD_STORE: '/work/state/docker.json',
      YUNPANEL_DATABASE_BINDING_STORE: '/work/state/db-bindings.json',
      YUNPANEL_DATABASE_CREDENTIAL_STORE: '/work/state/db-credentials.json',
      YUNPANEL_SECRET_MASTER_KEY: '11'.repeat(32),
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { return { id, hostname }; },
    }),
    applicationRegistryFactory: registry(calls, 'application', { async getApplication(id) { return { id, serverId, type: 'node' }; } }),
    dockerWorkloadRegistryFactory: registry(calls, 'docker', { async getWorkload() { return null; } }),
    websiteRegistryFactory: registry(calls, 'website', { async getWebsite(id) { return { id }; } }),
    databaseBindingRegistryFactory: ({ filePath, serverExists, getWebsite, getApplication }) => {
      calls.push(['binding.create', filePath]);
      assert.equal(typeof serverExists, 'function');
      assert.equal(typeof getWebsite, 'function');
      assert.equal(typeof getApplication, 'function');
      return fakeBindingRegistry;
    },
    databaseCredentialRegistryFactory: ({ filePath, masterKey, getDatabaseBinding }) => {
      calls.push(['credential.create', filePath, masterKey]);
      assert.equal(typeof getDatabaseBinding, 'function');
      return fakeCredentialRegistry;
    },
    materializerFactory: ({ databaseBindingRegistry, databaseCredentialRegistry }) => {
      assert.equal(databaseBindingRegistry, fakeBindingRegistry);
      assert.equal(databaseCredentialRegistry, fakeCredentialRegistry);
      return {
        async materializePublic(payload, operation) {
          calls.push(['materialize.public', payload, operation]);
          return materialized;
        },
      };
    },
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => ({
      async read(id) { calls.push(['context.read', filePath, id]); return { id }; },
    }),
    receiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) { calls.push(['receipt.read', receiptServerId, receiptJobId]); return { serverId: receiptServerId, jobId: receiptJobId }; },
    }),
    evidenceInspectorFactory: () => ({
      async inspectApplied(bundle) { calls.push(['evidence.apply', bundle]); return { applied: true }; },
      async inspectDeleted(bundle) { calls.push(['evidence.delete', bundle]); return { deleted: true }; },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.readReceipt(serverId, jobId), { serverId, jobId });
      assert.equal(await input.materializeDesiredState({}, OPERATIONS.DATABASE_CREDENTIAL_APPLY), materialized);
      assert.deepEqual(await input.inspectLiveState(OPERATIONS.DATABASE_CREDENTIAL_APPLY, materialized), { applied: true });
      assert.deepEqual(await input.inspectLiveState(OPERATIONS.DATABASE_CREDENTIAL_DELETE, materialized), { deleted: true });
      return { serverId, jobId, operation: OPERATIONS.DATABASE_CREDENTIAL_APPLY, status: 'succeeded', reconciled: true };
    },
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.statePaths.databaseBindingStore, '/work/state/db-bindings.json');
  assert.equal(result.statePaths.databaseCredentialStore, '/work/state/db-credentials.json');
  assert.equal(result.statePaths.dockerWorkloadStore, '/work/state/docker.json');
  assert.ok(calls.some(([name]) => name === 'materialize.public'));
  assert.ok(calls.some(([name]) => name === 'evidence.apply'));
});

test('database credential recovery rejects wrong host before opening protected credential state', async () => {
  let protectedState = 0;
  await assert.rejects(
    runRunningDatabaseCredentialRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({
        async init() {},
        async getServer() { return { id: serverId, hostname: 'other-host' }; },
      }),
      applicationRegistryFactory: () => ({ async init() {} }),
      websiteRegistryFactory: () => ({ async init() {} }),
      dockerWorkloadRegistryFactory: () => ({ async init() {} }),
      databaseBindingRegistryFactory: () => { protectedState += 1; return { async init() {} }; },
      databaseCredentialRegistryFactory: () => { protectedState += 1; return { async init() {} }; },
      materializerFactory: () => ({ materializePublic: async () => ({}) }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => ({ read: async () => ({}) }),
      receiptStoreFactory: () => ({ read: async () => ({}) }),
      evidenceInspectorFactory: () => ({ inspectApplied: async () => ({}), inspectDeleted: async () => ({}) }),
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(protectedState, 0);
});
