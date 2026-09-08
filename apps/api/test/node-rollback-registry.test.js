import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createApplicationRegistry, ApplicationRegistryError } from '../src/application-registry.js';

const FIRST_RELEASE = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const SECOND_RELEASE = 'ff830043-9752-4640-83b4-3a1998de78a0';
const ROLLBACK_OPERATION = '78358f9b-dd0a-4569-8a70-920836c382f5';

function runtime() {
  return {
    nodeMajor: 24,
    installMode: 'ci',
    buildScript: 'build',
    startMode: 'node',
    entryFile: 'dist/server.js',
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 10,
    restartPolicy: 'on-failure',
  };
}

function serviceName(applicationId) {
  const digest = createHash('sha256').update(applicationId).digest('hex').slice(0, 16);
  return `yunpanel-node-${digest}.service`;
}

async function deployedNodeRegistry() {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  const application = await registry.createNodeApplication({
    serverId: 'server-1',
    name: 'Example Node',
    repositoryUrl: 'https://github.com/example/node-app',
    runtime: runtime(),
  });
  const managedService = serviceName(application.id);

  await registry.markDeploying(application.id, FIRST_RELEASE);
  await registry.markDeployed(application.id, {
    deploymentId: FIRST_RELEASE,
    releaseId: FIRST_RELEASE,
    previousReleaseId: null,
    commitSha: 'a'.repeat(40),
    serviceName: managedService,
    port: 3100,
    healthPath: '/health',
    healthy: true,
  });

  await registry.markDeploying(application.id, SECOND_RELEASE);
  await registry.markDeployed(application.id, {
    deploymentId: SECOND_RELEASE,
    releaseId: SECOND_RELEASE,
    previousReleaseId: FIRST_RELEASE,
    commitSha: 'b'.repeat(40),
    serviceName: managedService,
    port: 3100,
    healthPath: '/health',
    healthy: true,
  });

  return { registry, applicationId: application.id, managedService };
}

test('Node rollback reconciles retained release and managed service state', async () => {
  const { registry, applicationId, managedService } = await deployedNodeRegistry();
  const rollingBack = await registry.markRollingBack(applicationId, ROLLBACK_OPERATION, FIRST_RELEASE);

  assert.equal(rollingBack.state, 'rolling_back');
  assert.equal(rollingBack.pendingRollbackReleaseId, FIRST_RELEASE);

  const rolledBack = await registry.markRolledBack(applicationId, {
    operationId: ROLLBACK_OPERATION,
    releaseId: FIRST_RELEASE,
    previousReleaseId: SECOND_RELEASE,
    serviceName: managedService,
    port: 3100,
    healthPath: '/health',
    healthy: true,
  });

  assert.equal(rolledBack.state, 'active');
  assert.equal(rolledBack.currentReleaseId, FIRST_RELEASE);
  assert.equal(rolledBack.previousReleaseId, SECOND_RELEASE);
  assert.equal(rolledBack.currentCommitSha, 'a'.repeat(40));
  assert.equal(rolledBack.serviceName, managedService);
  assert.deepEqual(rolledBack.proxyTarget, { host: '127.0.0.1', port: 3100 });
  assert.equal(rolledBack.pendingRollbackReleaseId, null);
});

test('Node rollback registry rejects forged managed service state', async () => {
  const { registry, applicationId } = await deployedNodeRegistry();
  await registry.markRollingBack(applicationId, ROLLBACK_OPERATION, FIRST_RELEASE);

  await assert.rejects(
    registry.markRolledBack(applicationId, {
      operationId: ROLLBACK_OPERATION,
      releaseId: FIRST_RELEASE,
      previousReleaseId: SECOND_RELEASE,
      serviceName: 'yunpanel-node-0000000000000000.service',
      port: 3100,
      healthPath: '/health',
      healthy: true,
    }),
    (error) => error instanceof ApplicationRegistryError && error.code === 'invalid_node_service',
  );

  const unchanged = await registry.getApplication(applicationId);
  assert.equal(unchanged.state, 'rolling_back');
  assert.equal(unchanged.currentReleaseId, SECOND_RELEASE);
});
