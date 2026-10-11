import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { DomainRegistryError } from '../src/domain-registry.js';
import { createDomainStageTargetJobRegistry } from '../src/domain-stage-target-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createNginxManager } from '@yunpanel/host-runtime';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'db20d91a-ec70-4d79-bc75-1f70de76d1ea';
const projectId = '70b6a777-5fdf-4e64-89e8-14bf2e34953e';
const applicationId = 'b11b9423-44bc-4ca5-ab4c-75170070ab9b';

function fixture({
  publishedPorts = null,
  websiteBinding = true,
  passengerBinding = false,
  applicationJobs = [],
  baseRegistry = null,
  domainOverrides = {},
  applicationOverrides = {},
  bindingOverrides = {},
  siteMutationLock = null,
} = {}) {
  const calls = [];
  const registry = baseRegistry ?? {
    marker: 'base-registry',
    async enqueue(input) { calls.push(input); return { id: 'job-1', ...input }; },
    async listJobs() { return applicationJobs; },
  };
  const domain = {
    id: 'domain-1',
    serverId,
    websiteId: websiteBinding ? websiteId : null,
    desiredRevision: 3,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 18080, websocket: true },
    nginxSettings: {
      clientMaxBodySizeMb: 64,
      proxyTimeoutSeconds: 90,
      websocket: true,
      headers: [{ name: 'X-App', value: 'yunpanel', always: true }],
    },
    ...domainOverrides,
  };
  const website = {
    id: websiteId,
    serverId,
    revision: 4,
    applicationId: passengerBinding ? applicationId : null,
    dockerWorkloadId: null,
    managedComposeBinding: websiteBinding && !passengerBinding ? {
      projectId,
      serviceName: 'web',
      targetPort: 3000,
      protocol: 'tcp',
    } : null,
    runtimeType: passengerBinding ? 'node' : 'docker',
    unixUser: passengerBinding ? 'yunapp-123456abcdef' : null,
    proxyTarget: null,
  };
  const project = {
    id: projectId,
    serverId,
    services: [{
      name: 'web',
      publishedPorts: publishedPorts ?? [
        { hostIp: '0.0.0.0', publishedPort: 49152, targetPort: 3000, protocol: 'tcp' },
      ],
    }],
  };
  const application = {
    id: applicationId,
    serverId,
    currentReleaseId: 'release-7',
    ...applicationOverrides,
  };
  const runtimeBinding = passengerBinding ? {
    applicationId,
    serverId,
    adapter: 'passenger',
    state: 'active',
    releaseId: 'release-7',
    websiteId,
    websiteRevision: website.revision,
    domains: [{ domainId: domain.id, desiredRevision: domain.desiredRevision, nginxChecksum: 'a'.repeat(64) }],
    passengerTarget: {
      appRoot: '/var/www/example/current',
      documentRoot: '/var/www/example/current/public',
      startupFile: 'server.js',
      nodeBinary: '/usr/bin/node',
      user: website.unixUser,
      group: website.unixUser,
      appEnv: 'production',
      environmentInclude: '/etc/yunpanel/passenger-env/' + applicationId + '.conf',
    },
    ...bindingOverrides,
  } : null;
  return {
    calls,
    registry,
    decorated: createDomainStageTargetJobRegistry({
      registry,
      domainRegistry: { async getDomain(id) { return id === domain.id ? domain : null; } },
      websiteRegistry: { async getWebsite(id) { return id === website.id ? website : null; } },
      dockerComposeProjectRegistry: { async getProject(id) { return id === project.id ? project : null; } },
      applicationRegistry: { async getApplication(id) { return id === application.id ? application : null; } },
      runtimeBindingRegistry: { async getBinding(id) { return id === application.id ? runtimeBinding : null; } },
      siteMutationLock,
    }),
  };
}

function stageInput() {
  return {
    serverId,
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'example.com',
      aliases: [],
      targetType: 'proxy',
      target: { upstreamHost: '127.0.0.1', upstreamPort: 18080, websocket: true },
      nginxSettings: {
        clientMaxBodySizeMb: 64,
        proxyTimeoutSeconds: 90,
        websocket: true,
        headers: [{ name: 'X-App', value: 'yunpanel', always: true }],
      },
      canonicalRedirect: false,
      httpsRedirect: false,
    },
    resourceType: 'domain',
    resourceId: 'domain-1',
  };
}

test('Managed Compose Domain stage replaces stale persisted target before enqueue', async () => {
  const fx = fixture();
  const input = stageInput();
  const original = structuredClone(input);
  const job = await fx.decorated.enqueue(input);

  assert.equal(fx.calls.length, 1);
  assert.deepEqual(fx.calls[0].payload.target, {
    upstreamHost: '127.0.0.1',
    upstreamPort: 49152,
    websocket: true,
  });
  assert.equal(fx.calls[0].payload.targetType, 'proxy');
  assert.deepEqual(fx.calls[0].payload.nginxSettings, input.payload.nginxSettings);
  assert.equal(job.payload.target.upstreamPort, 49152);
  assert.deepEqual(input, original);
});

test('unbound Domain stage preserves its explicit persisted target', async () => {
  const fx = fixture({ websiteBinding: false });
  const input = stageInput();
  await fx.decorated.enqueue(input);
  assert.deepEqual(fx.calls[0].payload.target, input.payload.target);
});

test('non-domain-stage jobs pass through unchanged', async () => {
  const fx = fixture();
  const input = {
    serverId,
    type: 'system.inspect',
    operation: OPERATIONS.SERVER_INSPECT,
    payload: { exact: true },
    resourceType: 'server',
    resourceId: serverId,
  };
  await fx.decorated.enqueue(input);
  assert.equal(fx.calls[0], input);
  assert.equal(await fx.decorated.listJobs().then((jobs) => jobs.length), 0);
  assert.equal(fx.decorated.marker, 'base-registry');
});

test('Managed Compose stage readiness failure prevents job enqueue', async () => {
  const fx = fixture({ publishedPorts: [] });
  await assert.rejects(
    fx.decorated.enqueue(stageInput()),
    (error) => error instanceof DomainRegistryError
      && error.code === 'managed_compose_binding_not_ready'
      && error.status === 409,
  );
  assert.equal(fx.calls.length, 0);
});

test('Passenger runtime binding replaces stale direct-systemd proxy target before enqueue', async () => {
  const fx = fixture({ passengerBinding: true });
  const input = stageInput();
  await fx.decorated.enqueue(input);
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0].payload.targetType, 'passenger');
  assert.deepEqual(fx.calls[0].payload.target, {
    appRoot: '/var/www/example/current',
    documentRoot: '/var/www/example/current/public',
    startupFile: 'server.js',
    nodeBinary: '/usr/bin/node',
    user: 'yunapp-123456abcdef',
    group: 'yunapp-123456abcdef',
    appEnv: 'production',
    environmentInclude: '/etc/yunpanel/passenger-env/' + applicationId + '.conf',
  });
  assert.deepEqual(fx.calls[0].payload.nginxSettings, {
    clientMaxBodySizeMb: 64,
    headers: [{ name: 'X-App', value: 'yunpanel', always: true }],
  });
  assert.deepEqual(input, stageInput());
});

test('complete Passenger target survives real job enqueue, protocol validation, claim and host rendering', async () => {
  const registry = createJobRegistry({ serverExists: async id => id === serverId });
  const fx = fixture({ passengerBinding: true, baseRegistry: registry });
  const job = await fx.decorated.enqueue(stageInput());
  const claimed = await registry.claimNext(serverId);
  assert.equal(claimed.job.id, job.id);
  assert.equal(claimed.envelope.payload.target.appRoot, '/var/www/example/current');
  const preview = createNginxManager().previewDomain(claimed.envelope.payload);
  assert.match(preview.config, /passenger_user yunapp-123456abcdef;/);
  assert.match(preview.config, /root \/var\/www\/example\/current\/public;/);
  assert.match(preview.config, new RegExp('include /etc/yunpanel/passenger-env/' + applicationId + '\\.conf;'));
});

test('Domain stage waits while Passenger migration owns the Application route', async () => {
  const fx = fixture({
    passengerBinding: true,
    applicationJobs: [{ operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE, status: 'running' }],
  });
  await assert.rejects(
    fx.decorated.enqueue(stageInput()),
    (error) => error instanceof DomainRegistryError
      && error.code === 'node_passenger_migration_routing_busy'
      && error.status === 409,
  );
  assert.equal(fx.calls.length, 0);
});

test('Domain stage resource mismatch fails closed before enqueue', async () => {
  const fx = fixture();
  await assert.rejects(
    fx.decorated.enqueue({ ...stageInput(), resourceType: 'application' }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_stage_resource_invalid',
  );
  assert.equal(fx.calls.length, 0);
});

const newDomainId = '49c9f7cd-38e3-4d8a-9467-dfafc7d63648';
const activeReleaseId = 'fe198e63-e52f-40a6-b1ef-a55c4855a1d7';
const attachmentFixture = overrides => fixture({ passengerBinding: true,
  domainOverrides: { id: newDomainId, state: 'draft', desiredRevision: 1, stagedRevision: 0, appliedRevision: 0, stagedChecksum: null, stagedConfigName: null },
  applicationOverrides: { type: 'node', runtimeAdapter: 'passenger', state: 'active', activeDeploymentId: null, currentReleaseId: activeReleaseId },
  bindingOverrides: { releaseId: activeReleaseId, revision: 8, domains: [] }, ...overrides });
const attachmentInput = () => ({ ...stageInput(), resourceId: newDomainId });

test('first Domain attachment queues the verified current target and server-owned revision pin through the real protocol', async t => {
  const root = path.join(os.tmpdir(), 'yp-domain-attach-' + randomUUID()); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createJobRegistry({ serverExists: async id => id === serverId });
  const fx = attachmentFixture({ baseRegistry: registry, siteMutationLock: createSiteMutationLock({ root }) });
  const input = attachmentInput(); input.payload.passengerAttachment = { applicationId: 'foreign' };
  const job = await fx.decorated.enqueue(input), claimed = await registry.claimNext(serverId);
  assert.equal(claimed.job.id, job.id);
  assert.deepEqual(claimed.envelope.payload.passengerAttachment, {
    serverId, domainId: newDomainId, applicationId, websiteId, releaseId: activeReleaseId,
    websiteRevision: 4, bindingRevision: 8, domainRevision: 1,
  });
  assert.match(createNginxManager().previewDomain(claimed.envelope.payload).config, /passenger_user yunapp-123456abcdef;/);
});

for (const [label, overrides] of [
  ['staged Domain', { domainOverrides: { id: newDomainId, state: 'staged', desiredRevision: 1, stagedRevision: 1, appliedRevision: 0 } }],
  ['previously applied Domain', { domainOverrides: { id: newDomainId, state: 'draft', desiredRevision: 2, stagedRevision: 0, appliedRevision: 1 } }],
  ['running Application', { applicationOverrides: { type: 'node', runtimeAdapter: 'passenger', state: 'deploying', activeDeploymentId: activeReleaseId, currentReleaseId: activeReleaseId } }],
  ['foreign binding', { bindingOverrides: { releaseId: activeReleaseId, revision: 8, domains: [], websiteId: projectId } }],
  ['foreign Unix identity', { bindingOverrides: { releaseId: activeReleaseId, revision: 8, domains: [], passengerTarget: { user: 'root', group: 'root' } } }],
]) {
  test(`new Domain attachment rejects ${label} before queueing`, async () => {
    const fx = attachmentFixture(overrides);
    await assert.rejects(fx.decorated.enqueue(attachmentInput()), { code: 'passenger_runtime_binding_drift' });
    assert.equal(fx.calls.length, 0);
  });
}

test('caller cannot inject an attachment pin into an existing Domain stage', async () => {
  const fx = fixture({ passengerBinding: true }), input = stageInput();
  input.payload.passengerAttachment = { applicationId: 'foreign' };
  await fx.decorated.enqueue(input);
  assert.equal(Object.hasOwn(fx.calls[0].payload, 'passengerAttachment'), false);
});

test('Passenger Domain count limit rejects the next attachment before it creates a durable job', async () => {
  const domains = Array.from({ length: 32 }, (_, i) => ({ domainId: 'existing-' + i, desiredRevision: 1, nginxChecksum: 'a'.repeat(64) }));
  const fx = attachmentFixture({ bindingOverrides: { releaseId: activeReleaseId, revision: 8, domains } });
  await assert.rejects(fx.decorated.enqueue(attachmentInput()), { code: 'passenger_domain_limit_reached' });
  assert.equal(fx.calls.length, 0);
});

test('first failed unapplied Domain preparation can retry only with no prior stage evidence', async t => {
  const root = path.join(os.tmpdir(), 'yp-domain-attach-' + randomUUID()); t.after(() => rm(root, { recursive: true, force: true }));
  const state = { id: newDomainId, state: 'error', desiredRevision: 1, stagedRevision: 0, appliedRevision: 0,
    stagedChecksum: null, stagedConfigName: null };
  const fx = attachmentFixture({ domainOverrides: state, siteMutationLock: createSiteMutationLock({ root }) });
  assert.ok((await fx.decorated.enqueue(attachmentInput())).payload.passengerAttachment);
  for (const changes of [{ stagedChecksum: 'a'.repeat(64) }, { stagedConfigName: 'previous.conf' }, { stagedRevision: 1 }, { appliedRevision: 1 }]) {
    const unsafe = attachmentFixture({ domainOverrides: { ...state, ...changes } });
    await assert.rejects(unsafe.decorated.enqueue(attachmentInput()), { code: 'passenger_runtime_binding_drift' });
    assert.equal(unsafe.calls.length, 0);
  }
});
