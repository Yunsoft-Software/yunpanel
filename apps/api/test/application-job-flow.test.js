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

  return {
    response,
    payload: response.status === 204 ? null : await response.json(),
  };
}

async function createContext() {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'static-deploy-test' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'static-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });

  return {
    serverRegistry,
    enrolled,
    applicationRegistry,
    domainRegistry: createDomainRegistry(),
    jobRegistry: createJobRegistry(),
    certificateRegistry: createCertificateRegistry(),
  };
}

test('static application deploy moves through queue and reconciles the active release', async () => {
  const adminToken = 'static-application-admin-token';
  const context = await createContext();
  const {
    serverRegistry,
    enrolled,
    applicationRegistry,
    domainRegistry,
    jobRegistry,
    certificateRegistry,
  } = context;

  const app = createApp({
    environment: 'production',
    registry: serverRegistry,
    applicationRegistry,
    domainRegistry,
    jobRegistry,
    certificateRegistry,
    adminToken,
  });

  await withServer(app, async (baseUrl) => {
    const created = await requestJson(`${baseUrl}/api/applications`, {
      method: 'POST',
      token: adminToken,
      body: {
        serverId: enrolled.server.id,
        name: 'Marketing Site',
        repositoryUrl: 'https://github.com/Yunsoft-Software/example-static',
        branch: 'main',
        build: {
          mode: 'npm',
          installMode: 'ci',
          buildScript: 'build',
          outputDir: 'dist',
        },
        retention: 5,
      },
    });

    assert.equal(created.response.status, 201);
    const application = created.payload.data;
    assert.equal(application.state, 'draft');
    assert.equal(application.currentReleaseId, null);
    assert.equal(application.webRoot, `/var/www/yunpanel/apps/${application.id}/current`);

    const deploy = await requestJson(`${baseUrl}/api/applications/${application.id}/deploy`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(deploy.response.status, 202);
    assert.equal(deploy.payload.data.job.operation, OPERATIONS.APP_STATIC_DEPLOY);
    assert.equal(deploy.payload.data.application.state, 'deploying');
    assert.equal(deploy.payload.data.application.activeDeploymentId, deploy.payload.data.job.id);

    const duplicate = await requestJson(`${baseUrl}/api/applications/${application.id}/deploy`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.payload.error.code, 'application_job_conflict');

    const claimed = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.payload.data.envelope.operation, OPERATIONS.APP_STATIC_DEPLOY);
    assert.equal(claimed.payload.data.envelope.payload.applicationId, application.id);
    assert.equal(claimed.payload.data.envelope.payload.deploymentId, deploy.payload.data.job.id);
    assert.equal(claimed.payload.data.envelope.payload.repositoryUrl, 'https://github.com/Yunsoft-Software/example-static.git');

    const firstReleaseId = deploy.payload.data.job.id;
    const completed = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${firstReleaseId}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: {
            deploymentId: firstReleaseId,
            releaseId: firstReleaseId,
            commitSha: 'A'.repeat(40),
            previousReleaseId: null,
            artifactFiles: 24,
            artifactBytes: 8192,
            stdout: 'must not persist',
          },
        },
      },
    );
    assert.equal(completed.response.status, 200);
    assert.equal(completed.payload.data.result.commitSha, 'a'.repeat(40));
    assert.equal('stdout' in completed.payload.data.result, false);

    const active = await requestJson(`${baseUrl}/api/applications/${application.id}`, { token: adminToken });
    assert.equal(active.payload.data.state, 'active');
    assert.equal(active.payload.data.currentReleaseId, firstReleaseId);
    assert.equal(active.payload.data.previousReleaseId, null);
    assert.equal(active.payload.data.currentCommitSha, 'a'.repeat(40));
    assert.equal(active.payload.data.activeDeploymentId, null);

    const secondDeploy = await requestJson(`${baseUrl}/api/applications/${application.id}/deploy`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(secondDeploy.response.status, 202);

    const secondClaim = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(secondClaim.response.status, 200);

    const failed = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${secondClaim.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'failed',
          error: {
            code: 'npm_build_failed',
            message: 'Build failed',
            stack: 'must not persist',
          },
        },
      },
    );
    assert.equal(failed.response.status, 200);

    const afterFailure = await applicationRegistry.getApplication(application.id);
    assert.equal(afterFailure.state, 'active');
    assert.equal(afterFailure.currentReleaseId, firstReleaseId);
    assert.equal(afterFailure.activeDeploymentId, null);
    assert.equal(afterFailure.lastError, 'npm_build_failed');
  });
});

test('cancelling a queued static deployment clears the application deployment lock', async () => {
  const adminToken = 'static-cancel-admin-token';
  const context = await createContext();
  const app = createApp({
    environment: 'production',
    registry: context.serverRegistry,
    applicationRegistry: context.applicationRegistry,
    domainRegistry: context.domainRegistry,
    jobRegistry: context.jobRegistry,
    certificateRegistry: context.certificateRegistry,
    adminToken,
  });

  const application = await context.applicationRegistry.createApplication({
    serverId: context.enrolled.server.id,
    name: 'Docs',
    repositoryUrl: 'https://github.com/Yunsoft-Software/docs-static',
    build: { mode: 'none', outputDir: '.' },
  });

  await withServer(app, async (baseUrl) => {
    const deploy = await requestJson(`${baseUrl}/api/applications/${application.id}/deploy`, {
      method: 'POST',
      token: adminToken,
    });
    const jobId = deploy.payload.data.job.id;

    const cancelled = await requestJson(`${baseUrl}/api/jobs/${jobId}/cancel`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.payload.data.status, 'cancelled');

    const state = await context.applicationRegistry.getApplication(application.id);
    assert.equal(state.activeDeploymentId, null);
    assert.equal(state.state, 'error');
    assert.equal(state.lastError, 'deployment_cancelled');
  });
});
