import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JobRecoveryRuntimeError,
  resolveJobRecoveryPaths,
  runTerminalRecoveryFromStores,
} from '../src/job-recovery-runtime.js';

const identity = Object.freeze({ serverId: 'server-1', jobId: '12345678-1234-4234-8234-123456789012' });

test('recovery paths resolve the full development registry set beside the existing job/server stores', () => {
  const paths = resolveJobRecoveryPaths({
    env: {
      YUNPANEL_SERVER_STORE: '.state/servers.json',
      YUNPANEL_JOB_STORE: '.state/jobs.json',
      YUNPANEL_DOMAIN_STORE: '.state/domains.json',
      YUNPANEL_CERTIFICATE_STORE: '.state/certificates.json',
      YUNPANEL_APPLICATION_STORE: '.state/applications.json',
    },
    cwd: '/work/yunpanel',
  });
  assert.deepEqual(paths, {
    serverStore: '/work/yunpanel/.state/servers.json',
    domainStore: '/work/yunpanel/.state/domains.json',
    jobStore: '/work/yunpanel/.state/jobs.json',
    recoveryStore: '/work/yunpanel/.state/jobs.json.recovery.json',
    certificateStore: '/work/yunpanel/.state/certificates.json',
    applicationStore: '/work/yunpanel/.state/applications.json',
  });
});

test('packaged recovery keeps domain, certificate and application state inside the control-plane root', () => {
  const paths = resolveJobRecoveryPaths({ env: {}, packaged: true, cwd: '/tmp/ignored' });
  assert.deepEqual(paths, {
    serverStore: '/var/lib/yunpanel/control-plane/server-registry.json',
    domainStore: '/var/lib/yunpanel/control-plane/domain-registry.json',
    jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
    recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
    certificateStore: '/var/lib/yunpanel/control-plane/certificate-registry.json',
    applicationStore: '/var/lib/yunpanel/control-plane/application-registry.json',
  });

  for (const [key, value] of [
    ['YUNPANEL_DOMAIN_STORE', '/tmp/domains.json'],
    ['YUNPANEL_CERTIFICATE_STORE', '/tmp/certificates.json'],
    ['YUNPANEL_APPLICATION_STORE', '/tmp/applications.json'],
  ]) {
    assert.throws(
      () => resolveJobRecoveryPaths({ env: { [key]: value }, packaged: true }),
      (error) => error instanceof JobRecoveryRuntimeError && error.code === 'packaged_job_recovery_path_outside_control_plane',
    );
  }
});

test('terminal recovery runtime initializes resource stores and passes one durable registry to the command core', async () => {
  const events = [];
  const factories = {};
  const makeRegistry = (label, extra = {}) => (options) => {
    factories[label] = options;
    return {
      async init() { events.push(`${label}.init`); },
      ...extra,
    };
  };
  const serverRegistryFactory = makeRegistry('server', {
    async getServer(id) { events.push(`server.get:${id}`); return { id }; },
  });
  const domainRegistryFactory = makeRegistry('domain');
  const certificateRegistryFactory = makeRegistry('certificate');
  const applicationRegistryFactory = makeRegistry('application');
  const jobRegistryFactory = () => ({ marker: 'raw-job-registry' });
  const recoveryStoreFactory = () => ({ marker: 'recovery-store' });
  const durableRegistry = { marker: 'durable-job-registry' };
  let durableOptions;
  const serviceStatus = async () => ({ apiActive: false, agentActive: false });

  const result = await runTerminalRecoveryFromStores({
    ...identity,
    env: {},
    cwd: '/work/yunpanel',
    serverRegistryFactory,
    domainRegistryFactory,
    certificateRegistryFactory,
    applicationRegistryFactory,
    jobRegistryFactory,
    recoveryStoreFactory,
    durableRegistryFactory: (options) => {
      durableOptions = options;
      return durableRegistry;
    },
    serviceStatus,
    reconcileCommand: async (input) => {
      events.push('command');
      assert.equal(input.jobRegistry, durableRegistry);
      assert.equal(input.domainRegistry, input.domainRegistry);
      assert.equal(input.serviceStatus, serviceStatus);
      assert.deepEqual({ serverId: input.serverId, jobId: input.jobId }, identity);
      return { ...identity, status: 'failed', reconciled: true };
    },
  });

  assert.deepEqual(events.slice(0, 5), ['server.init', 'domain.init', 'certificate.init', 'application.init', 'command']);
  assert.equal(factories.server.filePath, '/work/yunpanel/.data/server-registry.json');
  assert.equal(factories.domain.filePath, '/work/yunpanel/.data/domain-registry.json');
  assert.equal(factories.certificate.filePath, '/work/yunpanel/.data/certificate-registry.json');
  assert.equal(factories.application.filePath, '/work/yunpanel/.data/application-registry.json');
  assert.equal(typeof factories.domain.serverExists, 'function');
  assert.equal(await factories.domain.serverExists('server-1'), true);
  assert.equal(durableOptions.filePath, '/work/yunpanel/.data/job-registry.json');
  assert.equal(durableOptions.registryFactory, jobRegistryFactory);
  assert.equal(durableOptions.recoveryStoreFactory, recoveryStoreFactory);
  assert.equal(result.reconciled, true);
  assert.equal(result.statePaths.recoveryStore, '/work/yunpanel/.data/job-registry.json.recovery.json');
});

test('resource registry initialization failures are redacted by the recovery runtime', async () => {
  await assert.rejects(
    runTerminalRecoveryFromStores({
      ...identity,
      serverRegistryFactory: () => ({ async init() { throw new Error('SECRET=/private/path'); } }),
      domainRegistryFactory: () => ({ async init() {} }),
      certificateRegistryFactory: () => ({ async init() {} }),
      applicationRegistryFactory: () => ({ async init() {} }),
      jobRegistryFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      reconcileCommand: async () => ({}),
    }),
    (error) => error instanceof JobRecoveryRuntimeError
      && error.code === 'job_recovery_registry_init_failed'
      && !error.message.includes('SECRET')
      && !error.message.includes('/private/path'),
  );
});
