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

function serviceName(applicationId) {
  const digest = createHash('sha256').update(applicationId).digest('hex').slice(0, 16);
  return `yunpanel-node-${digest}.service`;
}

test('Node application deploy reconciles a healthy systemd release and proxy target', async () => {
  const adminToken = 'node-application-admin-token';
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'node-flow' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'node-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();
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
    const created = await requestJson(`${baseUrl}/api/applications`, {
      method: 'POST',
      token: adminToken,
      body: {
        type: 'node',
        serverId: enrolled.server.id,
        name: 'API Service',
        repositoryUrl: 'https://github.com/Yunsoft-Software/api-service',
        branch: 'main',
        runtime: {
          nodeMajor: 24,
          installMode: 'ci',
          buildScript: 'build',
          startMode: 'node',
          entryFile: 'dist/server.js',
          port: 3300,
          healthPath: '/health',
          healthTimeoutSeconds: 30,
          restartPolicy: 'on-failure',
        },
      },
    });

    assert.equal(created.response.status, 201);
    const application = created.payload.data;
    assert.equal(application.type, 'node');
    assert.equal(application.webRoot, null);
    assert.deepEqual(application.proxyTarget, { host: '127.0.0.1', port: 3300 });
    assert.equal(application.runtime.start.entryFile, 'dist/server.js');

    const deploy = await requestJson(`${baseUrl}/api/applications/${application.id}/deploy`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(deploy.response.status, 202);
    assert.equal(deploy.payload.data.job.operation, OPERATIONS.APP_NODE_DEPLOY);
    assert.equal(deploy.payload.data.application.state, 'deploying');

    const claimed = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.payload.data.envelope.operation, OPERATIONS.APP_NODE_DEPLOY);
    const deploymentId = claimed.payload.data.job.id;
    assert.equal(claimed.payload.data.envelope.payload.deploymentId, deploymentId);
    assert.equal(claimed.payload.data.envelope.payload.runtime.port, 3300);

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
            previousReleaseId: null,
            commitSha: 'c'.repeat(40),
            serviceName: serviceName(application.id),
            port: 3300,
            healthPath: '/health',
            healthy: true,
            rawLogs: 'must not persist',
          },
        },
      },
    );
    assert.equal(completed.response.status, 200);
    assert.equal('rawLogs' in completed.payload.data.result, false);

    const active = await applicationRegistry.getApplication(application.id);
    assert.equal(active.state, 'active');
    assert.equal(active.currentReleaseId, deploymentId);
    assert.equal(active.currentCommitSha, 'c'.repeat(40));
    assert.equal(active.serviceName, serviceName(application.id));
    assert.equal(active.servicePort, 3300);
    assert.equal(active.healthPath, '/health');
    assert.deepEqual(active.proxyTarget, { host: '127.0.0.1', port: 3300 });

    const rollback = await requestJson(`${baseUrl}/api/applications/${application.id}/rollback`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(rollback.response.status, 409);
    assert.equal(rollback.payload.error.code, 'rollback_not_supported');
  });
});

test('Node deploy result cannot change the desired port or service identity', async () => {
  const registry = createJobRegistry();
  const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
  const job = await registry.enqueue({
    serverId: 'server-1',
    type: 'app.node.deploy',
    operation: OPERATIONS.APP_NODE_DEPLOY,
    payload: {
      applicationId,
      repositoryUrl: 'https://github.com/example/node-app',
      branch: 'main',
      runtime: { nodeMajor: 24, port: 3300 },
      retention: 5,
    },
    resourceType: 'application',
    resourceId: applicationId,
  });
  await registry.claimNext('server-1');

  await assert.rejects(
    registry.complete({
      serverId: 'server-1',
      jobId: job.id,
      status: 'succeeded',
      result: {
        deploymentId: job.id,
        releaseId: job.id,
        previousReleaseId: null,
        commitSha: 'd'.repeat(40),
        serviceName: serviceName(applicationId),
        port: 9999,
        healthPath: '/health',
        healthy: true,
      },
    }),
    /port does not match desired state/,
  );

  assert.equal((await registry.getJob(job.id)).status, 'running');
});
