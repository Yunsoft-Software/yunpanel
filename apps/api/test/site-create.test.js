import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createSite, previewSiteCreate, SiteCreateError, siteCreateInternals } from '../src/site-create.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const STATIC_OPERATION = 'ab9b4c03-e744-40d4-ad1d-e9bab966a3e7';
const NODE_OPERATION = '47bc6cf1-75bc-4cba-a610-aa0cd0522c80';
const PROXY_OPERATION = '86e826ad-2dc6-45e4-ac3f-0c03bcff18fc';
const DOCKER_OPERATION = 'a17be329-acdf-48fd-ac1f-b3e35ec75565';

async function fixture() {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'site-create' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'site-create-host' });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  });
  const dockerWorkloadRegistry = createDockerWorkloadRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
    getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
    getDockerWorkload: async (workloadId) => dockerWorkloadRegistry.getWorkload(workloadId),
  });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
    getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
    websiteBindingRequired: () => true,
  });
  await Promise.all([applicationRegistry.init(), dockerWorkloadRegistry.init(), websiteRegistry.init(), domainRegistry.init()]);
  return {
    registry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    serverId: enrolled.server.id,
  };
}

function dependencies(state, overrides = {}) {
  return {
    registry: state.registry,
    applicationRegistry: state.applicationRegistry,
    dockerWorkloadRegistry: state.dockerWorkloadRegistry,
    websiteRegistry: state.websiteRegistry,
    domainRegistry: state.domainRegistry,
    ...overrides,
  };
}

function inputFor(serverId, overrides = {}) {
  return {
    operationId: STATIC_OPERATION,
    serverId,
    name: 'Marketing Site',
    primaryDomain: 'Example.COM.',
    parentDomainId: null,
    wwwMode: 'alias',
    httpsMode: 'managed',
    source: {
      kind: 'new_static',
      repositoryUrl: 'https://github.com/example/marketing',
      branch: 'main',
      build: { mode: 'none', outputDir: '.' },
      retention: 5,
    },
    ...overrides,
  };
}

async function apply(input, state, preview = null, overrides = {}) {
  const current = preview ?? await previewSiteCreate({ input, ...dependencies(state, overrides) });
  return createSite({
    input,
    previewDigest: current.previewDigest,
    confirmation: current.confirmation,
    ...dependencies(state, overrides),
  });
}

test('new static site creates deterministic Application, Website and explicit www alias idempotently', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId);
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(preview.complete, false);
  assert.equal(preview.resumeRequired, false);
  assert.equal(preview.assignedPort, null);
  assert.deepEqual(preview.hostname.aliases, ['www.example.com']);
  assert.deepEqual(preview.lifecycle, { dnsPublished: false, certificateIssued: false, mailDomainCreated: false });
  assert.equal(preview.plan.application.webRoot, `/var/www/yunpanel/apps/${preview.ids.applicationId}/current`);

  const created = await apply(input, state, preview);
  assert.equal(created.created, true);
  assert.equal(created.resumed, false);
  assert.equal(created.application.id, preview.ids.applicationId);
  assert.equal(created.website.id, preview.ids.websiteId);
  assert.equal(created.website.applicationId, created.application.id);
  assert.equal(created.primaryDomain.websiteId, created.website.id);
  assert.deepEqual(created.primaryDomain.aliases, ['www.example.com']);
  assert.equal(created.primaryDomain.certificateId, null);
  assert.equal(created.wwwDomain, null);

  const completedPreview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(completedPreview.previewDigest, preview.previewDigest);
  assert.equal(completedPreview.complete, true);
  const retried = await apply(input, state, preview);
  assert.equal(retried.created, false);
  assert.equal((await state.applicationRegistry.listApplications()).length, 1);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 1);
  assert.equal((await state.domainRegistry.listDomains()).length, 1);
});

test('new Node site assigns a collision-free managed port and models www as an independent child', async () => {
  const state = await fixture();
  await state.applicationRegistry.createNodeApplication({
    serverId: state.serverId,
    name: 'Existing Node',
    repositoryUrl: 'https://github.com/example/existing-node',
    runtime: { port: 3100 },
  });
  const proxyWebsite = await state.websiteRegistry.createWebsite({
    serverId: state.serverId,
    name: 'Reserved Proxy',
    runtimeType: 'proxy',
    proxyTarget: { host: '127.0.0.1', port: 3101 },
  });
  await state.domainRegistry.createDomain({
    serverId: state.serverId,
    websiteId: proxyWebsite.id,
    primaryDomain: 'reserved.example.test',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3101 },
  });
  const input = inputFor(state.serverId, {
    operationId: NODE_OPERATION,
    name: 'Node API',
    primaryDomain: 'api.example.test',
    wwwMode: 'independent',
    httpsMode: 'off',
    source: { kind: 'new_node', repositoryUrl: 'https://github.com/example/node-api', runtime: {} },
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(preview.assignedPort, 3102);
  assert.equal(preview.plan.application.runtime.port, 3102);

  const created = await apply(input, state, preview);
  assert.equal(created.application.runtime.port, 3102);
  assert.deepEqual(created.application.proxyTarget, { host: '127.0.0.1', port: 3102 });
  assert.deepEqual(created.primaryDomain.target, { upstreamHost: '127.0.0.1', upstreamPort: 3102, websocket: true });
  assert.equal(created.wwwDomain.primaryDomain, 'www.api.example.test');
  assert.equal(created.wwwDomain.parentDomainId, created.primaryDomain.id);
  assert.equal(created.wwwDomain.websiteId, created.website.id);
});

test('existing Application binding stays explicit and cannot be shared by multiple Websites', async () => {
  const state = await fixture();
  const application = await state.applicationRegistry.createApplication({
    serverId: state.serverId,
    name: 'Existing Static',
    repositoryUrl: 'https://github.com/example/existing-static',
  });
  const input = inputFor(state.serverId, {
    operationId: 'cb934804-a7c7-4ffd-bcc4-93289219823b',
    source: { kind: 'existing_application', applicationId: application.id },
  });
  const created = await apply(input, state);
  assert.equal(created.application.id, application.id);
  assert.equal((await state.applicationRegistry.listApplications()).length, 1);

  const secondInput = inputFor(state.serverId, {
    operationId: '37861cf3-8462-4d4d-aab0-303fb53022a1',
    primaryDomain: 'other.example.com',
    source: { kind: 'existing_application', applicationId: application.id },
  });
  await assert.rejects(
    previewSiteCreate({ input: secondInput, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'application_already_bound' && error.status === 409,
  );
});

test('external proxy site canonicalizes its origin without creating an Application', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId, {
    operationId: PROXY_OPERATION,
    name: 'External Origin',
    primaryDomain: 'edge.example.test',
    wwwMode: 'none',
    source: { kind: 'external_proxy', target: { host: 'ORIGIN.Example.NET.', port: 8443, websocket: false } },
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(preview.ids.applicationId, null);
  assert.deepEqual(preview.source.target, { host: 'origin.example.net', port: 8443, websocket: false });
  const created = await apply(input, state, preview);
  assert.equal(created.application, null);
  assert.equal(created.website.runtimeType, 'proxy');
  assert.deepEqual(created.website.proxyTarget, { host: 'origin.example.net', port: 8443, websocket: false });
  assert.deepEqual(created.primaryDomain.target, { upstreamHost: 'origin.example.net', upstreamPort: 8443, websocket: false });
});

test('existing Docker workload becomes an explicit Website runtime without claiming container lifecycle', async () => {
  const state = await fixture();
  const workload = await state.dockerWorkloadRegistry.createWorkload({
    serverId: state.serverId,
    name: 'Compose API',
    managementMode: 'external',
    proxyTarget: { host: '127.0.0.1', port: 8080, websocket: true },
  });
  const input = inputFor(state.serverId, {
    operationId: DOCKER_OPERATION,
    name: 'Docker API',
    primaryDomain: 'docker.example.test',
    wwwMode: 'none',
    source: { kind: 'existing_docker', dockerWorkloadId: workload.id },
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(preview.plan.application, null);
  assert.equal(preview.plan.dockerWorkload.id, workload.id);
  assert.equal(preview.plan.website.runtimeType, 'docker');
  assert.equal(preview.plan.website.dockerWorkloadId, workload.id);
  assert.deepEqual(preview.plan.primaryDomain.target, {
    upstreamHost: '127.0.0.1', upstreamPort: 8080, websocket: true,
  });
  assert.equal(preview.steps.dockerWorkloadReady, true);

  const created = await apply(input, state, preview);
  assert.equal(created.application, null);
  assert.equal(created.dockerWorkload.id, workload.id);
  assert.equal(created.website.dockerWorkloadId, workload.id);
  assert.equal(created.website.runtimeType, 'docker');
  assert.deepEqual(created.primaryDomain.target, preview.plan.primaryDomain.target);

  await assert.rejects(
    previewSiteCreate({
      input: inputFor(state.serverId, {
        operationId: '4ea277a7-76ea-4a66-a001-f1df6005327a',
        primaryDomain: 'other-docker.example.test',
        source: { kind: 'existing_docker', dockerWorkloadId: workload.id },
      }),
      ...dependencies(state),
    }),
    (error) => error instanceof SiteCreateError && error.code === 'docker_workload_already_bound',
  );
});

test('site creation resumes after an interruption without duplicating earlier resources', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId, {
    operationId: 'fa97e720-cd0c-490a-ae56-cfb05c6e3686',
    primaryDomain: 'resume.example.test',
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  let interrupted = true;
  const flakyDomainRegistry = {
    listDomains: (...args) => state.domainRegistry.listDomains(...args),
    getDomain: (...args) => state.domainRegistry.getDomain(...args),
    createDomain: (...args) => {
      if (interrupted) {
        interrupted = false;
        throw new Error('simulated interruption');
      }
      return state.domainRegistry.createDomain(...args);
    },
  };
  await assert.rejects(apply(input, state, preview, { domainRegistry: flakyDomainRegistry }), /simulated interruption/);
  assert.equal((await state.applicationRegistry.listApplications()).length, 1);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 1);
  assert.equal((await state.domainRegistry.listDomains()).length, 0);

  const resume = await previewSiteCreate({ input, ...dependencies(state) });
  assert.equal(resume.previewDigest, preview.previewDigest);
  assert.equal(resume.resumeRequired, true);
  assert.deepEqual(resume.steps, {
    applicationReady: true,
    websiteReady: true,
    primaryDomainReady: false,
    wwwDomainReady: null,
  });
  const created = await apply(input, state, preview);
  assert.equal(created.resumed, true);
  assert.equal((await state.applicationRegistry.listApplications()).length, 1);
  assert.equal((await state.websiteRegistry.listWebsites()).length, 1);
  assert.equal((await state.domainRegistry.listDomains()).length, 1);
});

test('same-server state drift invalidates preview before operation-owned resources are created', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId, {
    operationId: '36bd97f1-0189-4bac-bc1b-5abff87256d5',
    primaryDomain: 'stale.example.test',
  });
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  await state.websiteRegistry.createWebsite({ serverId: state.serverId, name: 'Concurrent', runtimeType: 'proxy' });
  await assert.rejects(
    apply(input, state, preview),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_preview_stale' && error.status === 409,
  );
  assert.equal(await state.applicationRegistry.getApplication(preview.ids.applicationId), null);
  assert.equal(await state.websiteRegistry.getWebsite(preview.ids.websiteId), null);
  assert.equal(await state.domainRegistry.getDomain(preview.ids.primaryDomainId), null);
});

test('site creation requires exact confirmation and rejects reused identities or unsupported input', async () => {
  const state = await fixture();
  const input = inputFor(state.serverId);
  const preview = await previewSiteCreate({ input, ...dependencies(state) });
  await assert.rejects(
    createSite({ input, previewDigest: preview.previewDigest, confirmation: 'wrong', ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_confirmation_required',
  );
  await apply(input, state, preview);
  await assert.rejects(
    previewSiteCreate({ input: { ...input, name: 'Reused operation' }, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_application_identity_conflict' && error.status === 409,
  );
  await assert.rejects(
    previewSiteCreate({ input: { ...input, operationId: NODE_OPERATION, source: { kind: 'docker' } }, ...dependencies(state) }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_target_not_supported' && error.status === 409,
  );
  await assert.rejects(
    previewSiteCreate({
      input: { ...input, operationId: NODE_OPERATION, source: { kind: 'new_node', repositoryUrl: 'https://github.com/example/node', runtime: { port: 3200 } } },
      ...dependencies(state),
    }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_node_runtime_invalid',
  );
});

test('selected Node Application proxy drift fails closed before a Website is planned', () => {
  assert.throws(
    () => siteCreateInternals.domainTarget({
      id: 'bf6a7374-b440-4380-8ad0-905f63d9ca9e',
      type: 'node',
      runtime: { port: 3100 },
      proxyTarget: { host: 'origin.example.test', port: 3100 },
    }, { kind: 'existing_application' }),
    (error) => error instanceof SiteCreateError && error.code === 'site_create_application_proxy_drift' && error.status === 409,
  );
});
