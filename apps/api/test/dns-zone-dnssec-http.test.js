import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DnsZoneDnssecHttpError,
  dnsZoneDnssecHttpInternals,
  mountDnsZoneDnssecRoutes,
} from '../src/dns-zone-dnssec-http.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const operationId = 'f59889d5-a6b2-4aca-976b-8ff745f92f13';

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return value; },
  };
}

async function invoke(app, key, request) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `route ${key} should be mounted`);
  const output = response();
  let forwarded = null;
  await handlers.at(-1)(request, output, (error) => { forwarded = error ?? null; });
  if (forwarded) throw forwarded;
  return output;
}

test('Domain DNSSEC HTTP forwards status, preview and durable apply without provider secrets', async () => {
  const calls = [];
  const preview = {
    domainId,
    targetEnabled: true,
    applyAllowed: true,
    previewDigest: 'a'.repeat(64),
    confirmation: `enable-dnssec:${domainId}:${'a'.repeat(64)}`,
    registrar: { addDs: ['12345 13 2 AABBCCDD'] },
  };
  const operation = {
    id: operationId,
    domainId,
    serverId,
    zoneName: 'example.com',
    targetEnabled: true,
    previewDigest: preview.previewDigest,
    status: 'succeeded',
    result: {
      zoneName: 'example.com',
      dnssec: true,
      status: 'pending_parent_ds',
      secureReady: false,
      serial: 2026091601,
      ds: preview.registrar.addDs,
      parentStatus: 'absent',
      parentRecords: [],
      parentMatchingRecords: [],
    },
    error: null,
  };
  const rolloverPreview = {
    action: 'dnssec_key_rollover',
    domainId,
    applyAllowed: true,
    previewDigest: 'c'.repeat(64),
    confirmation: `rollover-dnssec:${domainId}:${'c'.repeat(64)}`,
  };
  const rolloverOperation = {
    id: operationId,
    domainId,
    serverId,
    zoneName: 'example.com',
    previewDigest: rolloverPreview.previewDigest,
    status: 'verifying_dnskey_propagation',
    evidence: { newKeyId: 8, keySetDigest: 'd'.repeat(64), targetKeySetDigest: null },
    result: null,
    error: null,
  };
  const runtime = {
    status: async (input) => { calls.push(['status', input]); return { domainId, status: 'insecure' }; },
    preview: async (input) => { calls.push(['preview', input]); return preview; },
    previewRollover: async (input) => { calls.push(['rollover-preview', input]); return rolloverPreview; },
    startRollover: async (input) => { calls.push(['rollover-start', input]); return rolloverOperation; },
    listRolloversForDomain: async (input) => { calls.push(['rollover-list', input]); return [rolloverOperation]; },
    getRollover: async (input) => { calls.push(['rollover-get', input]); return rolloverOperation; },
    start: async (input) => { calls.push(['start', input]); return operation; },
    listForDomain: async (input) => { calls.push(['list', input]); return [operation]; },
    get: async (input) => { calls.push(['get', input]); return operation; },
  };
  const app = fakeApp();
  mountDnsZoneDnssecRoutes(app, {
    authoritativeService: { localServerId: serverId },
    dnsZoneDnssecRuntime: runtime,
  });

  const status = await invoke(app, 'GET /api/domains/:domainId/dns/dnssec', { params: { domainId } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.data.status, 'insecure');

  const previewResponse = await invoke(app, 'POST /api/domains/:domainId/dns/dnssec/preview', {
    params: { domainId },
    body: { enabled: true },
  });
  assert.deepEqual(previewResponse.payload, { data: preview });

  const rollover = await invoke(app, 'GET /api/domains/:domainId/dns/dnssec/rollover/preview', {
    params: { domainId },
  });
  assert.deepEqual(rollover.payload, { data: rolloverPreview });

  const rolloverApplied = await invoke(app, 'POST /api/domains/:domainId/dns/dnssec/rollover/apply', {
    params: { domainId },
    body: { previewDigest: rolloverPreview.previewDigest, confirmation: rolloverPreview.confirmation },
  });
  assert.equal(rolloverApplied.statusCode, 202);
  assert.equal(rolloverApplied.payload.data.status, 'verifying_dnskey_propagation');
  assert.equal(JSON.stringify(rolloverApplied.payload).includes('confirmation'), false);

  const rolloverListed = await invoke(app, 'GET /api/domains/:domainId/dns/dnssec/rollover/operations', {
    params: { domainId },
  });
  assert.equal(rolloverListed.payload.data[0].id, operationId);
  const rolloverSingle = await invoke(app, 'GET /api/domains/:domainId/dns/dnssec/rollover/operations/:operationId', {
    params: { domainId, operationId },
  });
  assert.equal(rolloverSingle.payload.data.id, operationId);

  const applied = await invoke(app, 'POST /api/domains/:domainId/dns/dnssec/apply', {
    params: { domainId },
    body: {
      enabled: true,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    },
  });
  assert.equal(applied.payload.data.status, 'succeeded');
  assert.equal(applied.payload.data.result.status, 'pending_parent_ds');
  assert.equal(JSON.stringify(applied.payload).includes('apiKey'), false);
  assert.equal(JSON.stringify(applied.payload).includes('confirmation'), false);

  const listed = await invoke(app, 'GET /api/domains/:domainId/dns/dnssec/operations', { params: { domainId } });
  assert.equal(listed.payload.data[0].id, operationId);
  const single = await invoke(app, 'GET /api/domains/:domainId/dns/dnssec/operations/:operationId', {
    params: { domainId, operationId },
  });
  assert.equal(single.payload.data.id, operationId);

  assert.deepEqual(calls, [
    ['status', { domainId }],
    ['preview', { domainId, enabled: true }],
    ['rollover-preview', { domainId }],
    ['rollover-start', {
      domainId,
      previewDigest: rolloverPreview.previewDigest,
      confirmation: rolloverPreview.confirmation,
    }],
    ['rollover-list', domainId],
    ['rollover-get', operationId],
    ['start', {
      domainId,
      enabled: true,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }],
    ['list', domainId],
    ['get', operationId],
  ]);
});

test('Domain DNSSEC HTTP hides an operation that belongs to another Domain path', async () => {
  const app = fakeApp();
  mountDnsZoneDnssecRoutes(app, {
    authoritativeService: { localServerId: serverId },
    dnsZoneDnssecRuntime: {
      status: async () => ({}),
      preview: async () => ({}),
      previewRollover: async () => ({}),
      startRollover: async () => ({}),
      listRolloversForDomain: async () => [],
      getRollover: async () => ({}),
      start: async () => ({}),
      listForDomain: async () => [],
      get: async () => ({ id: operationId, domainId: '997c6ac8-4db4-4500-a24e-0c8ff84825c6' }),
    },
  });

  const result = await invoke(app, 'GET /api/domains/:domainId/dns/dnssec/operations/:operationId', {
    params: { domainId, operationId },
  });
  assert.equal(result.statusCode, 404);
  assert.equal(result.payload.error.code, 'dnssec_operation_not_found');
});

test('Domain DNSSEC HTTP hides a rollover operation that belongs to another Domain path', async () => {
  const app = fakeApp();
  mountDnsZoneDnssecRoutes(app, {
    authoritativeService: { localServerId: serverId },
    dnsZoneDnssecRuntime: {
      status: async () => ({}),
      preview: async () => ({}),
      previewRollover: async () => ({}),
      startRollover: async () => ({}),
      listRolloversForDomain: async () => [],
      getRollover: async () => ({ id: operationId, domainId: '997c6ac8-4db4-4500-a24e-0c8ff84825c6' }),
      start: async () => ({}),
      listForDomain: async () => [],
      get: async () => ({}),
    },
  });

  const result = await invoke(app, 'GET /api/domains/:domainId/dns/dnssec/rollover/operations/:operationId', {
    params: { domainId, operationId },
  });
  assert.equal(result.statusCode, 404);
  assert.equal(result.payload.error.code, 'dnssec_rollover_operation_not_found');
});

test('Domain DNSSEC HTTP rejects malformed mutation bodies before runtime calls', async () => {
  let calls = 0;
  const app = fakeApp();
  mountDnsZoneDnssecRoutes(app, {
    authoritativeService: { localServerId: serverId },
    dnsZoneDnssecRuntime: {
      status: async () => ({}),
      preview: async () => { calls += 1; return {}; },
      previewRollover: async () => ({}),
      startRollover: async () => { calls += 1; return {}; },
      listRolloversForDomain: async () => [],
      getRollover: async () => null,
      start: async () => { calls += 1; return {}; },
      get: async () => null,
      listForDomain: async () => [],
    },
  });

  const badPreview = await invoke(app, 'POST /api/domains/:domainId/dns/dnssec/preview', {
    params: { domainId },
    body: { enabled: true, force: true },
  });
  assert.equal(badPreview.statusCode, 400);
  assert.equal(badPreview.payload.error.code, 'dnssec_preview_input_invalid');

  const badApply = await invoke(app, 'POST /api/domains/:domainId/dns/dnssec/apply', {
    params: { domainId },
    body: { enabled: false, previewDigest: 'not-a-digest', confirmation: 'anything' },
  });
  assert.equal(badApply.statusCode, 400);
  assert.equal(badApply.payload.error.code, 'dnssec_apply_input_invalid');
  const badRollover = await invoke(app, 'POST /api/domains/:domainId/dns/dnssec/rollover/apply', {
    params: { domainId },
    body: { previewDigest: 'not-a-digest', confirmation: 'anything' },
  });
  assert.equal(badRollover.statusCode, 400);
  assert.equal(badRollover.payload.error.code, 'dnssec_rollover_apply_input_invalid');
  assert.equal(calls, 0);
});

test('DNSSEC HTTP mount requires a local authoritative service', () => {
  assert.throws(
    () => {
      const app = fakeApp();
      mountDnsZoneDnssecRoutes(app, {
        authoritativeService: { localServerId: '' },
        dnsZoneDnssecRuntime: {
          status() {}, preview() {}, previewRollover() {}, start() {}, get() {}, listForDomain() {},
          startRollover() {}, getRollover() {}, listRolloversForDomain() {},
        },
      });
    },
    /PowerDNS authoritative service is required/,
  );
  const error = new DnsZoneDnssecHttpError('example', 'example', 409);
  assert.equal(error.status, 409);
});

test('DNSSEC rollover operations use a separate state-root store with an explicit override', () => {
  assert.equal(
    dnsZoneDnssecHttpInternals.rolloverOperationStorePath({
      YUNPANEL_SERVER_STORE: '/var/lib/yunpanel/server-registry.json',
    }),
    '/var/lib/yunpanel/dnssec-rollover-operations.json',
  );
  assert.equal(
    dnsZoneDnssecHttpInternals.rolloverOperationStorePath({
      YUNPANEL_SERVER_STORE: '/var/lib/yunpanel/server-registry.json',
      YUNPANEL_DNSSEC_ROLLOVER_OPERATION_STORE: '/etc/yunpanel/private/rollovers.json',
    }),
    '/etc/yunpanel/private/rollovers.json',
  );
});
