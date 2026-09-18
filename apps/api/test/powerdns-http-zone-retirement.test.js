import assert from 'node:assert/strict';
import test from 'node:test';
import { DnsZoneRetirementError } from '../src/dns-zone-retirement.js';
import { mountPowerDnsRoutes, PowerDnsHttpError } from '../src/powerdns-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
  };
}

function baseReapplyRuntime() {
  return {
    preview: async () => ({}),
    start: async () => ({}),
    rollbackPreview: async () => ({}),
    rollback: async () => ({}),
    get: async () => null,
    listForDomain: async () => [],
  };
}

function mountWith(retirementService) {
  const app = fakeApp();
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
    dnsZoneReapplyRuntime: baseReapplyRuntime(),
    dnsZoneRetirementService: retirementService,
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
  return app;
}

async function invoke(app, {
  params = { domainId },
  query = {},
} = {}) {
  const handler = app.routes.get('GET /api/domains/:domainId/dns/retirement-impact');
  assert.ok(handler);
  let payload = null;
  let forwarded = null;
  const headers = {};
  await handler(
    { params, query },
    {
      set(name, value) { headers[name.toLowerCase()] = value; return this; },
      json(value) { payload = value; return this; },
    },
    (error) => { forwarded = error ?? null; },
  );
  return { payload, forwarded, headers };
}

test('PowerDNS HTTP exposes read-only Domain DNS retirement impact with no-store semantics', async () => {
  const calls = [];
  const preview = {
    version: 1,
    operation: 'dns_zone_retirement_impact',
    domain: { id: domainId, serverId, primaryDomain: 'example.com' },
    hierarchy: { descendantCount: 0, descendants: [] },
    routing: { active: true, stagedRevision: 4, appliedRevision: 4, appliedPrimaryDomain: 'example.com' },
    zone: {
      exists: true,
      snapshotDigest: 'a'.repeat(64),
      kind: 'Primary',
      dnssec: false,
      rrsetCount: 4,
      managedRrsetCount: 4,
      manualRrsetCount: 0,
      ownership: 'managed_rrsets_unproven',
    },
    blockers: ['dns_zone_delete_ownership_evidence_required'],
    retirementPlanReady: false,
    previewDigest: 'b'.repeat(64),
    confirmation: null,
    sideEffects: false,
  };
  const app = mountWith({
    preview: async (input) => { calls.push(input); return preview; },
  });

  const response = await invoke(app);

  assert.equal(response.forwarded, null);
  assert.deepEqual(response.payload, { data: preview });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(calls, [{ domainId }]);
  assert.equal(response.payload.data.confirmation, null);
  assert.equal(response.payload.data.sideEffects, false);
});

test('retirement impact rejects query expansion before service inspection', async () => {
  let calls = 0;
  const app = mountWith({ preview: async () => { calls += 1; return {}; } });
  const response = await invoke(app, { query: { include: 'rrsets' } });

  assert.ok(response.forwarded instanceof PowerDnsHttpError);
  assert.equal(response.forwarded.code, 'dns_zone_retirement_query_invalid');
  assert.equal(calls, 0);
});

test('retirement service failures are mapped to PowerDNS HTTP errors', async () => {
  const app = mountWith({
    preview: async () => {
      throw new DnsZoneRetirementError(
        'dns_zone_retirement_inspection_failed',
        'Authoritative PowerDNS zone could not be inspected',
        503,
      );
    },
  });
  const response = await invoke(app);

  assert.ok(response.forwarded instanceof PowerDnsHttpError);
  assert.equal(response.forwarded.code, 'dns_zone_retirement_inspection_failed');
  assert.equal(response.forwarded.status, 503);
});

test('PowerDNS route mounting rejects malformed injected retirement services', () => {
  const app = fakeApp();
  assert.throws(
    () => mountPowerDnsRoutes(app, {
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
      dnsZoneReapplyRuntime: baseReapplyRuntime(),
      dnsZoneRetirementService: {},
      authoritativeService: {
        localServerId: serverId,
        status: async () => ({}),
        preview: async () => ({}),
        apply: async () => ({}),
        resolve: async () => ({}),
        retry: async () => ({}),
        rollback: async () => ({}),
      },
    }),
    /DNS zone retirement service is invalid/,
  );
});
