import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPowerDnsRoutes } from '../src/powerdns-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
}

function response() {
  return {
    payload: null,
    json(payload) { this.payload = payload; return payload; },
  };
}

async function invoke(app, key, request) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `route ${key} should be mounted`);
  const output = response();
  let forwarded = null;
  await handlers.at(-1)(request, output, (error) => { forwarded = error ?? null; });
  if (forwarded) throw forwarded;
  return output.payload;
}

function mountWith(service) {
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
    dnsDelegationInspector: { inspect: async () => ({ state: 'ready' }) },
    dnsZoneReapplyRuntime: {
      preview: async () => ({}),
      start: async () => ({}),
      get: async () => null,
      listForDomain: async () => [],
    },
    dnsZoneRecordsService: service,
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

test('PowerDNS HTTP exposes Domain zone read and manual record mutations through the path-scoped service', async () => {
  const calls = [];
  const zone = { domainId, zoneName: 'example.com', serial: 2026091601, rrsets: [] };
  const applied = { domainId, satisfied: true, changed: true, serial: 2026091602 };
  const removed = { domainId, satisfied: true, changed: true, serial: 2026091603 };
  const service = {
    getZone: async (input) => { calls.push(['getZone', input]); return zone; },
    apply: async (input) => { calls.push(['apply', input]); return applied; },
    remove: async (input) => { calls.push(['remove', input]); return removed; },
  };
  const app = mountWith(service);
  const applyBody = {
    owner: 'custom',
    type: 'A',
    ttl: 300,
    values: ['198.51.100.44'],
    expectedSerial: 2026091601,
  };
  const deleteBody = { owner: 'custom', type: 'A', expectedSerial: 2026091602 };

  assert.deepEqual(
    await invoke(app, 'GET /api/domains/:domainId/dns/zone', { params: { domainId } }),
    { data: zone },
  );
  assert.deepEqual(
    await invoke(app, 'POST /api/domains/:domainId/dns/records', { params: { domainId }, body: applyBody }),
    { data: applied },
  );
  assert.deepEqual(
    await invoke(app, 'POST /api/domains/:domainId/dns/records/delete', { params: { domainId }, body: deleteBody }),
    { data: removed },
  );
  assert.deepEqual(calls, [
    ['getZone', { domainId }],
    ['apply', { domainId, input: applyBody }],
    ['remove', { domainId, input: deleteBody }],
  ]);
});
