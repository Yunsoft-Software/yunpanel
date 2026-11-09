import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDnsZoneOwnershipRegistry } from '../src/dns-zone-ownership-registry.js';
import { createDnsZoneRetirementService } from '../src/dns-zone-retirement.js';
import { mountPowerDnsRoutes } from '../src/powerdns-http.js';

const serverId = '42345678-1234-4234-8234-123456789012';
const domainId = '12345678-1234-4234-8234-123456789012';
const scope = { serverId, webDomainId: domainId, zoneName: 'example.com' };
const silent = { error() {} };

async function tempFile(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yp-dns-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'dns-zone-ownership.json');
}

test('a receipt survives a restart in a private file and can be removed', async (t) => {
  const filePath = await tempFile(t);
  const first = createDnsZoneOwnershipRegistry({ filePath, logger: silent });
  await first.init();
  const receipt = await first.recordCreated(scope);
  assert.match(receipt.operationId, /^[0-9a-f-]{36}$/);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const reopened = createDnsZoneOwnershipRegistry({ filePath, logger: silent });
  await reopened.init();
  assert.deepEqual(await reopened.getForZone(scope), receipt);
  assert.equal(await reopened.getForZone({ ...scope, webDomainId: 'other' }), null);

  await reopened.removeForZone(scope);
  assert.equal(await reopened.getForZone(scope), null);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).receipts, []);
});

test('creating the same zone again replaces its receipt', async () => {
  const registry = createDnsZoneOwnershipRegistry({ logger: silent });
  await registry.init();
  const first = await registry.recordCreated(scope);
  const second = await registry.recordCreated(scope);
  assert.notEqual(first.operationId, second.operationId);
  assert.deepEqual(await registry.getForZone(scope), second);
});

test('an unreadable or partly invalid file is logged and never stops the API', async (t) => {
  const filePath = await tempFile(t);
  await writeFile(filePath, '{ not json');
  const logged = [];
  const broken = createDnsZoneOwnershipRegistry({ filePath, logger: { error: (...args) => logged.push(args) } });
  await broken.init();
  assert.equal(await broken.getForZone(scope), null);
  assert.equal(logged.length, 1);

  await writeFile(filePath, JSON.stringify({ version: 1, receipts: [{ zoneName: 'bad' }, null] }));
  const partial = createDnsZoneOwnershipRegistry({ filePath, logger: silent });
  await partial.init();
  assert.equal(await partial.getForZone(scope), null);
});

function retirement({ receipt, operations = [] }) {
  const deleted = [];
  const removed = [];
  const domain = {
    id: domainId, serverId, websiteId: null, primaryDomain: 'example.com', parentDomainId: null, aliases: [],
    certificateId: null, desiredRevision: 1, stagedRevision: 0, appliedRevision: 0, appliedPrimaryDomain: null, state: 'draft',
  };
  const service = createDnsZoneRetirementService({
    localServerId: serverId,
    domainRegistry: { getDomain: async () => domain, listDomains: async () => [domain] },
    powerDnsSecretRegistry: { materializeForServer: async () => ({ apiKey: 'a'.repeat(43) }) },
    provisioningRegistry: { listForDnsZone: async () => operations },
    ownershipRegistry: {
      getForZone: async (input) => { assert.deepEqual(input, scope); return receipt; },
      removeForZone: async (input) => { removed.push(input); },
    },
    parentDsInspector: { inspect: async () => ({ status: 'absent', records: [], ttl: 0, checkedAt: new Date().toISOString() }) },
    zoneManager: {
      getZone: async () => ({ zoneName: 'example.com', id: 'example.com.', kind: 'Primary', dnssec: false, rrsets: [] }),
      inspectSnapshotDeletion: async () => ({}),
      deleteSnapshot: async (input) => { deleted.push(input); return { deleted: true }; },
    },
  });
  return { service, deleted, removed };
}

const receipt = { ...scope, operationId: '52345678-1234-4234-8234-123456789012', createdAt: '2026-11-09T09:00:00.000Z' };

test('a panel receipt proves zone ownership, and no receipt keeps the zone protected', async () => {
  const owned = await retirement({ receipt }).service.preview({ domainId });
  assert.equal(owned.zone.ownershipOrigin.status, 'provisioning_created');
  assert.equal(owned.zone.ownershipOrigin.operationId, receipt.operationId);
  assert.match(owned.zone.ownershipOrigin.evidenceDigest, /^[a-f0-9]{64}$/);

  const again = await retirement({ receipt }).service.preview({ domainId });
  assert.equal(again.zone.ownershipOrigin.evidenceDigest, owned.zone.ownershipOrigin.evidenceDigest, 'the digest must be stable across previews');

  const foreign = await retirement({ receipt: null }).service.preview({ domainId });
  assert.equal(foreign.zone.ownershipOrigin.status, 'not_found');
  assert.equal(foreign.zone.ownershipOrigin.evidenceDigest, null);
});

test('deleting the zone removes its receipt so it cannot vouch for a later zone', async () => {
  const f = retirement({ receipt });
  await f.service.deleteCapturedSnapshot({ serverId, zoneName: 'example.com', snapshot: {} });
  assert.equal(f.deleted.length, 1);
  assert.deepEqual(f.removed, [{ serverId, zoneName: 'example.com' }]);
});

function provisionRoute({ created, ownershipRegistry }) {
  const routes = new Map();
  const app = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
  const domain = { id: domainId, serverId, primaryDomain: 'example.com', parentDomainId: null };
  const applied = [];
  mountPowerDnsRoutes(app, {
    dnsIdentityRegistry: {
      preview: async () => ({}), update: async () => ({}),
      getForServer: async () => ({
        serverId, revision: 3,
        settings: {
          publicIpv4: '203.0.113.10', publicIpv6: null,
          ns1: { hostname: 'ns1.host.example', ipv4: '203.0.113.10', ipv6: null, local: true },
          ns2: { hostname: 'ns2.host.example', ipv4: '203.0.113.11', ipv6: null, local: false },
          soa: { primaryNs: 'ns1.host.example', rname: 'hostmaster.host.example', refresh: 3600, retry: 900, expire: 1209600, minimum: 300, ttl: 300 },
        },
      }),
    },
    dnsZoneTemplateRegistry: {
      getForServer: async () => ({
        serverId, version: 7,
        records: [{ key: 'apex-nameservers', owner: '@', type: 'NS', ttl: null, values: ['<ns1>', '<ns2>'], condition: 'always' }],
      }),
      ensureForServer: async () => ({}), getVersion: async () => null, preview: async () => ({}), update: async () => ({}),
    },
    dnsDelegationInspector: { inspect: async () => ({ state: 'ready' }) },
    dnsZoneReapplyRuntime: {
      preview: async () => ({}), start: async () => ({}), rollbackPreview: async () => ({}), rollback: async () => ({}),
      get: async () => null, listForDomain: async () => [],
    },
    dnsZoneRecordsService: { getZone: async () => ({ domainId, zoneName: 'example.com' }), apply: async () => ({}), remove: async () => ({}) },
    domainRegistry: { getDomain: async () => domain },
    powerDnsSecretRegistry: { materializeForServer: async () => ({ apiKey: 'a'.repeat(43) }) },
    powerDnsZoneManager: { apply: async (input) => { applied.push(input); return { created }; } },
    dnsZoneOwnershipRegistry: ownershipRegistry,
    authoritativeService: {
      localServerId: serverId, status: async () => ({}), preview: async () => ({}), apply: async () => ({}),
      resolve: async () => ({}), retry: async () => ({}), rollback: async () => ({}),
    },
  });
  return async () => {
    let failure = null;
    let payload = null;
    await routes.get('POST /api/domains/:domainId/dns/provision-zone').at(-1)(
      { params: { domainId }, body: {} },
      { json(value) { payload = value; return value; } },
      (error) => { failure = error ?? null; },
    );
    if (failure) throw failure;
    return { payload, applied };
  };
}

test('provisioning writes a receipt only when this request created the zone', async () => {
  const recorded = [];
  const registry = { recordCreated: async (input) => { recorded.push(input); return input; } };

  const existing = await provisionRoute({ created: false, ownershipRegistry: registry })();
  assert.equal(existing.applied.length, 1);
  assert.equal(recorded.length, 0, 'a pre-existing zone is never claimed');

  await provisionRoute({ created: true, ownershipRegistry: registry })();
  assert.deepEqual(recorded, [scope]);
});

test('a receipt that cannot be saved does not fail a zone that was created', async () => {
  const run = provisionRoute({ created: true, ownershipRegistry: { recordCreated: async () => { throw new Error('disk full'); } } });
  const { payload } = await run();
  assert.equal(payload.data.zoneName, 'example.com');
});
