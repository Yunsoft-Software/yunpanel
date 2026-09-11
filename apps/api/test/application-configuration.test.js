import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createApplicationRegistry, ApplicationRegistryError } from '../src/application-registry.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';

function runtime(overrides = {}) {
  return {
    nodeMajor: 24,
    packageManager: 'npm',
    installMode: 'ci',
    buildScript: 'build',
    mode: 'production',
    documentRoot: '.',
    startMode: 'node',
    entryFile: 'dist/server.js',
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 10,
    restartPolicy: 'on-failure',
    ...overrides,
  };
}

function serviceName(id) {
  return `yunpanel-node-${createHash('sha256').update(id).digest('hex').slice(0, 16)}.service`;
}

test('Node configuration uses revisioned preview/apply while the active release keeps its runtime', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  const created = await registry.createNodeApplication({
    applicationId,
    serverId: 'server-1',
    name: 'Managed Node',
    repositoryUrl: 'https://github.com/example/managed-node',
    runtime: runtime(),
  });
  assert.equal(created.appliedRevision, 0);
  assert.equal(created.activeRuntime, null);
  assert.equal(created.configurationPending, false);

  const firstPreview = await registry.previewNodeConfiguration(applicationId, runtime({
    packageManager: 'pnpm',
    documentRoot: 'services/api',
    startMode: 'npm',
    startScript: 'serve:prod',
  }));
  assert.deepEqual(firstPreview.impact.changedFields, ['documentRoot', 'packageManager', 'start']);
  assert.equal(firstPreview.impact.deploymentRequired, false);
  await assert.rejects(
    registry.updateNodeConfiguration({
      applicationId,
      expectedRevision: 1,
      runtime: firstPreview.nextRuntime,
      previewDigest: firstPreview.previewDigest,
      confirmation: 'wrong',
    }),
    (error) => error instanceof ApplicationRegistryError && error.code === 'node_configuration_confirmation_required',
  );
  const configured = await registry.updateNodeConfiguration({
    applicationId,
    expectedRevision: 1,
    runtime: firstPreview.nextRuntime,
    previewDigest: firstPreview.previewDigest,
    confirmation: firstPreview.confirmation,
  });
  assert.equal(configured.desiredRevision, 2);
  assert.equal(configured.runtime.packageManager, 'pnpm');
  assert.equal(configured.activeRuntime, null);

  await registry.markDeploying(applicationId, releaseId);
  const deployed = await registry.markDeployed(applicationId, {
    deploymentId: releaseId,
    releaseId,
    commitSha: 'a'.repeat(40),
    serviceName: serviceName(applicationId),
    port: 3100,
    healthPath: '/health',
    healthy: true,
    runtime: configured.runtime,
  });
  assert.equal(deployed.appliedRevision, 2);
  assert.equal(deployed.activeRuntime.packageManager, 'pnpm');
  assert.equal(deployed.configurationPending, false);
  assert.equal(deployed.releases[0].configurationRevision, 2);

  const secondPreview = await registry.previewNodeConfiguration(applicationId, runtime({
    packageManager: 'yarn',
    mode: 'development',
    documentRoot: 'services/api',
    startMode: 'npm',
    startScript: 'serve:dev',
  }));
  const pending = await registry.updateNodeConfiguration({
    applicationId,
    expectedRevision: 2,
    runtime: secondPreview.nextRuntime,
    previewDigest: secondPreview.previewDigest,
    confirmation: secondPreview.confirmation,
  });
  assert.equal(pending.desiredRevision, 3);
  assert.equal(pending.configurationPending, true);
  assert.equal(pending.runtime.packageManager, 'yarn');
  assert.equal(pending.activeRuntime.packageManager, 'pnpm');
  assert.equal(pending.releases[0].runtime.packageManager, 'pnpm');
});

test('Node configuration rejects port changes, stale previews and non-Node applications', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  await registry.createNodeApplication({
    applicationId,
    serverId: 'server-1',
    name: 'Managed Node',
    repositoryUrl: 'https://github.com/example/managed-node',
    runtime: runtime(),
  });
  await assert.rejects(
    registry.previewNodeConfiguration(applicationId, runtime({ port: 3200 })),
    (error) => error instanceof ApplicationRegistryError && error.code === 'node_port_immutable',
  );
  const preview = await registry.previewNodeConfiguration(applicationId, runtime({ mode: 'development' }));
  await registry.updateNodeConfiguration({
    applicationId,
    expectedRevision: 1,
    runtime: preview.nextRuntime,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  await assert.rejects(
    registry.updateNodeConfiguration({
      applicationId,
      expectedRevision: 1,
      runtime: preview.nextRuntime,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (error) => error instanceof ApplicationRegistryError && error.code === 'application_revision_conflict',
  );

  const staticApplication = await registry.createApplication({
    serverId: 'server-1',
    name: 'Static',
    repositoryUrl: 'https://github.com/example/static',
  });
  await assert.rejects(
    registry.previewNodeConfiguration(staticApplication.id, runtime()),
    (error) => error instanceof ApplicationRegistryError && error.code === 'node_configuration_not_supported',
  );
});
