import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningDnsRecordRecoveryFromStores } from '../src/job-running-dns-record-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const hostname = 'host-1';

test('DNS recovery runtime opens exact private stores and materializes credentials only for the adapter', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const fakeDomainRegistry = {
    async init() { calls.push(['domain.init']); },
    async getDomain(id) { calls.push(['domain.get', id]); return { id }; },
  };
  const fakeDnsHostingRegistry = {
    async init() { calls.push(['dns.init']); },
    async getZone(id) { calls.push(['dns.get', id]); return { id }; },
  };
  const fakeCredentialRegistry = {
    async init() { calls.push(['credential.init']); },
    async materialize(id) { calls.push(['credential.materialize', id]); return { id, token: 'private' }; },
  };

  const result = await runRunningDnsRecordRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
      YUNPANEL_DOMAIN_STORE: '/work/state/domains.json',
      YUNPANEL_DNS_HOSTING_STORE: '/work/state/dns.json',
      YUNPANEL_DNS_CREDENTIAL_STORE: '/work/state/dns-credentials.json',
      YUNPANEL_SECRET_MASTER_KEY: 'test-master-key',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname }; },
    }),
    domainRegistryFactory: ({ filePath }) => { calls.push(['domain.create', filePath]); return fakeDomainRegistry; },
    dnsHostingRegistryFactory: ({ filePath }) => { calls.push(['dns.create', filePath]); return fakeDnsHostingRegistry; },
    dnsProviderCredentialRegistryFactory: ({ filePath, masterKey }) => {
      calls.push(['credential.create', filePath, masterKey]);
      return fakeCredentialRegistry;
    },
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => ({
      async read(id) { calls.push(['context.read', filePath, id]); return { id }; },
    }),
    dnsManagerFactory: () => ({
      async applyRecord(payload, options) {
        calls.push(['provider.apply', payload, options]);
        return { state: 'present' };
      },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId });
      assert.deepEqual(await input.applyDnsRecord({ credentialId: 'credential-1' }), { state: 'present' });
      return {
        serverId, jobId, operation: 'dns.record.apply', status: 'succeeded',
        recoveryMethod: 'idempotent_provider_postcondition', reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.statePaths.dnsHostingStore, '/work/state/dns.json');
  assert.equal(result.statePaths.dnsCredentialStore, '/work/state/dns-credentials.json');
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['domain.create', '/work/state/domains.json'],
    ['domain.init'],
    ['dns.create', '/work/state/dns.json'],
    ['dns.init'],
    ['credential.create', '/work/state/dns-credentials.json', 'test-master-key'],
    ['credential.init'],
    ['context.read', '/work/state/jobs.json', jobId],
    ['credential.materialize', 'credential-1'],
    ['provider.apply', { credentialId: 'credential-1' }, { dnsCredential: { id: 'credential-1', token: 'private' } }],
  ]);
});

test('DNS recovery store paths cannot escape the packaged control-plane root', async () => {
  await assert.rejects(
    runRunningDnsRecordRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      packaged: true,
      env: { YUNPANEL_DNS_CREDENTIAL_STORE: '/tmp/private.json' },
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname }; } }),
      domainRegistryFactory: () => ({ async init() {} }),
      dnsHostingRegistryFactory: () => ({ async init() {} }),
      dnsProviderCredentialRegistryFactory: () => ({ async init() {}, async materialize() {} }),
      jobRegistryFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      contextReaderFactory: () => ({ async read() {} }),
      dnsManagerFactory: () => ({ async applyRecord() {} }),
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'packaged_job_recovery_path_outside_control_plane' },
  );
});
