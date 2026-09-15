import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPowerDnsRoutes, PowerDnsHttpError } from '../src/powerdns-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const operationId = 'f77d9d70-3f77-4be9-b257-0ade06401fb7';

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
  let forwarded = null;
  await handlers.at(-1)(request, response, (error) => { forwarded = error ?? null; });
  if (forwarded) throw forwarded;
  return response.payload;
}

function mountWith(reapplyRuntime) {
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
    dnsZoneReapplyRuntime: reapplyRuntime,
    authoritativeService: {
      localServerId: serverId,
      status: async () => ({}),
      preview: async () => ({}),
      apply: async () => ({}),
    },
  });
  return app;
}

test('PowerDNS HTTP exposes durable Domain zone reapply preview/apply/status without leaking provider credentials', async () => {
  const calls = [];
  const preview = {
    domainId,
    zoneName: 'example.com',
    applyAllowed: true,
    previewDigest: 'a'.repeat(64),
    confirmation: `reapply-dns-zone-template:${domainId}:${'a'.repeat(64)}`,
  };
  const operation = {
    id: operationId,
    domainId,
    serverId,
    zoneName: 'example.com',
    status: 'succeeded',
    result: { satisfied: true, zoneName: 'example.com', serial: 2026091601, changedRrsetCount: 3, manualRrsetCount: 1 },
  };
  const app = mountWith({
    preview: async (input) => { calls.push(['preview', input]); return preview; },
    start: async (input) => { calls.push(['start', input]); return operation; },
    get: async (id) => { calls.push(['get', id]); return operation; },
    listForDomain: async (id) => { calls.push(['list', id]); return [operation]; },
  });

  assert.deepEqual(
    await invoke(app, 'POST /api/domains/:domainId/dns/reapply-preview', { params: { domainId }, body: {} }),
    { data: preview },
  );
  assert.deepEqual(
    await invoke(app, 'POST /api/domains/:domainId/dns/reapply', {
      params: { domainId },
      body: { previewDigest: preview.previewDigest, confirmation: preview.confirmation },
    }),
    { data: operation },
  );
  assert.deepEqual(
    await invoke(app, 'GET /api/domains/:domainId/dns/reapply-operations', { params: { domainId } }),
    { data: [operation] },
  );
  assert.deepEqual(
    await invoke(app, 'GET /api/domains/:domainId/dns/reapply-operations/:operationId', {
      params: { domainId, operationId },
    }),
    { data: operation },
  );
  assert.deepEqual(calls, [
    ['preview', { domainId }],
    ['start', { domainId, previewDigest: preview.previewDigest, confirmation: preview.confirmation }],
    ['list', domainId],
    ['get', operationId],
  ]);
  assert.equal(JSON.stringify(operation).includes('apiKey'), false);
  assert.equal(JSON.stringify(operation).includes(preview.confirmation), false);
});

test('PowerDNS HTTP rejects unexpected or incomplete zone reapply bodies before runtime mutation', async () => {
  let called = false;
  const app = mountWith({
    preview: async () => { called = true; return {}; },
    start: async () => { called = true; return {}; },
    get: async () => null,
    listForDomain: async () => [],
  });

  await assert.rejects(
    invoke(app, 'POST /api/domains/:domainId/dns/reapply-preview', {
      params: { domainId },
      body: { force: true },
    }),
    (error) => error instanceof PowerDnsHttpError && error.code === 'dns_zone_reapply_preview_input_invalid',
  );
  await assert.rejects(
    invoke(app, 'POST /api/domains/:domainId/dns/reapply', {
      params: { domainId },
      body: { previewDigest: 'a'.repeat(64), confirmation: '' },
    }),
    (error) => error instanceof PowerDnsHttpError && error.code === 'dns_zone_reapply_input_invalid',
  );
  assert.equal(called, false);
});

test('PowerDNS HTTP does not expose a reapply operation through the wrong Domain path', async () => {
  const otherDomainId = '997c6ac8-4db4-4500-a24e-0c8ff84825c6';
  const app = mountWith({
    preview: async () => ({}),
    start: async () => ({}),
    get: async () => ({ id: operationId, domainId, status: 'succeeded' }),
    listForDomain: async () => [],
  });

  await assert.rejects(
    invoke(app, 'GET /api/domains/:domainId/dns/reapply-operations/:operationId', {
      params: { domainId: otherDomainId, operationId },
    }),
    (error) => error instanceof PowerDnsHttpError && error.code === 'dns_zone_reapply_operation_not_found',
  );
});
