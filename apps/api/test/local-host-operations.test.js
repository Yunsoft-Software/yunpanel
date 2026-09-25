import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createLocalHostOperations,
  LOCAL_HOST_OPERATIONS,
  LOCAL_MAIL_DATA_OPERATIONS,
  LOCAL_NODE_ENVIRONMENT_OPERATIONS,
  LOCAL_PYTHON_ENVIRONMENT_OPERATIONS,
} from '../src/local-host-operations.js';

function fixture({ withEnvironment = false } = {}) {
  const calls = [];
  const environments = [];
  const credentials = [];
  const options = {
    packageManager: {
      inspect: async () => { calls.push(['packages.inspect']); return { packageName: 'yunpanel' }; },
      upgrade: async () => { calls.push(['packages.upgrade']); return { upgraded: true }; },
    },
    nginxManager: {
      stageDomain: async (payload) => { calls.push(['domain.stage', payload]); return { checksum: 'a'.repeat(64), configName: 'site.conf' }; },
      activateDomain: async (payload) => { calls.push(['domain.activate', payload]); return { ...payload, active: true }; },
    },
    acmeManager: {
      issueCertificate: async (payload) => { calls.push(['ssl.issue', payload]); return { certName: payload.domains[0], domains: payload.domains, staging: payload.staging === true, status: payload.staging ? 'validated' : 'issued' }; },
      renewCertificate: async (payload) => { calls.push(['ssl.renew', payload]); return { certName: payload.certName, dryRun: payload.dryRun === true, status: payload.dryRun ? 'validated' : 'renewed' }; },
    },
    staticDeploymentManager: {
      deployStatic: async (payload, execution) => { calls.push(['static.deploy', payload, execution]); return { deploymentId: payload.deploymentId, releaseId: payload.deploymentId }; },
    },
    staticRollbackManager: {
      rollbackStatic: async (payload) => { calls.push(['static.rollback', payload]); return { releaseId: payload.releaseId, previousReleaseId: payload.currentReleaseId, active: true }; },
    },
    nodeDeploymentManager: {
      deployNode: async (payload, execution) => { calls.push(['node.deploy', payload, execution]); return { releaseId: payload.deploymentId }; },
    },
    nodeRollbackManager: {
      rollbackNode: async (payload) => { calls.push(['node.rollback', payload]); return { releaseId: payload.releaseId }; },
    },
    nodeRestartManager: {
      restartNode: async (payload) => { calls.push(['node.restart', payload]); return { releaseId: payload.releaseId, restarted: true }; },
    },
    nodeProcessManager: {
      controlNodeProcess: async (payload) => { calls.push(['node.process', payload]); return { releaseId: payload.releaseId, action: payload.action }; },
    },
    nodeRuntimeManager: {
      inspect: async () => { calls.push(['node-runtime.inspect']); return { managedRuntimes: [] }; },
      install: async (major) => { calls.push(['node-runtime.install', major]); return { changed: true }; },
    },
    nodeStatusInspector: {
      inspectNodeStatus: async (payload) => { calls.push(['node.status', payload]); return { releaseId: payload.releaseId, healthy: true }; },
    },
  };
  if (withEnvironment) {
    options.loadApplicationEnvironment = async (applicationId, expectedRevision) => {
      environments.push([applicationId, expectedRevision]);
      return { PUBLIC_VALUE: 'visible', API_TOKEN: 'secret-value' };
    };
    options.loadDeploymentCredential = async (applicationId) => {
      credentials.push(applicationId);
      return { type: 'github_token', token: 'github_pat_private_test_value' };
    };
  }
  return { calls, environments, credentials, operations: createLocalHostOperations(options) };
}

test('Node and Python mutations stay unsupported when no application environment provider is configured', async () => {
  const { operations } = fixture();
  assert.deepEqual(operations.operations, [...LOCAL_HOST_OPERATIONS, ...LOCAL_MAIL_DATA_OPERATIONS]);
  for (const operation of [...LOCAL_NODE_ENVIRONMENT_OPERATIONS, ...LOCAL_PYTHON_ENVIRONMENT_OPERATIONS]) {
    assert.equal(operations.supports(operation), false);
    await assert.rejects(() => operations.executeOperation(operation, {}), { code: 'local_operation_not_migrated' });
  }
});

test('configured environment provider enables all Node and Python mutation operations', () => {
  const { operations } = fixture({ withEnvironment: true });
  for (const operation of [...LOCAL_HOST_OPERATIONS, ...LOCAL_NODE_ENVIRONMENT_OPERATIONS, ...LOCAL_PYTHON_ENVIRONMENT_OPERATIONS]) {
    assert.equal(operations.supports(operation), true);
    assert.ok(operations.operations.includes(operation));
  }
});

test('Node deploy hydrates environment and Git credential only for execution', async () => {
  const { operations, calls, environments, credentials } = fixture({ withEnvironment: true });
  const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
  const deploymentId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  const previousId = 'ff830043-9752-4640-83b4-3a1998de78a0';
  const runtime = { port: 3100, healthPath: '/health' };
  const deploy = { applicationId, deploymentId, runtime, environmentRevision: 3 };
  const rollback = { applicationId, releaseId: previousId, currentReleaseId: deploymentId, runtime, environmentRevision: 4 };
  const restart = { applicationId, releaseId: deploymentId, runtime, environmentRevision: 5 };

  await operations.executeOperation(OPERATIONS.APP_NODE_DEPLOY, deploy);
  await operations.executeOperation(OPERATIONS.APP_NODE_ROLLBACK, rollback);
  await operations.executeOperation(OPERATIONS.APP_NODE_RESTART, restart);

  assert.deepEqual(environments, [[applicationId, 3], [applicationId, 4], [applicationId, 5]]);
  assert.deepEqual(credentials, [applicationId]);
  assert.equal(Object.hasOwn(deploy, 'environment'), false);
  assert.equal(Object.hasOwn(rollback, 'environment'), false);
  assert.equal(Object.hasOwn(restart, 'environment'), false);
  for (const [, hydrated] of calls) {
    assert.deepEqual(hydrated.environment, { PUBLIC_VALUE: 'visible', API_TOKEN: 'secret-value' });
  }
  assert.deepEqual(calls.find(([name]) => name === 'node.deploy')[2], {
    gitCredential: { type: 'github_token', token: 'github_pat_private_test_value' },
  });
});

test('invalid environment bundles fail before a Node manager executes', async () => {
  let executions = 0;
  const operations = createLocalHostOperations({
    loadApplicationEnvironment: async () => null,
    nodeDeploymentManager: { deployNode: async () => { executions += 1; } },
  });
  await assert.rejects(
    () => operations.executeOperation(OPERATIONS.APP_NODE_DEPLOY, { applicationId: 'app' }),
    { code: 'invalid_environment_bundle' },
  );
  assert.equal(executions, 0);
});

test('only deploy requests Git credentials while status and process control avoid secrets', async () => {
  const { operations, calls, environments, credentials } = fixture({ withEnvironment: true });
  const staticPayload = { applicationId: 'static-app', deploymentId: 'release' };
  const statusPayload = { applicationId: 'node-app', releaseId: 'release', runtime: { port: 3100, healthPath: '/health' } };
  const processPayload = { ...statusPayload, action: 'stop' };
  await operations.executeOperation(OPERATIONS.APP_STATIC_DEPLOY, staticPayload);
  await operations.executeOperation(OPERATIONS.APP_NODE_STATUS, statusPayload);
  await operations.executeOperation(OPERATIONS.APP_NODE_PROCESS, processPayload);
  assert.deepEqual(environments, []);
  assert.deepEqual(credentials, ['static-app']);
  assert.deepEqual(calls.map(([name]) => name), ['static.deploy', 'node.status', 'node.process']);
  assert.deepEqual(calls[0][2], { gitCredential: { type: 'github_token', token: 'github_pat_private_test_value' } });
});

test('managed Node runtime inventory and install dispatch outside application secret materialization', async () => {
  const { operations, calls, environments } = fixture({ withEnvironment: true });
  await operations.executeOperation(OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT, {});
  await operations.executeOperation(OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, { major: 24 });
  assert.deepEqual(environments, []);
  assert.deepEqual(calls, [['node-runtime.inspect'], ['node-runtime.install', 24]]);
});

test('DNS certificate operations materialize provider credentials only for host execution', async () => {
  const challenge = {
    type: 'dns-01', provider: 'cloudflare',
    credentialId: '12345678-1234-4234-8234-123456789012',
    dnsZoneId: '22345678-1234-4234-8234-123456789012', propagationSeconds: 30,
  };
  const payload = {
    domains: ['example.com', '*.example.com'], email: 'owner@example.com', staging: true, challenge,
  };
  const credential = { id: challenge.credentialId, dnsZoneId: challenge.dnsZoneId, provider: 'cloudflare', token: 'private-token' };
  let execution;
  const operations = createLocalHostOperations({
    loadDnsProviderCredential: async (id) => {
      assert.equal(id, challenge.credentialId);
      return credential;
    },
    acmeManager: {
      issueCertificate: async (input, options) => { execution = { input, options }; return { status: 'validated' }; },
      renewCertificate: async () => ({ status: 'validated' }),
    },
  });
  await operations.executeOperation(OPERATIONS.SSL_ISSUE, payload);
  assert.equal(execution.input, payload);
  assert.deepEqual(execution.options, { dnsCredential: credential });
  assert.equal(Object.hasOwn(payload, 'dnsCredential'), false);
});

test('private provisioning authorization is rechecked before a local host mutation', async () => {
  const authorization = {
    kind: 'website_provisioning',
    version: 1,
    operationId: '9ae512c0-a717-4611-943c-6ce2ab0abf16',
    websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
    stepId: 'certificate',
  };
  const execution = {
    jobId: '12345678-1234-4234-8234-123456789012',
    serverId: 'server-1',
    resourceType: 'certificate',
    resourceId: 'certificate-1',
    authorization,
  };
  const payload = { domains: ['example.com'], email: 'owner@example.com', staging: false };
  let hostCalls = 0;
  const withoutAuthorizer = createLocalHostOperations({
    acmeManager: {
      issueCertificate: async () => { hostCalls += 1; return { status: 'issued' }; },
      renewCertificate: async () => ({ status: 'renewed' }),
    },
  });
  await assert.rejects(
    withoutAuthorizer.executeOperation(OPERATIONS.SSL_ISSUE, payload, execution),
    { code: 'website_provisioning_job_authorization_unavailable' },
  );
  assert.equal(hostCalls, 0);

  const authorizationCalls = [];
  const denied = createLocalHostOperations({
    authorizeWebsiteProvisioning: async (...args) => {
      authorizationCalls.push(args);
      return false;
    },
    acmeManager: {
      issueCertificate: async () => { hostCalls += 1; return { status: 'issued' }; },
      renewCertificate: async () => ({ status: 'renewed' }),
    },
  });
  await assert.rejects(
    denied.executeOperation(OPERATIONS.SSL_ISSUE, payload, execution),
    { code: 'website_provisioning_job_actor_forbidden' },
  );
  assert.equal(hostCalls, 0);
  assert.deepEqual(authorizationCalls[0][0], authorization);

  const allowed = createLocalHostOperations({
    authorizeWebsiteProvisioning: async (scope, context) => {
      authorizationCalls.push([scope, context]);
      return true;
    },
    acmeManager: {
      issueCertificate: async () => { hostCalls += 1; return { status: 'issued' }; },
      renewCertificate: async () => ({ status: 'renewed' }),
    },
  });
  await allowed.executeOperation(OPERATIONS.SSL_ISSUE, payload, execution);
  assert.equal(hostCalls, 1);
  assert.equal(authorizationCalls.at(-1)[1].jobId, execution.jobId);
});

test('legacy unscoped provisioning jobs are quarantined before host mutation', async () => {
  const payload = { domains: ['example.com'], email: 'owner@example.com', staging: false };
  const execution = {
    jobId: '12345678-1234-4234-8234-123456789012',
    serverId: 'server-1',
    type: 'website.ssl.issue:9ae512c0-a717-4611-943c-6ce2ab0abf16',
    resourceType: 'certificate',
    resourceId: 'certificate-1',
    authorization: null,
  };
  let hostCalls = 0;
  let guardCalls = 0;
  const quarantined = createLocalHostOperations({
    requiresWebsiteProvisioningAuthorization: async (candidate) => {
      guardCalls += 1;
      assert.equal(candidate.type, execution.type);
      return true;
    },
    acmeManager: {
      issueCertificate: async () => { hostCalls += 1; return { status: 'issued' }; },
      renewCertificate: async () => ({ status: 'renewed' }),
    },
  });
  await assert.rejects(
    quarantined.executeOperation(OPERATIONS.SSL_ISSUE, payload, execution),
    { code: 'website_provisioning_job_authorization_required' },
  );
  assert.equal(guardCalls, 1);
  assert.equal(hostCalls, 0);

  const ordinary = createLocalHostOperations({
    requiresWebsiteProvisioningAuthorization: async () => false,
    acmeManager: {
      issueCertificate: async () => { hostCalls += 1; return { status: 'issued' }; },
      renewCertificate: async () => ({ status: 'renewed' }),
    },
  });
  await ordinary.executeOperation(OPERATIONS.SSL_ISSUE, payload, {
    ...execution,
    type: 'ssl.issue',
  });
  assert.equal(hostCalls, 1);

  const unavailable = createLocalHostOperations({
    requiresWebsiteProvisioningAuthorization: async () => { throw new Error('state unavailable'); },
    acmeManager: {
      issueCertificate: async () => { hostCalls += 1; return { status: 'issued' }; },
      renewCertificate: async () => ({ status: 'renewed' }),
    },
  });
  await assert.rejects(
    unavailable.executeOperation(OPERATIONS.SSL_ISSUE, payload, execution),
    { code: 'website_provisioning_job_authorization_unavailable' },
  );
  assert.equal(hostCalls, 1);
});

test('DNS record mutations materialize a provider credential only for the guarded adapter', async () => {
  const credentialId = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
  const payload = {
    provider: 'cloudflare', credentialId,
    dnsZoneId: '822fa920-166c-4a7a-a26b-476c81d82165',
    zoneName: 'example.test', action: 'upsert',
    record: { type: 'A', name: 'app.example.test', content: '203.0.113.10', ttl: 300, proxied: false },
    expectedSnapshotDigest: 'a'.repeat(64),
  };
  const credential = { id: credentialId, dnsZoneId: payload.dnsZoneId, provider: 'cloudflare', token: 'private-token' };
  let received;
  const operations = createLocalHostOperations({
    loadDnsProviderCredential: async (id) => {
      assert.equal(id, credentialId);
      return credential;
    },
    cloudflareDnsManager: {
      async applyRecord(input, options) { received = { input, options }; return { state: 'present' }; },
    },
  });
  assert.equal(operations.supports(OPERATIONS.DNS_RECORD_APPLY), true);
  await operations.executeOperation(OPERATIONS.DNS_RECORD_APPLY, payload);
  assert.equal(received.input, payload);
  assert.deepEqual(received.options, { dnsCredential: credential });
  assert.equal(Object.hasOwn(payload, 'dnsCredential'), false);

  const withoutCredentialLoader = createLocalHostOperations({ cloudflareDnsManager: { applyRecord: async () => null } });
  assert.equal(withoutCredentialLoader.supports(OPERATIONS.DNS_RECORD_APPLY), true);
  await assert.rejects(
    withoutCredentialLoader.executeOperation(OPERATIONS.DNS_RECORD_APPLY, payload),
    { code: 'dns_provider_credential_unavailable' },
  );
});
