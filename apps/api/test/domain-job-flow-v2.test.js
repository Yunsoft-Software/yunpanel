import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
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

test('domain stage and activation accept only the strict agent result schema', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'strict-domain-flow' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'strict-domain-host' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();
  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    jobRegistry,
  }));

  await withServer(app, async (baseUrl) => {
    const created = await requestJson(`${baseUrl}/api/domains`, {
      method: 'POST',
      body: {
        serverId: enrolled.server.id,
        primaryDomain: 'strict.example.com',
        targetType: 'proxy',
        target: { upstreamPort: 3300 },
      },
    });
    const domain = created.payload.data;

    await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
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

    await requestJson(`${baseUrl}/api/domains/${domain.id}/activate`, { method: 'POST' });
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

test('completed jobs are not observable before domain reconciliation finishes', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'reconciliation-barrier' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'reconciliation-host' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const originalMarkStaged = domainRegistry.markStaged;
  let enterReconciliation;
  let releaseReconciliation;
  const reconciliationEntered = new Promise((resolve) => { enterReconciliation = resolve; });
  const reconciliationReleased = new Promise((resolve) => { releaseReconciliation = resolve; });
  domainRegistry.markStaged = async (...args) => {
    enterReconciliation();
    await reconciliationReleased;
    return originalMarkStaged(...args);
  };
  const jobRegistry = createJobRegistry();
  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    jobRegistry,
  }));

  await withServer(app, async (baseUrl) => {
    const created = await requestJson(`${baseUrl}/api/domains`, {
      method: 'POST',
      body: {
        serverId: enrolled.server.id,
        primaryDomain: 'barrier.example.com',
        targetType: 'static',
        target: { root: '/var/www/barrier' },
      },
    });
    const domain = created.payload.data;
    const staged = await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
    const claimed = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, {
      token: enrolled.agentToken,
    });

    const completion = requestJson(
      `${baseUrl}/api/servers/${enrolled.server.id}/commands/${claimed.payload.data.job.id}/result`,
      {
        method: 'POST',
        token: enrolled.agentToken,
        body: {
          status: 'succeeded',
          result: {
            checksum: 'a'.repeat(64),
            configName: 'yunpanel-barrier.example.com.conf',
            bytes: 512,
          },
        },
      },
    );
    await reconciliationEntered;

    let readSettled = false;
    const jobRead = requestJson(`${baseUrl}/api/jobs/${staged.payload.data.id}`)
      .then((result) => {
        readSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(readSettled, false);

    releaseReconciliation();
    const [completed, observed] = await Promise.all([completion, jobRead]);
    assert.equal(completed.response.status, 200);
    assert.equal(observed.payload.data.status, 'succeeded');
    assert.equal((await domainRegistry.getDomain(domain.id)).state, 'staged');
  });
});

test('Domain routing update carries redirect policy and the previous canonical config through jobs', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'domain-routing-update' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'domain-routing-host' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const jobRegistry = createJobRegistry();
  const app = withPanelContext(createApp({
    environment: 'production', registry: serverRegistry, domainRegistry, jobRegistry,
  }));

  await withServer(app, async (baseUrl) => {
    const created = await requestJson(`${baseUrl}/api/domains`, {
      method: 'POST',
      body: {
        serverId: enrolled.server.id, primaryDomain: 'old.example.com', targetType: 'proxy', target: { upstreamPort: 3300 },
      },
    });
    const domain = created.payload.data;
    const firstChecksum = 'a'.repeat(64);
    await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
    const firstStage = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, { token: enrolled.agentToken });
    await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/${firstStage.payload.data.job.id}/result`, {
      method: 'POST', token: enrolled.agentToken,
      body: { status: 'succeeded', result: { checksum: firstChecksum, configName: 'yunpanel-old.example.com.conf', bytes: 512 } },
    });
    await requestJson(`${baseUrl}/api/domains/${domain.id}/activate`, { method: 'POST' });
    const firstActivation = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, { token: enrolled.agentToken });
    await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/${firstActivation.payload.data.job.id}/result`, {
      method: 'POST', token: enrolled.agentToken,
      body: { status: 'succeeded', result: { checksum: firstChecksum, configName: 'yunpanel-old.example.com.conf', active: true } },
    });

    const changes = {
      primaryDomain: 'new.example.com', aliases: ['www.new.example.com'], httpsMode: 'managed',
      httpsRedirect: false, canonicalRedirect: true,
    };
    const preview = await requestJson(`${baseUrl}/api/domains/${domain.id}/update-preview`, {
      method: 'POST', body: { changes },
    });
    assert.equal(preview.response.status, 200);
    const updated = await requestJson(`${baseUrl}/api/domains/${domain.id}`, {
      method: 'PATCH',
      body: { changes, previewDigest: preview.payload.data.previewDigest, confirmation: preview.payload.data.confirmation },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.data.domain.appliedPrimaryDomain, 'old.example.com');

    await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
    const nextStage = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, { token: enrolled.agentToken });
    assert.deepEqual(nextStage.payload.data.envelope.payload, {
      primaryDomain: 'new.example.com', aliases: ['www.new.example.com'], targetType: 'proxy',
      target: { upstreamHost: '127.0.0.1', upstreamPort: 3300, websocket: true },
      nginxSettings: {
        clientMaxBodySizeMb: null, proxyTimeoutSeconds: null, websocket: true, headers: [],
      },
      canonicalRedirect: true, httpsRedirect: false,
    });
    const nextChecksum = 'b'.repeat(64);
    await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/${nextStage.payload.data.job.id}/result`, {
      method: 'POST', token: enrolled.agentToken,
      body: { status: 'succeeded', result: { checksum: nextChecksum, configName: 'yunpanel-new.example.com.conf', bytes: 768 } },
    });
    await requestJson(`${baseUrl}/api/domains/${domain.id}/activate`, { method: 'POST' });
    const nextActivation = await requestJson(`${baseUrl}/api/servers/${enrolled.server.id}/commands/next`, { token: enrolled.agentToken });
    assert.deepEqual(nextActivation.payload.data.envelope.payload, {
      primaryDomain: 'new.example.com', previousPrimaryDomain: 'old.example.com', checksum: nextChecksum,
    });
  });
});
