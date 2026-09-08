import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(url, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: response.status === 204 ? null : await response.json() };
}

test('rollback switches application state to a retained previous release', async () => {
  const adminToken = 'rollback-admin-token';
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'rollback-test' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'rollback-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();

  const application = await applicationRegistry.createApplication({
    serverId: enrolled.server.id,
    name: 'Rollback Site',
    repositoryUrl: 'https://github.com/Yunsoft-Software/rollback-site',
    build: { mode: 'npm', outputDir: 'dist' },
  });

  const releaseOne = 'ff830043-9752-4640-83b4-3a1998de78a0';
  await applicationRegistry.markDeploying(application.id, releaseOne);
  await applicationRegistry.markDeployed(application.id, {
    deploymentId: releaseOne,
    releaseId: releaseOne,
    commitSha: '1'.repeat(40),
    artifactFiles: 10,
    artifactBytes: 1000,
  });

  const releaseTwo = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  await applicationRegistry.markDeploying(application.id, releaseTwo);
  await applicationRegistry.markDeployed(application.id, {
    deploymentId: releaseTwo,
    releaseId: releaseTwo,
    commitSha: '2'.repeat(40),
    artifactFiles: 12,
    artifactBytes: 1200,
  });

  const app = createApp({
    environment: 'production',
    registry: serverRegistry,
    applicationRegistry,
    jobRegistry,
    domainRegistry: createDomainRegistry(),
    certificateRegistry: createCertificateRegistry(),
    adminToken,
  });

  await withServer(app, async (baseUrl) => {
    const rollback = await requestJson(`${baseUrl}/api/applications/${application.id}/rollback`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(rollback.response.status, 202);
    assert.equal(rollback.payload.data.job.operation, OPERATIONS.APP_STATIC_ROLLBACK);
    assert.equal(rollback.payload.data.application.state, 'rolling_back');
    assert.equal(rollback.payload.data.application.pendingRollbackReleaseId, releaseOne);

    const claimed = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.payload.data.envelope.operation, OPERATIONS.APP_STATIC_ROLLBACK);
    assert.equal(claimed.payload.data.envelope.payload.releaseId, releaseOne);

    const completed = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${claimed.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: {
            releaseId: releaseOne,
            previousReleaseId: releaseTwo,
            active: true,
            ignored: 'not persisted',
          },
        },
      },
    );
    assert.equal(completed.response.status, 200);
    assert.equal('ignored' in completed.payload.data.result, false);

    const rolledBack = await applicationRegistry.getApplication(application.id);
    assert.equal(rolledBack.state, 'active');
    assert.equal(rolledBack.currentReleaseId, releaseOne);
    assert.equal(rolledBack.previousReleaseId, releaseTwo);
    assert.equal(rolledBack.currentCommitSha, '1'.repeat(40));
    assert.equal(rolledBack.activeDeploymentId, null);
    assert.equal(rolledBack.pendingRollbackReleaseId, null);
    assert.ok(rolledBack.lastRolledBackAt);
  });
});

test('failed rollback leaves the current release active', async () => {
  const registry = createApplicationRegistry({ serverExists: async () => true });
  const application = await registry.createApplication({
    serverId: 'server-1',
    name: 'Stable Site',
    repositoryUrl: 'https://github.com/Yunsoft-Software/stable-site',
  });
  const first = 'ff830043-9752-4640-83b4-3a1998de78a0';
  const second = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  await registry.markDeploying(application.id, first);
  await registry.markDeployed(application.id, { deploymentId: first, releaseId: first, commitSha: 'a'.repeat(40) });
  await registry.markDeploying(application.id, second);
  await registry.markDeployed(application.id, { deploymentId: second, releaseId: second, commitSha: 'b'.repeat(40) });

  const operationId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
  await registry.markRollingBack(application.id, operationId, first);
  const failed = await registry.markFailed(application.id, operationId, 'rollback_release_missing');
  assert.equal(failed.state, 'active');
  assert.equal(failed.currentReleaseId, second);
  assert.equal(failed.currentCommitSha, 'b'.repeat(40));
  assert.equal(failed.lastError, 'rollback_release_missing');
});
