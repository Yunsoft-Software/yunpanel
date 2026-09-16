import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DnsZoneDnssecHttpError,
  mountDnsZoneDnssecRoutes,
} from '../src/dns-zone-dnssec-http.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

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

test('Domain DNSSEC HTTP forwards status, preview and apply without provider secrets', async () => {
  const calls = [];
  const preview = {
    domainId,
    targetEnabled: true,
    applyAllowed: true,
    previewDigest: 'a'.repeat(64),
    confirmation: `enable-dnssec:${domainId}:${'a'.repeat(64)}`,
    registrar: { addDs: ['12345 13 2 AABBCCDD'] },
  };
  const service = {
    status: async (input) => { calls.push(['status', input]); return { domainId, status: 'insecure' }; },
    preview: async (input) => { calls.push(['preview', input]); return preview; },
    apply: async (input) => { calls.push(['apply', input]); return { domainId, status: 'pending_parent_ds', ds: preview.registrar.addDs }; },
  };
  const app = fakeApp();
  mountDnsZoneDnssecRoutes(app, {
    authoritativeService: { localServerId: serverId },
    dnsZoneDnssecService: service,
  });

  const status = await invoke(app, 'GET /api/domains/:domainId/dns/dnssec', { params: { domainId } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.data.status, 'insecure');

  const previewResponse = await invoke(app, 'POST /api/domains/:domainId/dns/dnssec/preview', {
    params: { domainId },
    body: { enabled: true },
  });
  assert.deepEqual(previewResponse.payload, { data: preview });

  const applied = await invoke(app, 'POST /api/domains/:domainId/dns/dnssec/apply', {
    params: { domainId },
    body: {
      enabled: true,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    },
  });
  assert.equal(applied.payload.data.status, 'pending_parent_ds');
  assert.equal(JSON.stringify(applied.payload).includes('apiKey'), false);
  assert.deepEqual(calls, [
    ['status', { domainId }],
    ['preview', { domainId, enabled: true }],
    ['apply', {
      domainId,
      enabled: true,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }],
  ]);
});

test('Domain DNSSEC HTTP rejects malformed mutation bodies before service calls', async () => {
  let calls = 0;
  const app = fakeApp();
  mountDnsZoneDnssecRoutes(app, {
    authoritativeService: { localServerId: serverId },
    dnsZoneDnssecService: {
      status: async () => ({}),
      preview: async () => { calls += 1; return {}; },
      apply: async () => { calls += 1; return {}; },
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
  assert.equal(calls, 0);
});

test('DNSSEC HTTP body parser requires an exact confirmation contract', () => {
  assert.throws(
    () => {
      const app = fakeApp();
      mountDnsZoneDnssecRoutes(app, {
        authoritativeService: { localServerId: '' },
        dnsZoneDnssecService: { status() {}, preview() {}, apply() {} },
      });
    },
    /PowerDNS authoritative service is required/,
  );
  const error = new DnsZoneDnssecHttpError('example', 'example', 409);
  assert.equal(error.status, 409);
});
