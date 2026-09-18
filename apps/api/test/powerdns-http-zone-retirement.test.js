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

function mountWith(retirementService, retirementRuntime = {
  get: async () => null,
  listForDomain: async () => [],
}) {
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
    dnsZoneRetirementService: {
      captureDeletionSnapshot: async () => ({}),
      inspectDeletion: async () => ({}),
      deleteCapturedSnapshot: async () => ({}),
      ...retirementService,
    },
    dnsZoneRetirementRuntime: retirementRuntime,
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

test('PowerDNS HTTP exposes read-only durable retirement operation list/detail without private snapshot data', async () => {
  const operationId = 'f77d9d70-3f77-4be9-b257-0ade06401fb7';
  const calls = [];
  const operation = {
    id: operationId,
    domainId,
    serverId,
    zoneName: 'example.com',
    domainRevision: 4,
    previewDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    ownershipEvidenceDigest: 'c'.repeat(64),
    snapshotRetentionDays: 30,
    status: 'deleting',
    result: null,
    error: null,
    recovery: {
      required: true,
      automaticReplayBlocked: true,
      retryable: true,
      retryConfirmation: `retry-dns-zone-retirement:${domainId}:${operationId}:2026-09-18T16:00:00.000Z:${'b'.repeat(64)}`,
      reason: 'dns_zone_retirement_interrupted_delete',
    },
    createdAt: '2026-09-18T16:00:00.000Z',
    updatedAt: '2026-09-18T16:00:00.000Z',
  };
  const app = mountWith({ preview: async () => ({}) }, {
    listForDomain: async (id) => { calls.push(['list', id]); return [operation]; },
    get: async (id) => { calls.push(['get', id]); return operation; },
  });

  const list = await invoke(app, 'GET /api/domains/:domainId/dns/retirement-operations', {
    params: { domainId },
    query: {},
  });
  const detail = await invoke(app, 'GET /api/domains/:domainId/dns/retirement-operations/:operationId', {
    params: { domainId, operationId },
    query: {},
  });

  assert.deepEqual(list, { data: [operation] });
  assert.deepEqual(detail, { data: operation });
  assert.deepEqual(calls, [['list', domainId], ['get', operationId]]);
  assert.equal(JSON.stringify(operation).includes('snapshot":'), false);
  assert.equal(JSON.stringify(operation).includes('confirmation":'), false);
});

test('retirement operation detail is Domain-scoped and rejects query expansion', async () => {
  const operationId = 'f77d9d70-3f77-4be9-b257-0ade06401fb7';
  const otherDomainId = '997c6ac8-4db4-4500-a24e-0c8ff84825c6';
  const app = mountWith({ preview: async () => ({}) }, {
    listForDomain: async () => [],
    get: async () => ({ id: operationId, domainId, status: 'deleted' }),
  });

  await assert.rejects(
    invoke(app, 'GET /api/domains/:domainId/dns/retirement-operations/:operationId', {
      params: { domainId: otherDomainId, operationId },
      query: {},
    }),
    (error) => error instanceof PowerDnsHttpError
      && error.code === 'dns_zone_retirement_operation_not_found',
  );
  await assert.rejects(
    invoke(app, 'GET /api/domains/:domainId/dns/retirement-operations', {
      params: { domainId },
      query: { include: 'snapshot' },
    }),
    (error) => error instanceof PowerDnsHttpError
      && error.code === 'dns_zone_retirement_operation_query_invalid',
  );
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
      dnsZoneRetirementRuntime: {
        get: async () => null,
        listForDomain: async () => [],
      },
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
