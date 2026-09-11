import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createLocalHostOperations,
  LOCAL_HOST_OPERATIONS,
  LOCAL_NODE_ENVIRONMENT_OPERATIONS,
} from '../src/local-host-operations.js';

function fixture({ withEnvironment = false } = {}) {
  const calls = [];
  const environments = [];
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
      deployStatic: async (payload) => { calls.push(['static.deploy', payload]); return { deploymentId: payload.deploymentId, releaseId: payload.deploymentId }; },
    },
    staticRollbackManager: {
      rollbackStatic: async (payload) => { calls.push(['static.rollback', payload]); return { releaseId: payload.releaseId, previousReleaseId: payload.currentReleaseId, active: true }; },
    },
    nodeDeploymentManager: {
      deployNode: async (payload) => { calls.push(['node.deploy', payload]); return { releaseId: payload.deploymentId }; },
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
    nodeStatusInspector: {
      inspectNodeStatus: async (payload) => { calls.push(['node.status', payload]); return { releaseId: payload.releaseId, healthy: true }; },
    },
  };
  if (withEnvironment) {
    options.loadApplicationEnvironment = async (applicationId) => {
      environments.push(applicationId);
      return { PUBLIC_VALUE: 'visible', API_TOKEN: 'secret-value' };
    };
  }
  return { calls, environments, operations: createLocalHostOperations(options) };
}

test('Node mutations stay unsupported when no application environment provider is configured', async () => {
  const { operations } = fixture();
  assert.deepEqual(operations.operations, LOCAL_HOST_OPERATIONS);
  for (const operation of LOCAL_NODE_ENVIRONMENT_OPERATIONS) {
    assert.equal(operations.supports(operation), false);
    await assert.rejects(() => operations.executeOperation(operation, {}), { code: 'local_operation_not_migrated' });
  }
});

test('configured environment provider enables all Node mutation operations', () => {
  const { operations } = fixture({ withEnvironment: true });
  for (const operation of [...LOCAL_HOST_OPERATIONS, ...LOCAL_NODE_ENVIRONMENT_OPERATIONS]) {
    assert.equal(operations.supports(operation), true);
    assert.ok(operations.operations.includes(operation));
  }
});

test('Node deploy, rollback and restart hydrate environment only for execution', async () => {
  const { operations, calls, environments } = fixture({ withEnvironment: true });
  const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
  const deploymentId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  const previousId = 'ff830043-9752-4640-83b4-3a1998de78a0';
  const runtime = { port: 3100, healthPath: '/health' };
  const deploy = { applicationId, deploymentId, runtime };
  const rollback = { applicationId, releaseId: previousId, currentReleaseId: deploymentId, runtime };
  const restart = { applicationId, releaseId: deploymentId, runtime };

  await operations.executeOperation(OPERATIONS.APP_NODE_DEPLOY, deploy);
  await operations.executeOperation(OPERATIONS.APP_NODE_ROLLBACK, rollback);
  await operations.executeOperation(OPERATIONS.APP_NODE_RESTART, restart);

  assert.deepEqual(environments, [applicationId, applicationId, applicationId]);
  assert.equal(Object.hasOwn(deploy, 'environment'), false);
  assert.equal(Object.hasOwn(rollback, 'environment'), false);
  assert.equal(Object.hasOwn(restart, 'environment'), false);
  for (const [, hydrated] of calls) {
    assert.deepEqual(hydrated.environment, { PUBLIC_VALUE: 'visible', API_TOKEN: 'secret-value' });
  }
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

test('static lifecycle, Node status and Node process control never request application secrets', async () => {
  const { operations, calls, environments } = fixture({ withEnvironment: true });
  const staticPayload = { applicationId: 'static-app', deploymentId: 'release' };
  const statusPayload = { applicationId: 'node-app', releaseId: 'release', runtime: { port: 3100, healthPath: '/health' } };
  const processPayload = { ...statusPayload, action: 'stop' };
  await operations.executeOperation(OPERATIONS.APP_STATIC_DEPLOY, staticPayload);
  await operations.executeOperation(OPERATIONS.APP_NODE_STATUS, statusPayload);
  await operations.executeOperation(OPERATIONS.APP_NODE_PROCESS, processPayload);
  assert.deepEqual(environments, []);
  assert.deepEqual(calls.map(([name]) => name), ['static.deploy', 'node.status', 'node.process']);
});
