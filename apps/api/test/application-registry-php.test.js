import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationRegistryError,
  createApplicationRegistry,
} from '../src/application-registry.js';

const serverId = 'a6dad2a5-4110-4f1c-885c-f03a1cc11e03';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const deploymentId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';

function registry() {
  return createApplicationRegistry({
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    serverExists: async (id) => id === serverId,
  });
}

test('creates an idempotent PHP Application with canonical current/public web root', async () => {
  const applications = registry();
  const first = await applications.createPhpApplication({
    applicationId,
    serverId,
    name: 'PHP Site',
  });
  const second = await applications.createPhpApplication({
    applicationId,
    serverId,
    name: 'PHP Site',
  });

  assert.deepEqual(first, second);
  assert.equal(first.id, applicationId);
  assert.equal(first.type, 'php');
  assert.equal(first.repositoryUrl, null);
  assert.equal(first.branch, null);
  assert.equal(first.retention, 2);
  assert.equal(first.runtime, null);
  assert.equal(first.runtimeAdapter, null);
  assert.equal(first.build, null);
  assert.equal(first.webRoot, `/var/lib/yunpanel/apps/${applicationId}/current/public`);
  assert.equal(first.proxyTarget, null);
  assert.equal(first.serviceName, null);
  assert.equal(first.servicePort, null);
  assert.equal(first.healthPath, null);
  assert.deepEqual(first.releases, []);
});

test('PHP Application cannot enter legacy Git deploy flow', async () => {
  const applications = registry();
  await applications.createPhpApplication({ applicationId, serverId, name: 'PHP Site' });

  await assert.rejects(
    applications.markDeploying(applicationId, deploymentId),
    (error) => error instanceof ApplicationRegistryError
      && error.code === 'deployment_not_supported'
      && error.status === 409,
  );
});

test('PHP Application identity fails closed when deterministic fields differ', async () => {
  const applications = registry();
  await applications.createPhpApplication({ applicationId, serverId, name: 'PHP Site' });

  await assert.rejects(
    applications.createPhpApplication({ applicationId, serverId, name: 'Different PHP Site' }),
    (error) => error instanceof ApplicationRegistryError
      && error.code === 'application_identity_conflict'
      && error.status === 409,
  );
});
