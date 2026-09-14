import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainRegistryError } from '../src/domain-registry.js';
import { resolveWebsiteDomainTarget } from '../src/website-domain-target.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'db20d91a-ec70-4d79-bc75-1f70de76d1ea';
const projectId = '70b6a777-5fdf-4e64-89e8-14bf2e34953e';
const applicationId = 'b11b9423-44bc-4ca5-ab4c-75170070ab9b';

function domain(overrides = {}) {
  return {
    id: 'domain-1',
    serverId,
    websiteId,
    desiredRevision: 3,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 18080, websocket: false },
    nginxSettings: { websocket: false },
    ...overrides,
  };
}

function website(overrides = {}) {
  return {
    id: websiteId,
    serverId,
    revision: 4,
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: {
      projectId,
      serviceName: 'web',
      targetPort: 3000,
      protocol: 'tcp',
    },
    runtimeType: 'docker',
    proxyTarget: null,
    ...overrides,
  };
}

function nodeWebsite(overrides = {}) {
  return website({
    applicationId,
    managedComposeBinding: null,
    runtimeType: 'node',
    ...overrides,
  });
}

function project(publishedPort = 49152, overrides = {}) {
  return {
    id: projectId,
    serverId,
    services: [{
      name: 'web',
      publishedPorts: [{ hostIp: '0.0.0.0', publishedPort, targetPort: 3000, protocol: 'tcp' }],
    }],
    ...overrides,
  };
}

function dependencies({ websiteValue = website(), projectValue = project() } = {}) {
  return {
    websiteRegistry: { async getWebsite(id) { return id === websiteId ? websiteValue : null; } },
    dockerComposeProjectRegistry: { async getProject(id) { return id === projectId ? projectValue : null; } },
  };
}

function passengerDependencies({ bindingOverrides = {}, websiteOverrides = {} } = {}) {
  const websiteValue = nodeWebsite(websiteOverrides);
  return {
    websiteRegistry: { async getWebsite(id) { return id === websiteId ? websiteValue : null; } },
    applicationRegistry: {
      async getApplication(id) {
        return id === applicationId ? { id: applicationId, serverId, currentReleaseId: 'release-7' } : null;
      },
    },
    runtimeBindingRegistry: {
      async getBinding(id) {
        if (id !== applicationId) return null;
        return {
          applicationId,
          serverId,
          adapter: 'passenger',
          state: 'active',
          releaseId: 'release-7',
          websiteId,
          websiteRevision: websiteValue.revision,
          domains: [{ domainId: 'domain-1', desiredRevision: 3, nginxChecksum: 'a'.repeat(64) }],
          passengerTarget: { appRoot: '/var/www/example/current', startupFile: 'server.js' },
          ...bindingOverrides,
        };
      },
    },
  };
}

test('unbound Domain keeps its persisted target', async () => {
  const current = domain({ websiteId: null });
  const result = await resolveWebsiteDomainTarget({ domain: current });
  assert.deepEqual(result, {
    source: 'domain',
    targetType: 'proxy',
    target: current.target,
  });
});

test('non-Compose Website keeps its persisted Domain target', async () => {
  const current = domain();
  const result = await resolveWebsiteDomainTarget({
    domain: current,
    websiteRegistry: dependencies().websiteRegistry,
    dockerComposeProjectRegistry: dependencies().dockerComposeProjectRegistry,
  });
  assert.equal(result.source, 'managed_compose');

  const plainWebsite = website({ managedComposeBinding: null, runtimeType: 'proxy', proxyTarget: { host: '127.0.0.1', port: 8443, websocket: true } });
  const plain = await resolveWebsiteDomainTarget({
    domain: current,
    websiteRegistry: dependencies({ websiteValue: plainWebsite }).websiteRegistry,
  });
  assert.deepEqual(plain, {
    source: 'domain',
    targetType: current.targetType,
    target: current.target,
  });
});

test('Node Website without a runtime binding keeps legacy direct-systemd Domain compatibility', async () => {
  const current = domain();
  const websiteValue = nodeWebsite();
  const result = await resolveWebsiteDomainTarget({
    domain: current,
    websiteRegistry: { async getWebsite() { return websiteValue; } },
    runtimeBindingRegistry: { async getBinding() { return null; } },
  });
  assert.deepEqual(result, {
    source: 'domain',
    targetType: current.targetType,
    target: current.target,
  });
});

test('Passenger runtime binding blocks legacy Domain restage after cutover', async () => {
  await assert.rejects(
    resolveWebsiteDomainTarget({
      domain: domain(),
      ...passengerDependencies(),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'passenger_runtime_binding_restage_blocked'
      && error.status === 409,
  );
});

test('cleanup-required Passenger binding remains authoritative for Domain restage', async () => {
  await assert.rejects(
    resolveWebsiteDomainTarget({
      domain: domain(),
      ...passengerDependencies({ bindingOverrides: { state: 'cleanup_required' } }),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'passenger_runtime_binding_restage_blocked'
      && error.status === 409,
  );
});

test('Passenger runtime binding revision drift fails closed before legacy target can be reused', async () => {
  await assert.rejects(
    resolveWebsiteDomainTarget({
      domain: domain({ desiredRevision: 4 }),
      ...passengerDependencies(),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'passenger_runtime_binding_drift'
      && error.status === 409,
  );
});

test('Managed Compose Domain target resolves the current published port without mutating persisted target', async () => {
  const current = domain();
  const deps = dependencies({ projectValue: project(49152) });
  const first = await resolveWebsiteDomainTarget({ domain: current, ...deps });
  assert.deepEqual(first, {
    source: 'managed_compose',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 49152, websocket: false },
  });
  assert.equal(current.target.upstreamPort, 18080);

  const moved = await resolveWebsiteDomainTarget({
    domain: current,
    ...dependencies({ projectValue: project(49153) }),
  });
  assert.equal(moved.target.upstreamPort, 49153);
  assert.equal(current.target.upstreamPort, 18080);
});

test('Managed Compose Domain target honors current Domain websocket policy', async () => {
  const resolved = await resolveWebsiteDomainTarget({
    domain: domain({ nginxSettings: { websocket: true } }),
    ...dependencies(),
  });
  assert.equal(resolved.target.websocket, true);
});

test('Managed Compose Domain target fails closed when Website and Domain servers drift', async () => {
  await assert.rejects(
    resolveWebsiteDomainTarget({
      domain: domain(),
      ...dependencies({ websiteValue: website({ serverId: 'c8e93a53-6b7b-41bb-a55f-eddb6fe6aa23' }) }),
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'website_server_mismatch' && error.status === 409,
  );
});

test('Managed Compose Website requires a proxy Domain target', async () => {
  await assert.rejects(
    resolveWebsiteDomainTarget({
      domain: domain({ targetType: 'static', target: { root: '/var/www/site', spaFallback: true }, nginxSettings: { spaFallback: true } }),
      ...dependencies(),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'managed_compose_domain_target_type_mismatch'
      && error.status === 409,
  );
});

test('Managed Compose stage target carries binding readiness failure without exposing fallback target', async () => {
  await assert.rejects(
    resolveWebsiteDomainTarget({
      domain: domain(),
      ...dependencies({ projectValue: project(49152, { services: [{ name: 'web', publishedPorts: [] }] }) }),
    }),
    (error) => error instanceof DomainRegistryError
      && error.code === 'managed_compose_binding_not_ready'
      && error.status === 409,
  );
});
