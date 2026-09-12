import assert from 'node:assert/strict';
import test from 'node:test';
import { startConfiguredLocalRuntime, ConfiguredLocalRuntimeError } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const base = {
  hostname: 'host-1.example.local',
  jobStorePath: '/var/lib/yunpanel/control-plane/job-registry.json',
  runtimeVersion: '0.3.0',
  registry: {},
  jobRegistry: {},
  domainRegistry: {},
  certificateRegistry: {},
  applicationRegistry: {},
};

test('disabled local runtime does not construct privileged host operations', async () => {
  let operationFactories = 0;
  let starts = 0;
  const result = await startConfiguredLocalRuntime({
    ...base,
    env: {},
    createOperations: () => { operationFactories += 1; return {}; },
    startRuntime: async () => { starts += 1; return {}; },
  });
  assert.equal(result, null);
  assert.equal(operationFactories, 0);
  assert.equal(starts, 0);
});

test('enabled local runtime hydrates Node environment only through the registry and forwards guarded startup config', async () => {
  const materialized = [];
  let operationOptions;
  let startOptions;
  const runtime = { stop: async () => {} };
  const applicationEnvironmentRegistry = {
    materialize: async (applicationId, options) => {
      materialized.push([applicationId, options]);
      return { APP_SECRET: 'runtime-only' };
    },
    materializeDeploymentCredential: async (applicationId) => ({
      type: 'github_token', token: `token-for-${applicationId}-private`,
    }),
  };
  const jobLogStore = { record: async () => {} };
  const dnsProviderCredentialRegistry = {
    materialize: async (credentialId) => ({ id: credentialId, token: 'dns-runtime-only' }),
  };

  const result = await startConfiguredLocalRuntime({
    ...base,
    env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
    applicationEnvironmentRegistry,
    dnsProviderCredentialRegistry,
    jobLogStore,
    createOperations: (options) => {
      operationOptions = options;
      return { operations: [], supports: () => true, executeOperation: async () => ({}) };
    },
    startRuntime: async (options) => { startOptions = options; return runtime; },
  });

  assert.equal(result, runtime);
  assert.equal(startOptions.serverId, serverId);
  assert.equal(startOptions.hostname, 'host-1.example.local');
  assert.equal(startOptions.runtimeVersion, '0.3.0');
  assert.equal(startOptions.lockPath, '/var/lib/yunpanel/control-plane/local-executor.lock');
  assert.equal(startOptions.hostOperations.operations.length, 0);
  assert.equal(startOptions.applicationEnvironmentRegistry, applicationEnvironmentRegistry);
  assert.equal(operationOptions.jobLogStore, jobLogStore);
  assert.deepEqual(await operationOptions.loadApplicationEnvironment('app-1', 7), { APP_SECRET: 'runtime-only' });
  assert.deepEqual(await operationOptions.loadDeploymentCredential('app-1'), {
    type: 'github_token', token: 'token-for-app-1-private',
  });
  assert.deepEqual(await operationOptions.loadDnsProviderCredential('credential-1'), {
    id: 'credential-1', token: 'dns-runtime-only',
  });
  assert.deepEqual(materialized, [['app-1', { expectedRevision: 7 }]]);
});

test('Roundcube desired state materializes only inside the local executor and persists secret-free web recovery evidence', async () => {
  const previewSha256 = 'a'.repeat(64);
  const configSha256 = 'b'.repeat(64);
  const fpmSha256 = 'c'.repeat(64);
  const nginxSha256 = 'd'.repeat(64);
  const materializeCalls = [];
  const receiptWrites = [];
  let operationOptions;
  let startOptions;
  const bundle = {
    preview: { sha256: previewSha256, configSha256, fpmSha256, nginxSha256 },
    sensitiveArtifacts: [{ path: '/etc/roundcube/config.inc.php', content: '$config[\'des_key\'] = \'private-only\';' }],
    publicArtifacts: [
      { path: '/etc/php/8.3/fpm/pool.d/roundcube.conf', content: '[roundcube]' },
      { path: '/etc/nginx/sites-enabled/yunpanel-roundcube.conf', content: 'server {}' },
    ],
  };

  await startConfiguredLocalRuntime({
    ...base,
    env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
    applicationEnvironmentRegistry: { materialize: async () => ({}) },
    roundcubeConfigurationService: {
      async materializeForServer(id, options) {
        materializeCalls.push([id, structuredClone(options)]);
        return bundle;
      },
    },
    createRoundcubeConfigOperationReceipts: () => ({
      async write(input) { receiptWrites.push(structuredClone(input)); },
    }),
    createOperations: (options) => {
      operationOptions = options;
      return { operations: ['roundcube.config.apply'], supports: () => true, executeOperation: async () => ({}) };
    },
    startRuntime: async (options) => {
      startOptions = options;
      return { stop: async () => {} };
    },
  });

  assert.equal(await operationOptions.loadRoundcubeConfiguration(
    { previewSha256, configSha256, fpmSha256 },
    { resourceId: serverId },
  ), bundle);
  assert.deepEqual(materializeCalls, [[serverId, { expectedPreviewSha256: previewSha256 }]]);

  await startOptions.recordExecutionEvidence({
    serverId,
    jobId: 'roundcube-job-1',
    operation: 'roundcube.config.apply',
    resourceType: 'server',
    resourceId: serverId,
    payload: { previewSha256, configSha256, fpmSha256 },
    result: {
      version: 1,
      previewSha256,
      configSha256,
      fpmSha256,
      nginxSha256,
      databaseCreated: true,
      httpHealthy: true,
      applied: true,
      sideEffects: true,
    },
  });

  assert.deepEqual(receiptWrites, [{
    serverId,
    jobId: 'roundcube-job-1',
    previewSha256,
    configSha256,
    fpmSha256,
    nginxSha256,
    databaseCreated: true,
    httpHealthy: true,
    applied: true,
  }]);
  assert.doesNotMatch(JSON.stringify(receiptWrites), /private-only|des_key|content/i);
});

test('enabled local runtime refuses to start without the environment materializer', async () => {
  let starts = 0;
  await assert.rejects(
    startConfiguredLocalRuntime({
      ...base,
      env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
      applicationEnvironmentRegistry: {},
      startRuntime: async () => { starts += 1; },
    }),
    (error) => error instanceof ConfiguredLocalRuntimeError && error.code === 'local_environment_registry_invalid',
  );
  assert.equal(starts, 0);
});

test('enabled local runtime rejects an invalid Roundcube materializer before constructing host operations', async () => {
  let operationFactories = 0;
  await assert.rejects(
    startConfiguredLocalRuntime({
      ...base,
      env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
      applicationEnvironmentRegistry: { materialize: async () => ({}) },
      roundcubeConfigurationService: {},
      createOperations: () => { operationFactories += 1; return {}; },
    }),
    (error) => error instanceof ConfiguredLocalRuntimeError && error.code === 'local_roundcube_configuration_invalid',
  );
  assert.equal(operationFactories, 0);
});

test('configured runtime forwards only the supplied safe fault observer', async () => {
  const observer = () => {};
  let startOptions;
  await startConfiguredLocalRuntime({
    ...base,
    env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
    applicationEnvironmentRegistry: { materialize: async () => ({}) },
    createOperations: () => ({ operations: [], supports: () => true, executeOperation: async () => ({}) }),
    startRuntime: async (options) => { startOptions = options; return { stop: async () => {} }; },
    onError: observer,
  });
  assert.equal(startOptions.onError, observer);
});
