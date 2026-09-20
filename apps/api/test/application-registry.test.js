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
  const direct = await registry.createNodeApplication({
    serverId: 'server-1',
    name: 'Existing Node',
    repositoryUrl: 'https://github.com/example/existing-node',
    runtime: { port: 3100 },
  });
  assert.equal(direct.runtimeAdapter, 'direct-systemd');
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

test('Passenger Node applications persist no systemd service, localhost proxy or allocated port', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  const application = await registry.createNodeApplication({
    applicationId: '8d3de1c5-a95d-4df6-9c0c-39997ed57d60',
    serverId: 'server-1',
    name: 'Passenger Node',
    repositoryUrl: 'https://github.com/example/passenger-node',
    runtimeAdapter: 'passenger',
    runtime: {
      nodeMajor: 24,
      buildScript: 'build',
      entryFile: 'dist/server.js',
      healthPath: '/healthz',
    },
  });

  assert.equal(application.runtimeAdapter, 'passenger');
  assert.equal(application.runtime.port, null);
  assert.equal(application.serviceName, null);
  assert.equal(application.servicePort, null);
  assert.equal(application.proxyTarget, null);
  assert.equal(await registry.allocateNodePort({ serverId: 'server-1' }), 3100);

  const retried = await registry.createNodeApplication({
    applicationId: application.id,
    serverId: 'server-1',
    name: 'Passenger Node',
    repositoryUrl: 'https://github.com/example/passenger-node',
    runtimeAdapter: 'passenger',
    runtime: {
      nodeMajor: 24,
      buildScript: 'build',
      entryFile: 'dist/server.js',
      healthPath: '/healthz',
    },
  });
  assert.equal(retried.id, application.id);

  await assert.rejects(
    registry.createNodeApplication({
      serverId: 'server-1',
      name: 'Passenger With Port',
      repositoryUrl: 'https://github.com/example/passenger-with-port',
      runtimeAdapter: 'passenger',
      runtime: { port: 3200 },
    }),
    (error) => error instanceof ApplicationRegistryError && error.code === 'invalid_node_port',
  );

  await assert.rejects(
    registry.markDeploying(application.id, 'ff830043-9752-4640-83b4-3a1998de78a0'),
    (error) => error instanceof ApplicationRegistryError && error.code === 'node_deploy_adapter_mismatch' && error.status === 409,
  );
});

test('Passenger release finalization is idempotent and initial provisioning can reset only its own release', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  const applicationId = '3f6d7a55-c37c-4e21-8e68-f62f2dbac046';
  const operationId = '601e1606-5850-4f2f-bfb3-0e117fc28ed4';
  const application = await registry.createNodeApplication({
    applicationId,
    serverId: 'server-1',
    name: 'Native Passenger',
    repositoryUrl: 'https://github.com/example/native-passenger',
    branch: 'main',
    runtimeAdapter: 'passenger',
    runtime: { nodeMajor: 24, entryFile: 'dist/server.js' },
  });

  const activated = await registry.activatePassengerRelease(application.id, {
    operationId,
    releaseId: operationId,
    previousReleaseId: null,
    commitSha: 'b'.repeat(40),
    runtime: application.runtime,
  });
  assert.equal(activated.currentReleaseId, operationId);
  assert.equal(activated.previousReleaseId, null);
  assert.equal(activated.runtimeAdapter, 'passenger');
  assert.equal(activated.serviceName, null);
  assert.equal(activated.servicePort, null);
  assert.equal(activated.proxyTarget, null);
  assert.equal(activated.releases[0].releaseId, operationId);

  const retried = await registry.activatePassengerRelease(application.id, {
    operationId,
    releaseId: operationId,
    previousReleaseId: null,
    commitSha: 'b'.repeat(40),
    runtime: application.runtime,
  });
  assert.equal(retried.currentReleaseId, operationId);
  assert.equal(retried.releases.length, 1);

  await assert.rejects(
    registry.resetPassengerInitialRelease(application.id, {
      operationId: 'e09d7610-d88f-4db2-abfa-645666194486',
      releaseId: operationId,
    }),
    (error) => error instanceof ApplicationRegistryError && error.code === 'release_mismatch',
  );

  const reset = await registry.resetPassengerInitialRelease(application.id, { operationId, releaseId: operationId });
  assert.equal(reset.currentReleaseId, null);
  assert.equal(reset.currentCommitSha, null);
  assert.equal(reset.state, 'draft');
  assert.equal(reset.releases.length, 0);
});

test('createNodeApplication defaults to passenger runtimeAdapter when port is omitted', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  const app = await registry.createNodeApplication({
    serverId: 'server-1',
    name: 'Default Node',
    repositoryUrl: 'https://github.com/example/default-node',
  });
  assert.equal(app.runtimeAdapter, 'passenger');
  assert.equal(app.servicePort, null);
  assert.equal(app.proxyTarget, null);
});

test('markPassengerMigrated transitions direct-systemd application to passenger and clears legacy systemd fields', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  const direct = await registry.createNodeApplication({
    serverId: 'server-1',
    name: 'Migrating Node',
    repositoryUrl: 'https://github.com/example/migrating-node',
    runtimeAdapter: 'direct-systemd',
    runtime: { port: 3100 },
  });
  assert.equal(direct.runtimeAdapter, 'direct-systemd');
  assert.equal(direct.servicePort, 3100);
  assert.deepEqual(direct.proxyTarget, { host: '127.0.0.1', port: 3100 });

  const migrated = await registry.markPassengerMigrated(direct.id, { operationId: 'mig-1' });
  assert.equal(migrated.runtimeAdapter, 'passenger');
  assert.equal(migrated.serviceName, null);
  assert.equal(migrated.servicePort, null);
  assert.equal(migrated.proxyTarget, null);

  const fetched = await registry.getApplication(direct.id);
  assert.equal(fetched.runtimeAdapter, 'passenger');
  assert.equal(fetched.servicePort, null);
  assert.equal(fetched.proxyTarget, null);

  // Idempotent call
  const idempotent = await registry.markPassengerMigrated(direct.id);
  assert.equal(idempotent.runtimeAdapter, 'passenger');
});

