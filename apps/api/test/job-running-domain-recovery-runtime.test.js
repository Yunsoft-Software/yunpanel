import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningDomainStageRecoveryFromStores } from '../src/job-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'host-1';

function resourceFactory(label, calls) {
  return ({ filePath }) => ({
    async init() { calls.push([`${label}.init`, filePath]); },
  });
}

test('staged domain recovery runtime binds exact host, private context, guarded stores and Nginx evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const result = await runRunningDomainStageRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_DOMAIN_STORE: '/work/state/domains.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
      YUNPANEL_CERTIFICATE_STORE: '/work/state/certificates.json',
      YUNPANEL_APPLICATION_STORE: '/work/state/applications.json',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname }; },
    }),
    domainRegistryFactory: resourceFactory('domain', calls),
    certificateRegistryFactory: resourceFactory('certificate', calls),
    applicationRegistryFactory: resourceFactory('application', calls),
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => {
      calls.push(['durable.create', filePath]);
      return fakeJobRegistry;
    },
    contextReaderFactory: ({ filePath }) => {
      calls.push(['context.create', filePath]);
      return {
        async read(id) {
          calls.push(['context.read', id]);
          return { id, payload: { primaryDomain: 'example.com' } };
        },
      };
    },
    nginxManagerFactory: () => ({
      async inspectStagedDomain(payload) {
        calls.push(['nginx.evidence', payload]);
        return { satisfied: true, result: { checksum: 'a'.repeat(64) } };
      },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.equal(input.serverId, serverId);
      assert.equal(input.jobId, jobId);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId, payload: { primaryDomain: 'example.com' } });
      assert.deepEqual(await input.inspectStageEvidence({ primaryDomain: 'example.com' }), {
        satisfied: true,
        result: { checksum: 'a'.repeat(64) },
      });
      return {
        serverId,
        jobId,
        operation: 'domain.stage',
        status: 'succeeded',
        recoveryMethod: 'verified_staged_nginx_config',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.statePaths.domainStore, '/work/state/domains.json');
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['context.create', '/work/state/jobs.json'],
    ['domain.init', '/work/state/domains.json'],
    ['certificate.init', '/work/state/certificates.json'],
    ['application.init', '/work/state/applications.json'],
    ['context.read', jobId],
    ['nginx.evidence', { primaryDomain: 'example.com' }],
  ]);
});

test('staged domain recovery refuses a different host before resource, context or evidence construction', async () => {
  let resourceFactories = 0;
  let contextFactories = 0;
  let evidenceFactories = 0;
  await assert.rejects(
    runRunningDomainStageRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({
        async init() {},
        async getServer() { return { id: serverId, hostname: 'other-host' }; },
      }),
      domainRegistryFactory: () => { resourceFactories += 1; return { async init() {} }; },
      certificateRegistryFactory: () => { resourceFactories += 1; return { async init() {} }; },
      applicationRegistryFactory: () => { resourceFactories += 1; return { async init() {} }; },
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => { contextFactories += 1; return { read: async () => ({}) }; },
      nginxManagerFactory: () => { evidenceFactories += 1; return { inspectStagedDomain: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(resourceFactories, 0);
  assert.equal(contextFactories, 0);
  assert.equal(evidenceFactories, 0);
});
