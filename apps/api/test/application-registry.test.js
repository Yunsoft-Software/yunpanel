import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationRegistry, ApplicationRegistryError } from '../src/application-registry.js';

test('static application stores normalized deploy configuration and release lifecycle', async () => {
  let clock = Date.parse('2026-09-08T22:00:00.000Z');
  const registry = createApplicationRegistry({
    now: () => clock,
    serverExists: async (serverId) => serverId === 'server-1',
  });

  const app = await registry.createApplication({
    serverId: 'server-1',
    name: 'Marketing Web',
    repositoryUrl: 'https://github.com/example/marketing',
    branch: 'main',
    build: { mode: 'npm', outputDir: 'dist' },
  });

  assert.equal(app.repositoryUrl, 'https://github.com/example/marketing.git');
  assert.equal(app.build.installMode, 'ci');
  assert.match(app.webRoot, new RegExp(`/var/www/yunpanel/apps/${app.id}/current$`));
  assert.equal(app.state, 'draft');

  const deploymentId = 'ff830043-9752-4640-83b4-3a1998de78a0';
  await registry.markDeploying(app.id, deploymentId);
  await assert.rejects(
    registry.markDeploying(app.id, 'bd659ca7-b725-4ee3-981f-67f16fd66eed'),
    (error) => error instanceof ApplicationRegistryError && error.code === 'deployment_in_progress',
  );

  clock += 5_000;
  const deployed = await registry.markDeployed(app.id, {
    deploymentId,
    releaseId: deploymentId,
    commitSha: 'a'.repeat(40),
  });
  assert.equal(deployed.state, 'active');
  assert.equal(deployed.currentReleaseId, deploymentId);
  assert.equal(deployed.currentCommitSha, 'a'.repeat(40));
  assert.equal(deployed.activeDeploymentId, null);

  const nextDeployment = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  await registry.markDeploying(app.id, nextDeployment);
  const failed = await registry.markFailed(app.id, nextDeployment, 'npm_build_failed');
  assert.equal(failed.state, 'active');
  assert.equal(failed.currentReleaseId, deploymentId);
  assert.equal(failed.lastError, 'npm_build_failed');
});

test('application creation rejects unknown server and unsafe repository configuration', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => false });
  await assert.rejects(
    registry.createApplication({
      serverId: 'missing',
      name: 'Site',
      repositoryUrl: 'https://github.com/example/site',
    }),
    (error) => error instanceof ApplicationRegistryError && error.code === 'server_not_found',
  );
});
