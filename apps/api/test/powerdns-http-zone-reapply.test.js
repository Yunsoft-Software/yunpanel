import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPowerDnsRoutes, PowerDnsHttpError } from '../src/powerdns-http.js';

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

function mountWith(reapplyService) {
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
    dnsZoneReapplyService: reapplyService,
    authoritativeService: {
      localServerId: serverId,
      status: async () => ({}),
      preview: async () => ({}),
      apply: async () => ({}),
    },
  });
  return app;
}

test('PowerDNS HTTP exposes Domain zone reapply preview and apply without leaking provider credentials', async () => {
  const calls = [];
  const preview = {
    domainId,
    zoneName: 'example.com',
    applyAllowed: true,
    previewDigest: 'a'.repeat(64),
    confirmation: `reapply-dns-zone-template:${domainId}:${'a'.repeat(64)}`,
  };
  const applied = { domainId, zoneName: 'example.com', satisfied: true, serial: 2026091601 };
  const app = mountWith({
    preview: async (input) => { calls.push(['preview', input]); return preview; },
    apply: async (input) => { calls.push(['apply', input]); return applied; },
  });

  assert.deepEqual(
    await invoke(app, 'POST /api/domains/:domainId/dns/reapply-preview', {
      params: { domainId },
      body: {},
    }),
    { data: preview },
  );
  assert.deepEqual(
    await invoke(app, 'POST /api/domains/:domainId/dns/reapply', {
      params: { domainId },
      body: { previewDigest: preview.previewDigest, confirmation: preview.confirmation },
    }),
    { data: applied },
  );
  assert.deepEqual(calls, [
    ['preview', { domainId }],
    ['apply', { domainId, previewDigest: preview.previewDigest, confirmation: preview.confirmation }],
  ]);
  assert.equal(JSON.stringify(preview).includes('apiKey'), false);
});

test('PowerDNS HTTP rejects unexpected or incomplete zone reapply bodies before service mutation', async () => {
  let called = false;
  const app = mountWith({
    preview: async () => { called = true; return {}; },
    apply: async () => { called = true; return {}; },
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
