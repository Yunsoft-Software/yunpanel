import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

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

test('Node restart queues the active release and accepts only healthy managed service completion', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'node-restart-test' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'node-restart-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();
  const application = await applicationRegistry.createNodeApplication({
    serverId: enrolled.server.id,
    name: 'Restart Node',
    repositoryUrl: 'https://github.com/Yunsoft-Software/restart-node',
    runtime: runtime(),
  });
  const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  const managedService = serviceName(application.id);
  await applicationRegistry.markDeploying(application.id, releaseId);
  await applicationRegistry.markDeployed(application.id, {
    deploymentId: releaseId,
    releaseId,
    previousReleaseId: null,
    commitSha: 'a'.repeat(40),
    serviceName: managedService,
    port: 3100,
    healthPath: '/health',
    healthy: true,
  });
  const configurationPreview = await applicationRegistry.previewNodeConfiguration(application.id, {
    ...(await applicationRegistry.getApplication(application.id)).runtime,
    mode: 'development',
  });
  const pendingConfiguration = await applicationRegistry.updateNodeConfiguration({
    applicationId: application.id,
    expectedRevision: configurationPreview.currentRevision,
    runtime: configurationPreview.nextRuntime,
    previewDigest: configurationPreview.previewDigest,
    confirmation: configurationPreview.confirmation,
  });
  assert.equal(pendingConfiguration.configurationPending, true);
  assert.equal(pendingConfiguration.runtime.mode, 'development');
  assert.equal(pendingConfiguration.activeRuntime.mode, 'production');

  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    applicationRegistry,
    jobRegistry,
    domainRegistry: createDomainRegistry(),
    certificateRegistry: createCertificateRegistry(),
  }));

  await withServer(app, async (baseUrl) => {
    const restart = await requestJson(`${baseUrl}/api/applications/${application.id}/restart`, {
      method: 'POST',
    });
    assert.equal(restart.response.status, 202);
    assert.equal(restart.payload.data.operation, OPERATIONS.APP_NODE_RESTART);

    const claimed = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.payload.data.envelope.operation, OPERATIONS.APP_NODE_RESTART);
    assert.equal(claimed.payload.data.envelope.payload.releaseId, releaseId);
    assert.equal(claimed.payload.data.envelope.payload.runtime.port, 3100);
    assert.equal(claimed.payload.data.envelope.payload.runtime.mode, 'production');

    const completed = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${claimed.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: {
            releaseId,
            serviceName: managedService,
            port: 3100,
            healthPath: '/health',
            healthy: true,
            restarted: true,
          },
        },
      },
    );
    assert.equal(completed.response.status, 200);
    assert.equal(completed.payload.data.result.restarted, true);

    const unchangedApplication = await applicationRegistry.getApplication(application.id);
    assert.equal(unchangedApplication.state, 'active');
    assert.equal(unchangedApplication.currentReleaseId, releaseId);
    assert.equal(unchangedApplication.currentCommitSha, 'a'.repeat(40));
  });
});
