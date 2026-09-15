import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  mountPowerDnsRoutes,
  PowerDnsHttpError,
  powerDnsHttpInternals,
} from '../src/powerdns-http.js';

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

function mountWith(templateRegistry) {
  const app = createFakeApp();
  mountPowerDnsRoutes(app, {
    dnsIdentityRegistry: {
      getForServer: async () => null,
      preview: async () => ({}),
      update: async () => ({}),
    },
    dnsZoneTemplateRegistry: templateRegistry,
    authoritativeService: {
      localServerId: serverId,
      status: async () => ({}),
      preview: async () => ({}),
      apply: async () => ({}),
    },
  });
  return app;
}

test('PowerDNS HTTP derives the zone-template store beside the server registry', () => {
  assert.equal(
    powerDnsHttpInternals.zoneTemplateStorePath({ YUNPANEL_SERVER_STORE: '/state/control/server-registry.json' }),
    path.join('/state/control', 'dns-zone-template-registry.json'),
  );
  assert.equal(
    powerDnsHttpInternals.zoneTemplateStorePath({
      YUNPANEL_SERVER_STORE: '/state/control/server-registry.json',
      YUNPANEL_DNS_ZONE_TEMPLATE_STORE: '/custom/templates.json',
    }),
    '/custom/templates.json',
  );
});

test('PowerDNS HTTP exposes current and historical DNS zone templates', async () => {
  const calls = [];
  const current = { serverId, version: 2 };
  const historical = { serverId, version: 1 };
  const app = mountWith({
    ensureForServer: async (id) => { calls.push(['ensure', id]); return current; },
    getVersion: async (id, version) => { calls.push(['version', id, version]); return historical; },
    preview: async () => ({}),
    update: async () => ({}),
  });

  assert.deepEqual(
    await invoke(app, 'GET /api/servers/:serverId/dns/template', { params: { serverId } }),
    { data: current },
  );
  assert.deepEqual(
    await invoke(app, 'GET /api/servers/:serverId/dns/template/versions/:version', { params: { serverId, version: '1' } }),
    { data: historical },
  );
  assert.deepEqual(calls, [['ensure', serverId], ['version', serverId, 1]]);
});

test('PowerDNS HTTP forwards preview and apply inputs exactly to the DNS template registry', async () => {
  const calls = [];
  const records = [{ key: 'apex-spf', owner: '@', type: 'TXT', ttl: 300, values: ['v=spf1 -all'], condition: 'always' }];
  const previewResult = { currentVersion: 1, nextVersion: 2, previewDigest: 'a'.repeat(64) };
  const applyResult = { serverId, version: 2 };
  const app = mountWith({
    ensureForServer: async () => ({ serverId, version: 1 }),
    getVersion: async () => null,
    preview: async (input) => { calls.push(['preview', input]); return previewResult; },
    update: async (input) => { calls.push(['apply', input]); return applyResult; },
  });

  assert.deepEqual(
    await invoke(app, 'POST /api/servers/:serverId/dns/template/preview', {
      params: { serverId },
      body: { expectedVersion: 1, records },
    }),
    { data: previewResult },
  );
  assert.deepEqual(
    await invoke(app, 'POST /api/servers/:serverId/dns/template/apply', {
      params: { serverId },
      body: {
        expectedVersion: 1,
        records,
        previewDigest: 'a'.repeat(64),
        confirmation: 'apply-dns-zone-template:test',
      },
    }),
    { data: applyResult },
  );
  assert.deepEqual(calls, [
    ['preview', { serverId, expectedVersion: 1, records }],
    ['apply', {
      serverId,
      expectedVersion: 1,
      records,
      previewDigest: 'a'.repeat(64),
      confirmation: 'apply-dns-zone-template:test',
    }],
  ]);
});

test('PowerDNS HTTP fails closed for invalid template versions and unknown history', async () => {
  const app = mountWith({
    ensureForServer: async () => ({ serverId, version: 1 }),
    getVersion: async () => null,
    preview: async () => ({}),
    update: async () => ({}),
  });

  await assert.rejects(
    invoke(app, 'GET /api/servers/:serverId/dns/template/versions/:version', { params: { serverId, version: '01' } }),
    (error) => error instanceof PowerDnsHttpError && error.code === 'invalid_dns_template_version',
  );
  await assert.rejects(
    invoke(app, 'GET /api/servers/:serverId/dns/template/versions/:version', { params: { serverId, version: '99' } }),
    (error) => error instanceof PowerDnsHttpError && error.code === 'dns_template_version_not_found' && error.status === 404,
  );
});

test('PowerDNS HTTP rejects unexpected DNS template body fields before registry mutation', async () => {
  let called = false;
  const app = mountWith({
    ensureForServer: async () => ({ serverId, version: 1 }),
    getVersion: async () => null,
    preview: async () => { called = true; return {}; },
    update: async () => { called = true; return {}; },
  });

  await assert.rejects(
    invoke(app, 'POST /api/servers/:serverId/dns/template/preview', {
      params: { serverId },
      body: { expectedVersion: 1, records: [], extra: true },
    }),
    (error) => error instanceof PowerDnsHttpError && error.code === 'dns_template_preview_input_invalid',
  );
  assert.equal(called, false);
});
