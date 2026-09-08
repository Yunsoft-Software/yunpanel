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

async function jsonRequest(url, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

test('domain desired state moves through stage and activate jobs before becoming active', async () => {
  const adminToken = 'bootstrap-admin-token-for-test';
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'domain-flow' });
  const enrolled = await serverRegistry.enrollServer({
    token: enrollment.token,
    hostname: 'yun-domain-test',
  });
  const { server, agentToken } = enrolled;

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
    const created = await jsonRequest(`${baseUrl}/api/domains`, {
      method: 'POST',
      token: adminToken,
      body: {
        serverId: server.id,
        primaryDomain: 'app.example.com',
        aliases: ['www.app.example.com'],
        targetType: 'proxy',
        target: { upstreamPort: 3100 },
        httpsMode: 'off',
      },
    });
    assert.equal(created.response.status, 201);
    const domain = created.payload.data;
    assert.equal(domain.state, 'draft');
    assert.equal(domain.desiredRevision, 1);
    assert.equal(domain.appliedRevision, 0);

    const activationBeforeStage = await jsonRequest(`${baseUrl}/api/domains/${domain.id}/activate`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(activationBeforeStage.response.status, 409);
    assert.equal(activationBeforeStage.payload.error.code, 'staged_revision_required');

    const stageQueued = await jsonRequest(`${baseUrl}/api/domains/${domain.id}/stage`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(stageQueued.response.status, 202);
    assert.equal(stageQueued.payload.data.operation, OPERATIONS.DOMAIN_STAGE);
    assert.equal(stageQueued.payload.data.status, 'queued');

    const duplicateStage = await jsonRequest(`${baseUrl}/api/domains/${domain.id}/stage`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(duplicateStage.response.status, 409);
    assert.equal(duplicateStage.payload.error.code, 'domain_job_conflict');

    const claimedStage = await jsonRequest(`${baseUrl}/api/servers/${server.id}/commands/next`, {
      token: agentToken,
    });
    assert.equal(claimedStage.response.status, 200);
    assert.equal(claimedStage.payload.data.envelope.operation, OPERATIONS.DOMAIN_STAGE);
    assert.equal(claimedStage.payload.data.envelope.payload.primaryDomain, 'app.example.com');

    const checksum = 'a'.repeat(64);
    const stageCompleted = await jsonRequest(
      `${baseUrl}/api/servers/${server.id}/commands/${claimedStage.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: agentToken,
        body: {
          status: 'succeeded',
          result: {
            configName: 'app.example.com.conf',
            checksum,
          },
        },
      },
    );
    assert.equal(stageCompleted.response.status, 200);
    assert.equal(stageCompleted.payload.data.status, 'succeeded');

    const stagedDomain = await jsonRequest(`${baseUrl}/api/domains/${domain.id}`, { token: adminToken });
    assert.equal(stagedDomain.payload.data.state, 'staged');
    assert.equal(stagedDomain.payload.data.stagedRevision, 1);
    assert.equal(stagedDomain.payload.data.stagedChecksum, checksum);
    assert.equal(stagedDomain.payload.data.appliedRevision, 0);

    const activateQueued = await jsonRequest(`${baseUrl}/api/domains/${domain.id}/activate`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(activateQueued.response.status, 202);
    assert.equal(activateQueued.payload.data.operation, OPERATIONS.DOMAIN_ACTIVATE);

    const claimedActivate = await jsonRequest(`${baseUrl}/api/servers/${server.id}/commands/next`, {
      token: agentToken,
    });
    assert.equal(claimedActivate.response.status, 200);
    assert.equal(claimedActivate.payload.data.envelope.operation, OPERATIONS.DOMAIN_ACTIVATE);
    assert.equal(claimedActivate.payload.data.envelope.payload.checksum, checksum);

    const activateCompleted = await jsonRequest(
      `${baseUrl}/api/servers/${server.id}/commands/${claimedActivate.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: agentToken,
        body: {
          status: 'succeeded',
          result: { checksum },
        },
      },
    );
    assert.equal(activateCompleted.response.status, 200);

    const activeDomain = await jsonRequest(`${baseUrl}/api/domains/${domain.id}`, { token: adminToken });
    assert.equal(activeDomain.payload.data.state, 'active');
    assert.equal(activeDomain.payload.data.appliedRevision, 1);
    assert.equal(activeDomain.payload.data.lastError, null);

    const noMoreCommands = await jsonRequest(`${baseUrl}/api/servers/${server.id}/commands/next`, {
      token: agentToken,
    });
    assert.equal(noMoreCommands.response.status, 204);
  });
});
