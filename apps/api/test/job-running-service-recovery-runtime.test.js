import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningServiceControlRecoveryFromStores } from '../src/job-running-service-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'host-1';

test('managed service recovery runtime binds exact host, private context and read-only service inspection', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const result = await runRunningServiceControlRecoveryFromStores({
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
    durableRegistryFactory: ({ filePath }) => {
      calls.push(['durable.create', filePath]);
      return fakeJobRegistry;
    },
    contextReaderFactory: ({ filePath }) => {
      calls.push(['context.create', filePath]);
      return {
        async read(id) {
          calls.push(['context.read', id]);
          return { id, payload: { serviceId: 'nginx', action: 'stop' } };
        },
      };
    },
    managedServiceManagerFactory: () => ({
      async inspect(serviceId) {
        calls.push(['service.inspect', serviceId]);
        return { id: serviceId, installed: true, active: false, packages: [], units: [] };
      },
    }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.deepEqual(await input.loadJobContext(jobId), { id: jobId, payload: { serviceId: 'nginx', action: 'stop' } });
      assert.deepEqual(await input.inspectServiceState('nginx'), {
        id: 'nginx', installed: true, active: false, packages: [], units: [],
      });
      return {
        serverId,
        jobId,
        operation: 'system.service.control',
        serviceId: 'nginx',
        action: 'stop',
        status: 'succeeded',
        recoveryMethod: 'verified_managed_service_state',
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
    ['service.inspect', 'nginx'],
  ]);
});

test('managed service recovery refuses a different host before durable or host evidence construction', async () => {
  let durableFactories = 0;
  let contextFactories = 0;
  let managerFactories = 0;
  await assert.rejects(
    runRunningServiceControlRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({
        async init() {},
        async getServer() { return { id: serverId, hostname: 'other-host' }; },
      }),
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => { durableFactories += 1; return {}; },
      contextReaderFactory: () => { contextFactories += 1; return { read: async () => ({}) }; },
      managedServiceManagerFactory: () => { managerFactories += 1; return { inspect: async () => ({}) }; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(durableFactories, 0);
  assert.equal(contextFactories, 0);
  assert.equal(managerFactories, 0);
});
