import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ManagedComposeWebsiteBindingError,
  normalizeManagedComposeWebsiteBinding,
  resolveManagedComposeWebsiteBinding,
} from '../src/managed-compose-website-binding.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const otherServerId = 'c8e93a53-6b7b-41bb-a55f-eddb6fe6aa23';
const projectId = '70b6a777-5fdf-4e64-89e8-14bf2e34953e';

function binding(overrides = {}) {
  return {
    projectId,
    serviceName: 'web',
    targetPort: 3000,
    protocol: 'tcp',
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    id: projectId,
    serverId,
    services: [{
      name: 'web',
      imageConfigured: true,
      buildConfigured: false,
      publishedPorts: [{ hostIp: '0.0.0.0', publishedPort: 49152, targetPort: 3000, protocol: 'tcp' }],
    }],
    ...overrides,
  };
}

test('normalizes managed Compose Website identity without persisting runtime host port', () => {
  assert.deepEqual(normalizeManagedComposeWebsiteBinding({
    projectId,
    serviceName: 'web',
    targetPort: 3000,
  }), binding());
});

test('resolves a managed Compose Website identity through current published port state', () => {
  const resolved = resolveManagedComposeWebsiteBinding({
    binding: binding(),
    serverId,
    project: project(),
  });

  assert.deepEqual(resolved.binding, binding());
  assert.deepEqual(resolved.proxyTarget, { host: '127.0.0.1', port: 49152, websocket: true });
});

test('normalizes wildcard IPv6 published bindings to local loopback', () => {
  const resolved = resolveManagedComposeWebsiteBinding({
    binding: binding(),
    serverId,
    project: project({
      services: [{
        name: 'web',
        imageConfigured: true,
        buildConfigured: false,
        publishedPorts: [{ hostIp: '::', publishedPort: 49153, targetPort: 3000, protocol: 'tcp' }],
      }],
    }),
  });

  assert.equal(resolved.proxyTarget.host, '::1');
  assert.equal(resolved.proxyTarget.port, 49153);
});

test('accepts an explicit IPv4 loopback published binding', () => {
  const resolved = resolveManagedComposeWebsiteBinding({
    binding: binding(),
    serverId,
    project: project({
      services: [{
        name: 'web',
        imageConfigured: true,
        buildConfigured: false,
        publishedPorts: [{ hostIp: '127.0.0.2', publishedPort: 49154, targetPort: 3000, protocol: 'tcp' }],
      }],
    }),
  });

  assert.equal(resolved.proxyTarget.host, '127.0.0.2');
});

test('rejects a published binding on a non-loopback interface', () => {
  assert.throws(
    () => resolveManagedComposeWebsiteBinding({
      binding: binding(),
      serverId,
      project: project({
        services: [{
          name: 'web',
          imageConfigured: true,
          buildConfigured: false,
          publishedPorts: [{ hostIp: '192.0.2.10', publishedPort: 49152, targetPort: 3000, protocol: 'tcp' }],
        }],
      }),
    }),
    (error) => error instanceof ManagedComposeWebsiteBindingError
      && error.code === 'managed_compose_published_binding_not_loopback'
      && error.status === 409,
  );
});

test('fails closed when project belongs to another server', () => {
  assert.throws(
    () => resolveManagedComposeWebsiteBinding({ binding: binding(), serverId, project: project({ serverId: otherServerId }) }),
    (error) => error instanceof ManagedComposeWebsiteBindingError
      && error.code === 'website_managed_compose_server_mismatch'
      && error.status === 409,
  );
});

test('fails closed when selected Compose service no longer exists', () => {
  assert.throws(
    () => resolveManagedComposeWebsiteBinding({ binding: binding(), serverId, project: project({ services: [] }) }),
    (error) => error instanceof ManagedComposeWebsiteBindingError
      && error.code === 'managed_compose_service_not_found'
      && error.status === 409,
  );
});

test('reports not-ready when selected target port is not currently published', () => {
  assert.throws(
    () => resolveManagedComposeWebsiteBinding({
      binding: binding(),
      serverId,
      project: project({ services: [{ name: 'web', imageConfigured: true, buildConfigured: false, publishedPorts: [] }] }),
    }),
    (error) => error instanceof ManagedComposeWebsiteBindingError
      && error.code === 'managed_compose_binding_not_ready'
      && error.status === 409,
  );
});

test('fails closed when current published binding is ambiguous', () => {
  assert.throws(
    () => resolveManagedComposeWebsiteBinding({
      binding: binding(),
      serverId,
      project: project({
        services: [{
          name: 'web',
          imageConfigured: true,
          buildConfigured: false,
          publishedPorts: [
            { hostIp: '0.0.0.0', publishedPort: 49152, targetPort: 3000, protocol: 'tcp' },
            { hostIp: '::', publishedPort: 49152, targetPort: 3000, protocol: 'tcp' },
          ],
        }],
      }),
    }),
    (error) => error instanceof ManagedComposeWebsiteBindingError
      && error.code === 'managed_compose_binding_ambiguous'
      && error.status === 409,
  );
});

test('rejects non-TCP Website bindings', () => {
  assert.throws(
    () => normalizeManagedComposeWebsiteBinding(binding({ protocol: 'udp' })),
    (error) => error instanceof ManagedComposeWebsiteBindingError
      && error.code === 'managed_compose_protocol_unsupported',
  );
});
