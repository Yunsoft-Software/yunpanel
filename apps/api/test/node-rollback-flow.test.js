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

test('Node rollback queues desired runtime state and reconciles a healthy retained release', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'node-rollback-test' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'node-rollback-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();

  const application = await applicationRegistry.createNodeApplication({
    serverId: enrolled.server.id,
    name: 'Rollback Node',
    repositoryUrl: 'https://github.com/Yunsoft-Software/rollback-node',
    runtime: runtime(),
  });
  const managedService = serviceName(application.id);
  const releaseOne = 'ff830043-9752-4640-83b4-3a1998de78a0';
  const releaseTwo = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

  await applicationRegistry.markDeploying(application.id, releaseOne);
  await applicationRegistry.markDeployed(application.id, {
    deploymentId: releaseOne,
    releaseId: releaseOne,
    previousReleaseId: null,
    commitSha: '1'.repeat(40),
    serviceName: managedService,
    port: 3100,
    healthPath: '/health',
    healthy: true,
  });
  await applicationRegistry.markDeploying(application.id, releaseTwo);
  await applicationRegistry.markDeployed(application.id, {
    deploymentId: releaseTwo,
    releaseId: releaseTwo,
    previousReleaseId: releaseOne,
    commitSha: '2'.repeat(40),
    serviceName: managedService,
    port: 3100,
    healthPath: '/health',
    healthy: true,
  });

  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    applicationRegistry,
    jobRegistry,
    domainRegistry: createDomainRegistry(),
    certificateRegistry: createCertificateRegistry(),
  }));

  await withServer(app, async (baseUrl) => {
    const rollback = await requestJson(`${baseUrl}/api/applications/${application.id}/rollback`, {
      method: 'POST',
    });
    assert.equal(rollback.response.status, 202);
    assert.equal(rollback.payload.data.job.operation, OPERATIONS.APP_NODE_ROLLBACK);
    assert.equal(rollback.payload.data.application.state, 'rolling_back');
    assert.equal(rollback.payload.data.application.pendingRollbackReleaseId, releaseOne);

    const claimed = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.payload.data.envelope.operation, OPERATIONS.APP_NODE_ROLLBACK);
    assert.equal(claimed.payload.data.envelope.payload.releaseId, releaseOne);
    assert.equal(claimed.payload.data.envelope.payload.currentReleaseId, releaseTwo);
    assert.equal(claimed.payload.data.envelope.payload.runtime.port, 3100);
    assert.equal(claimed.payload.data.envelope.payload.runtime.healthPath, '/health');

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
            serviceName: managedService,
            port: 3100,
            healthPath: '/health',
            healthy: true,
            active: true,
            ignored: 'not persisted',
          },
        },
      },
    );
    assert.equal(completed.response.status, 200);
    assert.equal(completed.payload.data.result.serviceName, managedService);
    assert.equal('ignored' in completed.payload.data.result, false);

    const rolledBack = await applicationRegistry.getApplication(application.id);
    assert.equal(rolledBack.state, 'active');
    assert.equal(rolledBack.currentReleaseId, releaseOne);
    assert.equal(rolledBack.previousReleaseId, releaseTwo);
    assert.equal(rolledBack.currentCommitSha, '1'.repeat(40));
    assert.equal(rolledBack.serviceName, managedService);
    assert.deepEqual(rolledBack.proxyTarget, { host: '127.0.0.1', port: 3100 });
    assert.equal(rolledBack.activeDeploymentId, null);
    assert.equal(rolledBack.pendingRollbackReleaseId, null);
    assert.ok(rolledBack.lastRolledBackAt);
  });
});
