import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createApplicationEnvironmentRegistry } from '../src/application-environment-registry.js';
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

test('admin environment APIs mask secrets while the assigned agent can materialize them', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'environment-server' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'environment-host' });

  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const application = await applicationRegistry.createNodeApplication({
    serverId: enrolled.server.id,
    name: 'Environment Node App',
    repositoryUrl: 'https://github.com/example/environment-node-app',
    runtime: { port: 3100 },
  });
  const applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
    masterKey: Buffer.alloc(32, 3),
    applicationExists: async (applicationId) => Boolean(await applicationRegistry.getApplication(applicationId)),
  });

  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    jobRegistry: createJobRegistry(),
    domainRegistry: createDomainRegistry(),
    certificateRegistry: createCertificateRegistry(),
  }));

  await withServer(app, async (baseUrl) => {
    const publicWrite = await requestJson(`${baseUrl}/api/applications/${application.id}/environment/PUBLIC_URL`, {
      method: 'PUT',
      body: { value: 'https://example.test', secret: false },
    });
    assert.equal(publicWrite.response.status, 200);
    assert.equal(publicWrite.payload.data.value, 'https://example.test');

    const secretWrite = await requestJson(`${baseUrl}/api/applications/${application.id}/environment/API_TOKEN`, {
      method: 'PUT',
      body: { value: 'private-token-value', secret: true },
    });
    assert.equal(secretWrite.response.status, 200);
    assert.equal(secretWrite.payload.data.secret, true);
    assert.equal('value' in secretWrite.payload.data, false);
    assert.equal(JSON.stringify(secretWrite.payload).includes('private-token-value'), false);

    const listed = await requestJson(`${baseUrl}/api/applications/${application.id}/environment`);
    assert.equal(listed.response.status, 200);
    const secret = listed.payload.data.find((entry) => entry.key === 'API_TOKEN');
    assert.equal(secret.secret, true);
    assert.equal('value' in secret, false);

    const materialized = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/applications/${application.id}/environment`,
      { token: enrolled.agentToken },
    );
    assert.equal(materialized.response.status, 200);
    assert.deepEqual(materialized.payload.data, {
      API_TOKEN: 'private-token-value',
      PUBLIC_URL: 'https://example.test',
    });
  });
});

test('an agent cannot fetch environment belonging to a different managed server', async () => {
  const serverRegistry = createServerRegistry();
  const firstToken = await serverRegistry.issueEnrollmentToken({ label: 'first' });
  const secondToken = await serverRegistry.issueEnrollmentToken({ label: 'second' });
  const first = await serverRegistry.enrollServer({ token: firstToken.token, hostname: 'first-host' });
  const second = await serverRegistry.enrollServer({ token: secondToken.token, hostname: 'second-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const application = await applicationRegistry.createNodeApplication({
    serverId: first.server.id,
    name: 'First Server App',
    repositoryUrl: 'https://github.com/example/first-server-app',
    runtime: { port: 3200 },
  });
  const applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
    masterKey: Buffer.alloc(32, 4),
    applicationExists: async (applicationId) => Boolean(await applicationRegistry.getApplication(applicationId)),
  });
  await applicationEnvironmentRegistry.setVariable({ applicationId: application.id, key: 'API_TOKEN', value: 'hidden', secret: true });

  const app = createApp({
    environment: 'production',
    registry: serverRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    jobRegistry: createJobRegistry(),
    domainRegistry: createDomainRegistry(),
    certificateRegistry: createCertificateRegistry(),
  });

  await withServer(app, async (baseUrl) => {
    const response = await requestJson(
      `${baseUrl}/api/servers/${second.server.id}/applications/${application.id}/environment`,
      { token: second.agentToken },
    );
    assert.equal(response.response.status, 404);
    assert.equal(response.payload.error.code, 'application_not_found');
  });
});
