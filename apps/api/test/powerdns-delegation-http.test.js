import assert from 'node:assert/strict';
import test from 'node:test';
import { DnsDelegationInspectorError } from '../src/dns-delegation-inspector.js';
import { mountPowerDnsRoutes, PowerDnsHttpError } from '../src/powerdns-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
}

function createResponse() {
  return {
    payload: null,
    json(payload) {
      this.payload = payload;
      return payload;
    },
  };
}

async function invoke(app, key, request) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `route ${key} should be mounted`);
  const response = createResponse();
  await handlers.at(-1)(request, response, (error) => {
    if (error) throw error;
  });
  return response.payload;
}

function mountWith(inspector) {
  const app = createFakeApp();
  mountPowerDnsRoutes(app, {
    dnsIdentityRegistry: {
      getForServer: async () => null,
      preview: async () => ({}),
      update: async () => ({}),
    },
    dnsZoneTemplateRegistry: {
      ensureForServer: async () => ({ serverId, version: 1 }),
      getVersion: async () => null,
      preview: async () => ({}),
      update: async () => ({}),
    },
    dnsDelegationInspector: inspector,
    authoritativeService: {
      localServerId: serverId,
      status: async () => ({}),
      preview: async () => ({}),
      apply: async () => ({}),
      resolve: async () => ({}),
      retry: async () => ({}),
    },
  });
  return app;
}

test('PowerDNS HTTP exposes read-only delegation inspection for the local server', async () => {
  const calls = [];
  const result = { serverId, domain: 'example.com', status: 'ready', ready: true };
  const app = mountWith({
    inspect: async (input) => {
      calls.push(input);
      return result;
    },
  });

  assert.deepEqual(
    await invoke(app, 'GET /api/servers/:serverId/dns/delegation', {
      params: { serverId },
      query: { domain: 'example.com' },
    }),
    { data: result },
  );
  assert.deepEqual(calls, [{ serverId, domain: 'example.com' }]);
});

test('PowerDNS HTTP maps delegation inspector errors into API errors', async () => {
  const app = mountWith({
    inspect: async () => {
      throw new DnsDelegationInspectorError(
        'dns_delegation_identity_required',
        'Configure DNS identity first',
        409,
      );
    },
  });

  await assert.rejects(
    invoke(app, 'GET /api/servers/:serverId/dns/delegation', {
      params: { serverId },
      query: { domain: 'example.com' },
    }),
    (error) => error instanceof PowerDnsHttpError
      && error.code === 'dns_delegation_identity_required'
      && error.status === 409,
  );
});

test('PowerDNS HTTP keeps delegation inspection scoped to the local server', async () => {
  let called = false;
  const app = mountWith({ inspect: async () => { called = true; return {}; } });

  await assert.rejects(
    invoke(app, 'GET /api/servers/:serverId/dns/delegation', {
      params: { serverId: '62f8e59b-0a51-4d90-9432-246ef1ec9d7e' },
      query: { domain: 'example.com' },
    }),
    (error) => error instanceof PowerDnsHttpError
      && error.code === 'powerdns_local_server_required'
      && error.status === 404,
  );
  assert.equal(called, false);
});
