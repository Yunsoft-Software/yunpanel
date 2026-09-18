import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDnsZoneReapplyOperationRegistry } from '../src/dns-zone-reapply-operation-registry.js';
import { createDnsZoneReapplyRuntime } from '../src/dns-zone-reapply-runtime.js';

const operationId = 'f77d9d70-3f77-4be9-b257-0ade06401fb7';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const previewDigest = 'a'.repeat(64);
const confirmation = `reapply-dns-zone-template:${domainId}:${previewDigest}`;
const sourceZoneSnapshot = Object.freeze({
  version: 1,
  zoneName: 'example.com',
  id: 'example.com.',
  kind: 'Native',
  dnssec: false,
  rrsets: Object.freeze([Object.freeze({
    name: 'example.com.',
    type: 'SOA',
    ttl: 300,
    records: Object.freeze([Object.freeze({
      content: 'ns1.host.example. hostmaster.host.example. 2026091501 3600 900 1209600 300',
      disabled: false,
    })]),
    comments: Object.freeze([Object.freeze({ account: 'yunpanel', content: 'managed source snapshot' })]),
  })]),
});
const sourceZoneDigest = createHash('sha256').update(JSON.stringify(sourceZoneSnapshot)).digest('hex');
const appliedZoneSnapshot = Object.freeze({
  ...sourceZoneSnapshot,
  kind: 'Primary',
  rrsets: Object.freeze(sourceZoneSnapshot.rrsets.map((rrset) => rrset.type === 'SOA'
    ? Object.freeze({
      ...rrset,
      records: Object.freeze(rrset.records.map((record) => Object.freeze({
        ...record,
        content: record.content.replace('2026091501', '2026091601'),
      }))),
    })
    : rrset)),
});
const appliedZoneDigest = createHash('sha256').update(JSON.stringify(appliedZoneSnapshot)).digest('hex');

function rollbackEvidence() {
  return Object.freeze({
    version: 2,
    sourceZoneDigest,
    sourceZoneSnapshot,
    appliedZoneDigest,
    appliedZoneSnapshot,
  });
}

function plannedPreview(overrides = {}) {
  return Object.freeze({
    version: 1,
    domainId,
    serverId,
    domainRevision: 3,
    zoneName: 'example.com',
    templateVersion: 4,
    dnsIdentityRevision: 2,
    mailStateDigest: 'c'.repeat(64),
    sourceZoneDigest,
    observedSerial: 2026091501,
    nextSerial: 2026091601,
    applyAllowed: true,
    noChanges: false,
    preservedManualRrsetCount: 1,
    previewDigest,
    confirmation,
    ...overrides,
  });
}

function satisfiedPreview(overrides = {}) {
  return plannedPreview({
    sourceZoneDigest: appliedZoneDigest,
    observedSerial: 2026091601,
    nextSerial: 2026091601,
    applyAllowed: false,
    noChanges: true,
    confirmation: null,
    ...overrides,
  });
}

function registry() {
  return createDnsZoneReapplyOperationRegistry({
    now: () => Date.parse('2026-09-16T00:00:00.000Z'),
    idFactory: () => operationId,
  });
}

test('durable DNS zone reapply journals before provider mutation and completes with evidence', async () => {
  const store = registry();
  const calls = [];
  const service = {
    captureRollbackSnapshot: async ({ preview }) => {
      assert.equal(preview.sourceZoneDigest, sourceZoneDigest);
      return rollbackEvidence();
    },
    preview: async (input) => { calls.push(['preview', input]); return plannedPreview(); },
    apply: async (input) => {
      calls.push(['apply', input]);
      return {
        domainId,
        serverId,
        zoneName: 'example.com',
        satisfied: true,
        serial: 2026091601,
        changedRrsetCount: 3,
        manualRrsetCount: 1,
      };
    },
  };
  const runtime = createDnsZoneReapplyRuntime({ registry: store, service });
  await runtime.init();

  const completed = await runtime.start({ domainId, previewDigest, confirmation });
  assert.equal(completed.id, operationId);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.serial, 2026091601);
  assert.equal(calls.filter((entry) => entry[0] === 'apply').length, 1);
  assert.deepEqual(calls.find((entry) => entry[0] === 'apply')[1], { domainId, previewDigest, confirmation });
  assert.equal(Object.hasOwn(completed, 'confirmation'), false);
});

test('interrupted DNS zone reapply inspects first and never repeats an already satisfied provider mutation', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(plannedPreview(), rollbackEvidence());
  await store.markApplying(created.id);
  let applyCalls = 0;
  const runtime = createDnsZoneReapplyRuntime({
    registry: store,
    service: {
      captureRollbackSnapshot: async ({ preview }) => {
      assert.equal(preview.sourceZoneDigest, sourceZoneDigest);
      return rollbackEvidence();
    },
      preview: async () => satisfiedPreview(),
      apply: async () => { applyCalls += 1; throw new Error('must not run'); },
    },
  });

  const recovered = await runtime.run(created.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.result.serial, 2026091601);
  assert.equal(recovered.result.changedRrsetCount, 0);
  assert.equal(applyCalls, 0);
});

test('provider timeout after mutation is reconciled from the authoritative post-condition', async () => {
  const store = registry();
  let state = 'planned';
  let applyCalls = 0;
  const runtime = createDnsZoneReapplyRuntime({
    registry: store,
    service: {
      captureRollbackSnapshot: async ({ preview }) => {
      assert.equal(preview.sourceZoneDigest, sourceZoneDigest);
      return rollbackEvidence();
    },
      preview: async () => state === 'planned' ? plannedPreview() : satisfiedPreview(),
      apply: async () => {
        applyCalls += 1;
        state = 'satisfied';
        const error = new Error('connection closed after PATCH');
        error.code = 'powerdns_zone_api_unavailable';
        throw error;
      },
    },
  });
  await runtime.init();

  const completed = await runtime.start({ domainId, previewDigest, confirmation });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.serial, 2026091601);
  assert.equal(applyCalls, 1);
});

test('journaled DNS zone reapply fails closed if the preview changes before provider mutation', async () => {
  const store = registry();
  let previewCalls = 0;
  let applyCalls = 0;
  const runtime = createDnsZoneReapplyRuntime({
    registry: store,
    service: {
      captureRollbackSnapshot: async ({ preview }) => {
      assert.equal(preview.sourceZoneDigest, sourceZoneDigest);
      return rollbackEvidence();
    },
      preview: async () => {
        previewCalls += 1;
        return previewCalls === 1
          ? plannedPreview()
          : plannedPreview({ previewDigest: 'b'.repeat(64), confirmation: `reapply-dns-zone-template:${domainId}:${'b'.repeat(64)}` });
      },
      apply: async () => { applyCalls += 1; return {}; },
    },
  });
  await runtime.init();

  const failed = await runtime.start({ domainId, previewDigest, confirmation });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'dns_zone_reapply_preview_stale');
  assert.equal(applyCalls, 0);
});

test('runtime init recovers applying operations without making API startup depend on temporary DNS reachability', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(plannedPreview(), rollbackEvidence());
  await store.markApplying(created.id);
  const runtime = createDnsZoneReapplyRuntime({
    registry: store,
    service: {
      captureRollbackSnapshot: async ({ preview }) => {
      assert.equal(preview.sourceZoneDigest, sourceZoneDigest);
      return rollbackEvidence();
    },
      preview: async () => {
        const error = new Error('temporary DNS API outage');
        error.code = 'powerdns_zone_api_unavailable';
        throw error;
      },
      apply: async () => { throw new Error('must not run'); },
    },
  });

  const recovery = await runtime.init();
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].operationId, operationId);
  assert.equal(recovery[0].recovered, false);
  assert.equal((await store.get(operationId)).status, 'applying');
});

test('interrupted reapply does not accept a different mail desired state as its original target', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(plannedPreview(), rollbackEvidence());
  await store.markApplying(created.id);
  let applyCalls = 0;
  const runtime = createDnsZoneReapplyRuntime({
    registry: store,
    service: {
      captureRollbackSnapshot: async ({ preview }) => {
      assert.equal(preview.sourceZoneDigest, sourceZoneDigest);
      return rollbackEvidence();
    },
      preview: async () => satisfiedPreview({ mailStateDigest: 'd'.repeat(64) }),
      apply: async () => { applyCalls += 1; return {}; },
    },
  });

  const recovered = await runtime.run(created.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error.code, 'dns_zone_reapply_preview_stale');
  assert.equal(applyCalls, 0);
});


test('journaled DNS zone reapply fails closed if exact source-zone evidence drifts', async () => {
  const store = registry();
  let previewCalls = 0;
  let applyCalls = 0;
  const runtime = createDnsZoneReapplyRuntime({
    registry: store,
    service: {
      captureRollbackSnapshot: async ({ preview }) => {
      assert.equal(preview.sourceZoneDigest, sourceZoneDigest);
      return rollbackEvidence();
    },
      preview: async () => {
        previewCalls += 1;
        return previewCalls === 1
          ? plannedPreview()
          : plannedPreview({ sourceZoneDigest: 'e'.repeat(64) });
      },
      apply: async () => { applyCalls += 1; return {}; },
    },
  });
  await runtime.init();

  const failed = await runtime.start({ domainId, previewDigest, confirmation });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'dns_zone_reapply_preview_stale');
  assert.equal(applyCalls, 0);
});


test('recovery refuses a no-op target when the exact final zone digest is not the journaled after-state', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(plannedPreview(), rollbackEvidence());
  await store.markApplying(created.id);
  let applyCalls = 0;
  const runtime = createDnsZoneReapplyRuntime({
    registry: store,
    service: {
      captureRollbackSnapshot: async () => rollbackEvidence(),
      preview: async () => satisfiedPreview({ sourceZoneDigest: 'f'.repeat(64) }),
      apply: async () => { applyCalls += 1; return {}; },
    },
  });

  const failed = await runtime.run(created.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'dns_zone_reapply_preview_stale');
  assert.equal(applyCalls, 0);
});
