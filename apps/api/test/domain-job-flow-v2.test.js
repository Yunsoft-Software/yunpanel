import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
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

test('domain stage and activation accept only the strict agent result schema', async () => {
  const adminToken = 'strict-domain-admin-token';
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'strict-domain-flow' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'strict-domain-host' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();
  const app = createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    jobRegistry,
    adminToken,
  });

  await withServer(app, async (baseUrl) => {
    const created = await requestJson(`${baseUrl}/api/domains`, {
      method: 'POST',
      token: adminToken,
      body: {
        serverId: enrolled.server.id,
        primaryDomain: 'strict.example.com',
        targetType: 'proxy',
        target: { upstreamPort: 3300 },
      },
    });
    const domain = created.payload.data;

    await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST', token: adminToken });
    const stageClaim = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });

    const checksum = 'c'.repeat(64);
    const configName = 'yunpanel-strict.example.com.conf';
    const stageResult = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${stageClaim.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: { checksum, configName, bytes: 640 },
        },
      },
    );
    assert.equal(stageResult.response.status, 200);
    assert.equal((await domainRegistry.getDomain(domain.id)).state, 'staged');

    await requestJson(`${baseUrl}/api/domains/${domain.id}/activate`, { method: 'POST', token: adminToken });
    const activationClaim = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });
    assert.equal(activationClaim.payload.data.envelope.operation, OPERATIONS.DOMAIN_ACTIVATE);

    const activationResult = await requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${activationClaim.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: { checksum, configName, active: true },
        },
      },
    );
    assert.equal(activationResult.response.status, 200);
    const activeDomain = await domainRegistry.getDomain(domain.id);
    assert.equal(activeDomain.state, 'active');
    assert.equal(activeDomain.appliedRevision, activeDomain.desiredRevision);
  });
});
