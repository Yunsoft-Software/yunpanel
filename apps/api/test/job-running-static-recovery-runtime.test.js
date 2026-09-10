import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningStaticDeploymentRecoveryFromStores } from '../src/job-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const hostname = 'host-1';

function resourceFactory(label, calls) {
  return ({ filePath }) => ({ async init() { calls.push([`${label}.init`, filePath]); } });
}

test('static recovery runtime binds exact host, private context, resource stores and evidence inspector', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const result = await runRunningStaticDeploymentRecoveryFromStores({
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
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => {
      calls.push(['context.create', filePath]);
      return {
        async read(id) {
          calls.push(['context.read', id]);
          return { id, payload: { applicationId: 'app', deploymentId: jobId } };
        },
      };
    },
    evidenceInspectorFactory: () => ({
      async inspect(identity) { calls.push(['evidence.inspect', identity]); return { satisfied: true, result: {} }; },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId, payload: { applicationId: 'app', deploymentId: jobId } });
      assert.deepEqual(await input.inspectDeploymentEvidence({ applicationId: 'app', deploymentId: jobId }), {
        satisfied: true,
        result: {},
      });
      return { serverId, jobId, operation: 'app.static.deploy', status: 'succeeded', recoveryMethod: 'verified_static_deployment_receipt', reconciled: true };
    },
  });

  assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [
    ['server.init', '/work/state/servers.json'],
    ['server.get', serverId],
    ['durable.create', '/work/state/jobs.json'],
    ['context.create', '/work/state/jobs.json'],
    ['domain.init', '/work/state/domains.json'],
    ['certificate.init', '/work/state/certificates.json'],
    ['application.init', '/work/state/applications.json'],
    ['context.read', jobId],
    ['evidence.inspect', { applicationId: 'app', deploymentId: jobId }],
  ]);
});

test('static recovery refuses a different host before context or evidence construction', async () => {
  let contextFactories = 0;
  let evidenceFactories = 0;
  await assert.rejects(
    runRunningStaticDeploymentRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({ async init() {}, async getServer() { return { id: serverId, hostname: 'other-host' }; } }),
      domainRegistryFactory: () => ({ async init() {} }),
      certificateRegistryFactory: () => ({ async init() {} }),
      applicationRegistryFactory: () => ({ async init() {} }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => { contextFactories += 1; return { read: async () => ({}) }; },
      evidenceInspectorFactory: () => { evidenceFactories += 1; return { inspect: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(contextFactories, 0);
  assert.equal(evidenceFactories, 0);
});
