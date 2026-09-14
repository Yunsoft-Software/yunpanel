import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { DomainRegistryError } from '../src/domain-registry.js';
import { createDomainStageTargetJobRegistry } from '../src/domain-stage-target-job-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'db20d91a-ec70-4d79-bc75-1f70de76d1ea';
const projectId = '70b6a777-5fdf-4e64-89e8-14bf2e34953e';
const applicationId = 'b11b9423-44bc-4ca5-ab4c-75170070ab9b';

function fixture({ publishedPorts = null, websiteBinding = true, passengerBinding = false } = {}) {
  const calls = [];
  const registry = {
    marker: 'base-registry',
    async enqueue(input) { calls.push(input); return { id: 'job-1', ...input }; },
    async listJobs() { return []; },
  };
  const domain = {
    id: 'domain-1',
    serverId,
    websiteId: websiteBinding ? websiteId : null,
    desiredRevision: 3,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 18080, websocket: true },
    nginxSettings: { websocket: true },
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
      startupFile: 'server.js',
      nodeBinary: '/usr/bin/node',
    },
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
      nginxSettings: { websocket: true },
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
    root: '/var/www/example/current',
    startupFile: 'server.js',
    nodeBinary: '/usr/bin/node',
  });
});

test('Domain stage resource mismatch fails closed before enqueue', async () => {
  const fx = fixture();
  await assert.rejects(
    fx.decorated.enqueue({ ...stageInput(), resourceType: 'application' }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_stage_resource_invalid',
  );
  assert.equal(fx.calls.length, 0);
});
