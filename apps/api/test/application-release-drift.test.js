import assert from 'node:assert/strict';
import test from 'node:test';
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

test('successful agent deploy result cannot overwrite control-plane state when previous release drifts', async () => {
  const adminToken = 'release-drift-admin-token';
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'release-drift' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'release-drift-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();

  const application = await applicationRegistry.createApplication({
    serverId: enrolled.server.id,
    name: 'Drift Site',
    repositoryUrl: 'https://github.com/Yunsoft-Software/drift-site',
  });
  const currentRelease = 'ff830043-9752-4640-83b4-3a1998de78a0';
  await applicationRegistry.markDeploying(application.id, currentRelease);
  await applicationRegistry.markDeployed(application.id, {
    deploymentId: currentRelease,
    releaseId: currentRelease,
    commitSha: 'a'.repeat(40),
    previousReleaseId: null,
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
    const deploy = await requestJson(`${baseUrl}/api/applications/${application.id}/deploy`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(deploy.response.status, 202);

    const claimed = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    const deploymentId = claimed.payload.data.job.id;

    const completed = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${deploymentId}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: {
            deploymentId,
            releaseId: deploymentId,
            commitSha: 'b'.repeat(40),
            previousReleaseId: null,
            artifactFiles: 10,
            artifactBytes: 4096,
          },
        },
      },
    );
    assert.equal(completed.response.status, 200);
    assert.equal(completed.payload.data.status, 'succeeded');

    const state = await applicationRegistry.getApplication(application.id);
    assert.equal(state.state, 'active');
    assert.equal(state.currentReleaseId, currentRelease);
    assert.equal(state.currentCommitSha, 'a'.repeat(40));
    assert.equal(state.activeDeploymentId, null);
    assert.equal(state.lastError, 'reconcile_release_state_drift');
  });
});
