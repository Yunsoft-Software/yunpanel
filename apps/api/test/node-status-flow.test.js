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

test('Node process status refresh is queued, sanitized and available through the status endpoint', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'node-status-test' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'node-status-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();
  const application = await applicationRegistry.createNodeApplication({
    serverId: enrolled.server.id,
    name: 'Status Node',
    repositoryUrl: 'https://github.com/Yunsoft-Software/status-node',
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

  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    applicationRegistry,
    jobRegistry,
    domainRegistry: createDomainRegistry(),
    certificateRegistry: createCertificateRegistry(),
  }));

  await withServer(app, async (baseUrl) => {
    const emptyStatus = await requestJson(`${baseUrl}/api/applications/${application.id}/status`);
    assert.equal(emptyStatus.response.status, 200);
    assert.equal(emptyStatus.payload.data, null);

    const refresh = await requestJson(`${baseUrl}/api/applications/${application.id}/status/refresh`, {
      method: 'POST',
    });
    assert.equal(refresh.response.status, 202);
    assert.equal(refresh.payload.data.operation, OPERATIONS.APP_NODE_STATUS);

    const claimed = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.payload.data.envelope.operation, OPERATIONS.APP_NODE_STATUS);
    assert.equal(claimed.payload.data.envelope.payload.releaseId, releaseId);
    assert.equal(claimed.payload.data.envelope.payload.runtime.start.entryFile, 'dist/server.js');

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
            loadState: 'loaded',
            activeState: 'active',
            subState: 'running',
            restartCount: 3,
            mainPid: 4321,
            healthy: true,
            inspectionError: false,
            rawJournal: 'not persisted',
          },
        },
      },
    );
    assert.equal(completed.response.status, 200);
    assert.equal('rawJournal' in completed.payload.data.result, false);

    const status = await requestJson(`${baseUrl}/api/applications/${application.id}/status`);
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.data.status, 'succeeded');
    assert.equal(status.payload.data.result.activeState, 'active');
    assert.equal(status.payload.data.result.restartCount, 3);
    assert.equal(status.payload.data.result.mainPid, 4321);
    assert.equal(status.payload.data.result.healthy, true);
  });
});
