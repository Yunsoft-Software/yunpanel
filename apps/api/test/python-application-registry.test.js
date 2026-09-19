import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApplicationRegistry, ApplicationRegistryError } from '../src/application-registry.js';
import { resolveWebsiteDomainTarget } from '../src/website-domain-target.js';

test('python application stores normalized runtime configuration and release lifecycle', async () => {
  let clock = Date.parse('2026-09-20T00:00:00.000Z');
  const registry = createApplicationRegistry({
    now: () => clock,
    serverExists: async (serverId) => serverId === 'server-1',
  });

  const app = await registry.createPythonApplication({
    serverId: 'server-1',
    name: 'Django API',
    repositoryUrl: 'https://github.com/example/django-api',
    branch: 'main',
    runtime: {
      pythonVersion: '3.12',
      appServer: 'gunicorn',
      entryPoint: 'myproject.wsgi:application',
      workers: 3,
    },
  });

  assert.equal(app.type, 'python');
  assert.equal(app.runtime.pythonVersion, '3.12');
  assert.equal(app.runtime.appServer, 'gunicorn');
  assert.equal(app.runtime.entryPoint, 'myproject.wsgi:application');
  assert.equal(app.runtime.workers, 3);
  assert.equal(app.runtime.port, null);
  assert.match(app.serviceName, /^yunpanel-python-[a-f0-9]{16}\.service$/);
  assert.match(app.socketPath, /^\/run\/yunpanel\/python-[0-9a-f-]{36}\.sock$/);
  assert.equal(app.state, 'draft');

  const deploymentId = randomUUID();
  await registry.markDeploying(app.id, deploymentId);

  clock += 5_000;
  const deployed = await registry.markDeployed(app.id, {
    deploymentId,
    releaseId: deploymentId,
    commitSha: 'a'.repeat(40),
  });
  assert.equal(deployed.state, 'active');
  assert.equal(deployed.currentReleaseId, deploymentId);
  assert.equal(deployed.releases.length, 1);

  const secondDeployment = randomUUID();
  await registry.markDeploying(app.id, secondDeployment);
  const secondDeployed = await registry.markDeployed(app.id, {
    deploymentId: secondDeployment,
    releaseId: secondDeployment,
    commitSha: 'b'.repeat(40),
  });
  assert.equal(secondDeployed.currentReleaseId, secondDeployment);
  assert.equal(secondDeployed.previousReleaseId, deploymentId);
  assert.equal(secondDeployed.releases.length, 2);

  const rollbackOpId = randomUUID();
  await registry.markRollingBack(app.id, rollbackOpId, deploymentId);
  const rolledBack = await registry.markRolledBack(app.id, {
    operationId: rollbackOpId,
    releaseId: deploymentId,
    previousReleaseId: secondDeployment,
  });
  assert.equal(rolledBack.currentReleaseId, deploymentId);
  assert.equal(rolledBack.previousReleaseId, secondDeployment);
});

test('python application validates port conflicts when running in loopback port mode', async () => {
  const registry = createApplicationRegistry({
    serverExists: async () => true,
  });

  await registry.createPythonApplication({
    serverId: 'server-1',
    name: 'FastAPI Service 1',
    repositoryUrl: 'https://github.com/example/fastapi-1',
    runtime: {
      appServer: 'uvicorn',
      entryPoint: 'main:app',
      port: 8000,
    },
  });

  await assert.rejects(
    registry.createPythonApplication({
      serverId: 'server-1',
      name: 'FastAPI Service 2',
      repositoryUrl: 'https://github.com/example/fastapi-2',
      runtime: {
        appServer: 'uvicorn',
        entryPoint: 'main:app',
        port: 8000,
      },
    }),
    (error) => error instanceof ApplicationRegistryError && error.code === 'python_port_conflict',
  );
});

test('websiteDomainTarget resolves Python application socket and loopback targets', async () => {
  const registry = createApplicationRegistry({
    serverExists: async () => true,
  });

  const socketApp = await registry.createPythonApplication({
    serverId: 'server-1',
    name: 'Socket App',
    repositoryUrl: 'https://github.com/example/socket-app',
    runtime: { entryPoint: 'app:app' },
  });

  const portApp = await registry.createPythonApplication({
    serverId: 'server-1',
    name: 'Port App',
    repositoryUrl: 'https://github.com/example/port-app',
    runtime: { entryPoint: 'app:app', port: 8050 },
  });

  const socketWebsite = {
    id: randomUUID(),
    serverId: 'server-1',
    applicationId: socketApp.id,
    runtimeType: 'python',
  };
  const socketDomain = {
    id: randomUUID(),
    serverId: 'server-1',
    websiteId: socketWebsite.id,
    targetType: 'python',
    nginxSettings: { websocket: true },
  };

  const socketTarget = await resolveWebsiteDomainTarget({
    domain: socketDomain,
    websiteRegistry: { getWebsite: async () => socketWebsite },
    applicationRegistry: registry,
  });

  assert.equal(socketTarget.source, 'python');
  assert.equal(socketTarget.targetType, 'python');
  assert.equal(socketTarget.target.socketPath, socketApp.socketPath);
  assert.equal(socketTarget.target.websocket, true);

  const portWebsite = {
    id: randomUUID(),
    serverId: 'server-1',
    applicationId: portApp.id,
    runtimeType: 'python',
  };
  const portDomain = {
    id: randomUUID(),
    serverId: 'server-1',
    websiteId: portWebsite.id,
    targetType: 'python',
    nginxSettings: { websocket: true },
  };

  const portTarget = await resolveWebsiteDomainTarget({
    domain: portDomain,
    websiteRegistry: { getWebsite: async () => portWebsite },
    applicationRegistry: registry,
  });

  assert.equal(portTarget.source, 'python');
  assert.equal(portTarget.targetType, 'proxy');
  assert.equal(portTarget.target.upstreamHost, '127.0.0.1');
  assert.equal(portTarget.target.upstreamPort, 8050);
});
