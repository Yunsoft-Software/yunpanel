import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPowerDnsRoutes, PowerDnsHttpError } from '../src/powerdns-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const targetRecords = Object.freeze([
  Object.freeze({ key: 'apex-ipv4', owner: '@', type: 'A', ttl: null, values: Object.freeze(['<server-ipv4>']), condition: 'always' }),
]);

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
}

async function invoke(app, key, request) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `route ${key} should be mounted`);
  const response = {
    payload: null,
    json(payload) { this.payload = payload; return payload; },
  };
  await handlers.at(-1)(request, response, (error) => {
    if (error) throw error;
  });
  return response.payload;
}

function fixture() {
  const calls = [];
  const templateRegistry = {
    ensureForServer: async (id) => ({ serverId: id, version: 3, records: [] }),
    getVersion: async (id, version) => ({
      serverId: id,
      schemaVersion: 1,
      version,
      records: targetRecords,
      createdAt: '2026-09-14T00:00:00.000Z',
    }),
    preview: async (input) => ({
      serverId: input.serverId,
      currentVersion: input.expectedVersion,
      nextVersion: input.expectedVersion + 1,
      records: input.records,
      previewDigest: 'b'.repeat(64),
      confirmation: 'apply-dns-zone-template:base',
      existingZonesAutomaticApply: false,
    }),
    update: async (input) => {
      calls.push(input);
      return {
        serverId: input.serverId,
        schemaVersion: 1,
        version: input.expectedVersion + 1,
        records: input.records,
        createdAt: '2026-09-15T07:00:00.000Z',
        updatedAt: '2026-09-15T07:00:00.000Z',
      };
    },
  };
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
  return { app, calls };
}

test('PowerDNS HTTP previews and applies DNS template rollback as a new version', async () => {
  const { app, calls } = fixture();
  const previewResponse = await invoke(app, 'POST /api/servers/:serverId/dns/template/rollback/preview', {
    params: { serverId },
    body: { expectedVersion: 3, targetVersion: 1 },
  });
  const preview = previewResponse.data;
  assert.equal(preview.currentVersion, 3);
  assert.equal(preview.targetVersion, 1);
  assert.equal(preview.nextVersion, 4);
  assert.equal(preview.existingZonesAutomaticApply, false);

  const applyResponse = await invoke(app, 'POST /api/servers/:serverId/dns/template/rollback/apply', {
    params: { serverId },
    body: {
      expectedVersion: 3,
      targetVersion: 1,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    },
  });
  assert.equal(applyResponse.data.version, 4);
  assert.deepEqual(applyResponse.data.rollback, { fromVersion: 3, targetVersion: 1, createdVersion: 4 });
  assert.deepEqual(calls, [{
    serverId,
    expectedVersion: 3,
    records: targetRecords,
    previewDigest: 'b'.repeat(64),
    confirmation: 'apply-dns-zone-template:base',
  }]);
});

test('PowerDNS HTTP validates rollback bodies before touching template history', async () => {
  const { app, calls } = fixture();
  await assert.rejects(
    invoke(app, 'POST /api/servers/:serverId/dns/template/rollback/preview', {
      params: { serverId },
      body: { expectedVersion: 3, targetVersion: 1, records: [] },
    }),
    (error) => error instanceof PowerDnsHttpError
      && error.code === 'dns_template_rollback_preview_input_invalid',
  );
  await assert.rejects(
    invoke(app, 'POST /api/servers/:serverId/dns/template/rollback/apply', {
      params: { serverId },
      body: { expectedVersion: 3, targetVersion: 1, previewDigest: 'x', confirmation: 'wrong', extra: true },
    }),
    (error) => error instanceof PowerDnsHttpError
      && error.code === 'dns_template_rollback_apply_input_invalid',
  );
  assert.deepEqual(calls, []);
});
