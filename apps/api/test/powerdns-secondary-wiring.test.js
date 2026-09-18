import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPowerDnsRoutes } from '../src/powerdns-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
}

function createTemplateRegistry() {
  return {
    ensureForServer: async () => ({ serverId, version: 1 }),
    getVersion: async () => null,
    preview: async () => ({}),
    update: async () => ({}),
  };
}

function createReapplyRuntime() {
  return {
    preview: async () => ({}),
    start: async () => ({}),
    rollbackPreview: async () => ({}),
    rollback: async () => ({}),
    get: async () => null,
    listForDomain: async () => [],
  };
}

test('PowerDNS route composition mounts secondary DNS status', () => {
  const app = createFakeApp();

  mountPowerDnsRoutes(app, {
    dnsIdentityRegistry: {
      getForServer: async () => null,
      preview: async () => ({}),
      update: async () => ({}),
    },
    dnsZoneTemplateRegistry: createTemplateRegistry(),
    dnsZoneReapplyRuntime: createReapplyRuntime(),
    authoritativeService: {
      localServerId: serverId,
      status: async () => ({}),
      preview: async () => ({}),
      apply: async () => ({}),
      resolve: async () => ({}),
      retry: async () => ({}),
      rollback: async () => ({}),
    },
  });

  assert.ok(
    app.routes.has('GET /api/domains/:domainId/dns/secondary'),
    'secondary DNS status route must remain part of PowerDNS production composition',
  );
});
