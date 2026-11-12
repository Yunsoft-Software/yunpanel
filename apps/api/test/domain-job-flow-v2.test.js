import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { renderPhpSiteConfig } from '@yunpanel/config-templates';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDomainStageTargetJobRegistry } from '../src/domain-stage-target-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
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
      domainRevision: 2,
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

test('PHP Domain hosting update-preview, PATCH, stage and Nginx rendering preserve staticAssetCacheSeconds, headers and body limits', async () => {
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'php-hosting-cache-stage' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'php-hosting-cache-host' });
  const serverId = enrolled.server.id;
  const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
  const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
  const unixUser = 'yunapp-4dc352e64a14';
  const root = `/var/lib/yunpanel/apps/${applicationId}/current/public`;
  const socketPath = `/run/php/yunpanel-${unixUser}.sock`;

  const applicationRegistry = createApplicationRegistry({
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  const createdApp = await applicationRegistry.createPhpApplication({
    applicationId,
    serverId,
    name: 'php-cache-app',
  });
  assert.equal(createdApp.id, applicationId);
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getApplication: (id) => applicationRegistry.getApplication(id),
  });
  const createdWebsite = await websiteRegistry.createWebsite({
    websiteId,
    serverId,
    name: 'php-cache.example.com',
    applicationId,
  });
  assert.equal(createdWebsite.id, websiteId);

  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
    getWebsite: (id) => websiteRegistry.getWebsite(id),
  });
  const baseJobRegistry = createJobRegistry();
  const jobRegistry = createDomainStageTargetJobRegistry({
    registry: baseJobRegistry,
    domainRegistry,
    websiteRegistry,
    dockerComposeProjectRegistry: { async getProject() { return null; } },
    applicationRegistry,
    runtimeBindingRegistry: { async getBinding() { return null; } },
    phpFpmSiteManager: {
      async inspect() {
        return {
          satisfied: true,
          adapter: 'php-fpm',
          websiteId,
          applicationId,
          unixUser: createdWebsite.unixUser,
          documentRoot: createdWebsite.documentRoot,
          socketPath: `/run/php/yunpanel-${createdWebsite.unixUser}.sock`,
        };
      },
    },
    serviceUmaskManager: {
      async inspect() {
        return { satisfied: true, adapter: 'systemd-umask', runtime: 'php', umask: '0027' };
      },
    },
  });

  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    jobRegistry,
    websiteRegistry,
    applicationRegistry,
  }));

  await withServer(app, async (baseUrl) => {
    const created = await requestJson(`${baseUrl}/api/domains`, {
      method: 'POST',
      body: {
        serverId,
        websiteId,
        primaryDomain: 'php-cache.example.com',
        targetType: 'php',
        target: { applicationId },
      },
    });
    assert.equal(created.response.status, 201);
    const domain = created.payload.data;

    const initialStage = await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
    assert.equal(initialStage.response.status, 202);
    const initialClaim = await baseJobRegistry.claimNext(serverId);
    const initialRendered = renderPhpSiteConfig({
      ...initialClaim.envelope.payload,
      ...initialClaim.envelope.payload.target,
    });
    const initialChecksum = createHash('sha256').update(initialRendered).digest('hex');
    const initialDone = await baseJobRegistry.complete({
      serverId,
      jobId: initialClaim.job.id,
      status: 'succeeded',
      result: { checksum: initialChecksum, configName: 'yunpanel-php-cache.example.com.conf', bytes: Buffer.byteLength(initialRendered) },
    });
    await reconcileCompletedJob({ domainRegistry, job: initialDone });
    await requestJson(`${baseUrl}/api/domains/${domain.id}/activate`, { method: 'POST' });
    const initialActivate = await baseJobRegistry.claimNext(serverId);
    const initialActivated = await baseJobRegistry.complete({
      serverId,
      jobId: initialActivate.job.id,
      status: 'succeeded',
      result: { checksum: initialChecksum, configName: 'yunpanel-php-cache.example.com.conf', active: true },
    });
    await reconcileCompletedJob({ domainRegistry, job: initialActivated });

    const changes = {
      nginxSettings: {
        clientMaxBodySizeMb: 2,
        headers: [{ name: 'X-Php-Cache', value: 'hit-120', always: true }],
        staticAssetCacheSeconds: 120,
      },
    };
    const preview = await requestJson(`${baseUrl}/api/domains/${domain.id}/update-preview`, {
      method: 'POST',
      body: { changes },
    });
    assert.equal(preview.response.status, 200);

    const patched = await requestJson(`${baseUrl}/api/domains/${domain.id}`, {
      method: 'PATCH',
      body: {
        changes,
        previewDigest: preview.payload.data.previewDigest,
        confirmation: preview.payload.data.confirmation,
      },
    });
    assert.equal(patched.response.status, 200);

    const staged = await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
    assert.equal(staged.response.status, 202, JSON.stringify(staged.payload));

    const claimStage = await baseJobRegistry.claimNext(serverId);
    assert.ok(claimStage);
    assert.equal(claimStage.envelope.payload.targetType, 'php');
    assert.deepEqual(claimStage.envelope.payload.target, {
      root: createdWebsite.documentRoot,
      socketPath: `/run/php/yunpanel-${createdWebsite.unixUser}.sock`,
    });
    assert.deepEqual(claimStage.envelope.payload.nginxSettings, {
      clientMaxBodySizeMb: 2,
      staticAssetCacheSeconds: 120,
      headers: [{ name: 'X-Php-Cache', value: 'hit-120', always: true }],
    });

    const rendered = renderPhpSiteConfig({
      ...claimStage.envelope.payload,
      ...claimStage.envelope.payload.target,
    });
    assert.match(rendered, /client_max_body_size 2m;/);
    assert.match(rendered, /add_header X-Php-Cache "hit-120" always;/);
    assert.match(rendered, /expires 120s;/);
    assert.match(rendered, /max-age=120/);

    const nextChecksum = createHash('sha256').update(rendered).digest('hex');
    const doneStage = await baseJobRegistry.complete({
      serverId,
      jobId: claimStage.job.id,
      status: 'succeeded',
      result: { checksum: nextChecksum, configName: 'yunpanel-php-cache.example.com.conf', bytes: Buffer.byteLength(rendered) },
    });
    await reconcileCompletedJob({ domainRegistry, job: doneStage });
    assert.equal((await domainRegistry.getDomain(domain.id)).state, 'staged');

    // Revert staticAssetCacheSeconds back to null (server default) and verify stage succeeds too
    const revertChanges = {
      nginxSettings: {
        clientMaxBodySizeMb: null,
        headers: [],
        staticAssetCacheSeconds: null,
      },
    };
    const revertPreview = await requestJson(`${baseUrl}/api/domains/${domain.id}/update-preview`, {
      method: 'POST',
      body: { changes: revertChanges },
    });
    assert.equal(revertPreview.response.status, 200);
    const reverted = await requestJson(`${baseUrl}/api/domains/${domain.id}`, {
      method: 'PATCH',
      body: {
        changes: revertChanges,
        previewDigest: revertPreview.payload.data.previewDigest,
        confirmation: revertPreview.payload.data.confirmation,
      },
    });
    assert.equal(reverted.response.status, 200);
    const revertStage = await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
    assert.equal(revertStage.response.status, 202, JSON.stringify(revertStage.payload));
  });
});

