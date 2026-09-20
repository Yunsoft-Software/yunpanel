import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';
import { completeNextJob } from './helpers/job-completion-fixture.js';

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
    const checksum = 'c'.repeat(64);
    const configName = 'yunpanel-strict.example.com.conf';
    await completeNextJob(jobRegistry, {
      serverId: enrolled.server.id,
      domainRegistry,
      status: 'succeeded',
      result: { checksum, configName, bytes: 640 },
    });
    assert.equal((await domainRegistry.getDomain(domain.id)).state, 'staged');

    await requestJson(`${baseUrl}/api/domains/${domain.id}/activate`, { method: 'POST' });
    await completeNextJob(jobRegistry, {
      serverId: enrolled.server.id,
      domainRegistry,
      status: 'succeeded',
      result: { checksum, configName, active: true },
    });
    const activeDomain = await domainRegistry.getDomain(domain.id);
    assert.equal(activeDomain.state, 'active');
    assert.equal(activeDomain.appliedRevision, activeDomain.desiredRevision);
  });
});

test('completed domain jobs reconcile domain state to staged', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'reconciliation-barrier' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'reconciliation-host' });
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
        primaryDomain: 'barrier.example.com',
        targetType: 'static',
        target: { root: '/var/www/barrier' },
      },
    });
    const domain = created.payload.data;
    const staged = await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
    await completeNextJob(jobRegistry, {
      serverId: enrolled.server.id,
      domainRegistry,
      status: 'succeeded',
      result: {
        checksum: 'a'.repeat(64),
        configName: 'yunpanel-barrier.example.com.conf',
        bytes: 512,
      },
    });

    const observed = await requestJson(`${baseUrl}/api/jobs/${staged.payload.data.id}`);
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
    await completeNextJob(jobRegistry, {
      serverId: enrolled.server.id,
      domainRegistry,
      status: 'succeeded',
      result: { checksum: firstChecksum, configName: 'yunpanel-old.example.com.conf', bytes: 512 },
    });
    await requestJson(`${baseUrl}/api/domains/${domain.id}/activate`, { method: 'POST' });
    await completeNextJob(jobRegistry, {
      serverId: enrolled.server.id,
      domainRegistry,
      status: 'succeeded',
      result: { checksum: firstChecksum, configName: 'yunpanel-old.example.com.conf', active: true },
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
    const claimStage = await jobRegistry.claimNext(enrolled.server.id);
    assert.ok(claimStage);
    assert.deepEqual(claimStage.envelope.payload, {
      primaryDomain: 'new.example.com', aliases: ['www.new.example.com'], targetType: 'proxy',
      target: { upstreamHost: '127.0.0.1', upstreamPort: 3300, websocket: true },
      nginxSettings: {
        clientMaxBodySizeMb: null, proxyTimeoutSeconds: null, websocket: true, headers: [],
      },
      canonicalRedirect: true, httpsRedirect: false,
    });
    const nextChecksum = 'b'.repeat(64);
    const jobStage = await jobRegistry.complete({
      serverId: enrolled.server.id,
      jobId: claimStage.job.id,
      status: 'succeeded',
      result: { checksum: nextChecksum, configName: 'yunpanel-new.example.com.conf', bytes: 768 },
    });
    await reconcileCompletedJob({ domainRegistry, job: jobStage });

    await requestJson(`${baseUrl}/api/domains/${domain.id}/activate`, { method: 'POST' });
    const claimActivation = await jobRegistry.claimNext(enrolled.server.id);
    assert.ok(claimActivation);
    assert.deepEqual(claimActivation.envelope.payload, {
      primaryDomain: 'new.example.com', previousPrimaryDomain: 'old.example.com', checksum: nextChecksum,
    });
    const jobActivation = await jobRegistry.complete({
      serverId: enrolled.server.id,
      jobId: claimActivation.job.id,
      status: 'succeeded',
      result: { checksum: nextChecksum, configName: 'yunpanel-new.example.com.conf', active: true },
    });
    await reconcileCompletedJob({ domainRegistry, job: jobActivation });
  });
});

