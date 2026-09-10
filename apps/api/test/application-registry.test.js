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

test('internal deterministic Application identity is idempotent and rejects configuration drift', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  const applicationId = '8137ef5f-f728-4c52-a214-ab2c1b45268e';
  const input = {
    applicationId,
    serverId: 'server-1',
    name: 'Deterministic Site',
    repositoryUrl: 'https://github.com/example/deterministic',
    branch: 'main',
    build: { mode: 'none', outputDir: '.' },
  };
  const created = await registry.createApplication(input);
  const retried = await registry.createApplication(input);
  assert.equal(created.id, applicationId);
  assert.equal(retried.id, created.id);
  assert.equal((await registry.listApplications()).length, 1);

  await assert.rejects(
    registry.createApplication({ ...input, name: 'Reused identity' }),
    (error) => error instanceof ApplicationRegistryError && error.code === 'application_identity_conflict' && error.status === 409,
  );
});

test('Node port allocation avoids managed and reserved ports and creation rejects duplicates', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  await registry.createNodeApplication({
    serverId: 'server-1',
    name: 'Existing Node',
    repositoryUrl: 'https://github.com/example/existing-node',
    runtime: { port: 3100 },
  });
  assert.equal(await registry.allocateNodePort({ serverId: 'server-1', reservedPorts: [3101] }), 3102);
  assert.equal(await registry.allocateNodePort({ serverId: 'server-2', reservedPorts: [3100] }), 3101);

  await assert.rejects(
    registry.createNodeApplication({
      serverId: 'server-1',
      name: 'Conflicting Node',
      repositoryUrl: 'https://github.com/example/conflicting-node',
      runtime: { port: 3100 },
    }),
    (error) => error instanceof ApplicationRegistryError && error.code === 'node_port_conflict' && error.status === 409,
  );
});
