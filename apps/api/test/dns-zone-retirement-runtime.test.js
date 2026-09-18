import assert from 'node:assert/strict';
import test from 'node:test';
import { powerDnsZoneManagerInternals } from '@yunpanel/host-runtime/powerdns-zone-manager';
import { createDnsZoneRetirementOperationRegistry } from '../src/dns-zone-retirement-operation-registry.js';
import {
  createDnsZoneRetirementRuntime,
  dnsZoneRetirementRuntimeInternals,
} from '../src/dns-zone-retirement-runtime.js';

const operationId = '12345678-1234-4234-8234-123456789012';
const domainId = '22345678-1234-4234-8234-123456789012';
const serverId = '32345678-1234-4234-8234-123456789012';
const previewDigest = 'a'.repeat(64);
const ownershipEvidenceDigest = 'b'.repeat(64);

function retainedSnapshot() {
  return powerDnsZoneManagerInternals.zoneSnapshot({
    zoneName: 'example.com',
    id: 'example.com.',
    kind: 'Primary',
    dnssec: false,
    rrsets: [{
      name: 'example.com.',
      type: 'A',
      ttl: 300,
      records: [{ content: '203.0.113.10', disabled: false }],
      comments: [],
    }],
  });
}

const snapshot = retainedSnapshot();
const snapshotDigest = powerDnsZoneManagerInternals.zoneSnapshotDigest(snapshot);
const retirementConfirmation =
  `retire-authoritative-zone:${domainId}:4:${snapshotDigest}:${ownershipEvidenceDigest}:30:${previewDigest}`;

function capture() {
  return Object.freeze({
    version: 1,
    domainId,
    serverId,
    zoneName: 'example.com',
    domainRevision: 4,
    previewDigest,
    snapshotDigest,
    ownershipEvidenceDigest,
    snapshotRetentionDays: 30,
    confirmation: retirementConfirmation,
    snapshot,
  });
}

function matchingPreview(overrides = {}) {
  return Object.freeze({
    version: 1,
    operation: 'dns_zone_retirement_impact',
    domain: Object.freeze({
      id: domainId,
      serverId,
      websiteId: null,
      primaryDomain: 'example.com',
      parentDomainId: null,
      certificateId: null,
      desiredRevision: 4,
      appliedRevision: 0,
      state: 'draft',
    }),
    hierarchy: Object.freeze({ descendantCount: 0, descendants: Object.freeze([]) }),
    routing: Object.freeze({
      active: false,
      stagedRevision: 0,
      appliedRevision: 0,
      appliedPrimaryDomain: null,
    }),
    zone: Object.freeze({
      exists: true,
      snapshotDigest,
      kind: 'Primary',
      dnssec: false,
      rrsetCount: 1,
      managedRrsetCount: 1,
      manualRrsetCount: 0,
      ownership: 'provisioning_created',
      ownershipOrigin: Object.freeze({
        status: 'provisioning_created',
        operationId: '42345678-1234-4234-8234-123456789012',
        updatedAt: '2026-09-18T16:00:00.000Z',
        evidenceDigest: ownershipEvidenceDigest,
      }),
    }),
    retention: Object.freeze({ configured: true, snapshotRetentionDays: 30 }),
    blockers: Object.freeze([]),
    retirementPlanReady: true,
    previewDigest,
    confirmation: retirementConfirmation,
    sideEffects: false,
    ...overrides,
  });
}

function registry(now = () => Date.parse('2026-09-18T16:00:00.000Z')) {
  return createDnsZoneRetirementOperationRegistry({
    now,
    idFactory: () => operationId,
  });
}

function serviceFixture({
  initialState = 'present',
  preview = matchingPreview(),
  deleteMode = 'success',
} = {}) {
  let state = initialState;
  let deleteCalls = 0;
  let captureCalls = 0;
  let inspectCalls = 0;
  const service = {
    async captureDeletionSnapshot(input) {
      captureCalls += 1;
      assert.deepEqual(input, { domainId, previewDigest, confirmation: retirementConfirmation });
      return capture();
    },
    async preview(input) {
      assert.deepEqual(input, { domainId });
      return preview;
    },
    async inspectDeletion(input) {
      inspectCalls += 1;
      assert.equal(input.serverId, serverId);
      assert.equal(input.zoneName, 'example.com');
      assert.deepEqual(input.snapshot, snapshot);
      if (state === 'drift') {
        const error = new Error('zone drifted');
        error.code = 'powerdns_zone_snapshot_delete_drift';
        error.status = 409;
        throw error;
      }
      if (state === 'unavailable') {
        const error = new Error('PowerDNS offline');
        error.code = 'powerdns_zone_api_unavailable';
        error.status = 503;
        throw error;
      }
      return {
        satisfied: state === 'absent',
        deleteCandidate: state === 'present',
        deleted: state === 'absent',
        zoneName: 'example.com',
        snapshotDigest,
      };
    },
    async deleteCapturedSnapshot(input) {
      deleteCalls += 1;
      assert.equal(input.serverId, serverId);
      assert.equal(input.zoneName, 'example.com');
      assert.deepEqual(input.snapshot, snapshot);
      if (deleteMode === 'lost_ack') {
        state = 'absent';
        const error = new Error('connection closed after DELETE');
        error.code = 'powerdns_zone_api_unavailable';
        error.status = 503;
        throw error;
      }
      if (deleteMode === 'failed') {
        const error = new Error('provider rejected delete');
        error.code = 'powerdns_zone_api_failed';
        error.status = 503;
        throw error;
      }
      state = 'absent';
      return {
        satisfied: true,
        deleted: true,
        changed: true,
        zoneName: 'example.com',
        snapshotDigest,
      };
    },
  };
  return {
    service,
    counts: () => ({ deleteCalls, captureCalls, inspectCalls }),
    setState(value) { state = value; },
  };
}

test('durable zone retirement journals private snapshot before exact provider deletion', async () => {
  const store = registry();
  const fx = serviceFixture();
  const runtime = createDnsZoneRetirementRuntime({ registry: store, service: fx.service });
  await runtime.init();

  const completed = await runtime.start({
    domainId,
    previewDigest,
    confirmation: retirementConfirmation,
  });

  assert.equal(completed.status, 'deleted');
  assert.equal(completed.result.deleted, true);
  assert.equal(completed.result.changed, true);
  assert.equal(completed.snapshotDigest, snapshotDigest);
  assert.equal(Object.hasOwn(completed, 'snapshot'), false);
  assert.equal(Object.hasOwn(completed, 'confirmation'), false);
  assert.equal(fx.counts().captureCalls, 1);
  assert.equal(fx.counts().deleteCalls, 1);
  const privateOperation = await store.get(operationId);
  assert.deepEqual(privateOperation.snapshot, snapshot);
});

test('provider lost acknowledgement is reconciled from absent post-condition without a second DELETE', async () => {
  const store = registry();
  const fx = serviceFixture({ deleteMode: 'lost_ack' });
  const runtime = createDnsZoneRetirementRuntime({ registry: store, service: fx.service });
  await runtime.init();

  const completed = await runtime.start({
    domainId,
    previewDigest,
    confirmation: retirementConfirmation,
  });

  assert.equal(completed.status, 'deleted');
  assert.equal(completed.result.changed, false);
  assert.equal(fx.counts().deleteCalls, 1);
  assert.ok(fx.counts().inspectCalls >= 2);
});

test('startup inspects interrupted delete but never automatically replays mutation while snapshot is present', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(capture());
  await store.markDeleting(created.id);
  const fx = serviceFixture({ initialState: 'present' });
  const runtime = createDnsZoneRetirementRuntime({ registry: store, service: fx.service });

  const recovery = await runtime.init();

  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].operationId, operationId);
  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].error.code, 'dns_zone_retirement_retry_required');
  assert.equal((await store.get(operationId)).status, 'deleting');
  assert.equal(fx.counts().deleteCalls, 0);
  const publicOperation = await runtime.get(operationId);
  assert.equal(publicOperation.recovery.required, true);
  assert.equal(publicOperation.recovery.retryable, true);
  assert.match(publicOperation.recovery.retryConfirmation, /^retry-dns-zone-retirement:/);
});

test('startup closes interrupted delete from exact absent post-condition without replay', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(capture());
  await store.markDeleting(created.id);
  const fx = serviceFixture({ initialState: 'absent' });
  const runtime = createDnsZoneRetirementRuntime({ registry: store, service: fx.service });

  const recovery = await runtime.init();

  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.status, 'deleted');
  assert.equal(recovery[0].operation.result.changed, false);
  assert.equal(fx.counts().deleteCalls, 0);
});

test('explicit retry is journal-revision bound and replays mutation only after exact inspection', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(capture());
  const deleting = await store.markDeleting(created.id);
  const failed = await store.fail(deleting.id, {
    code: 'powerdns_zone_api_failed',
    message: 'PowerDNS delete failed',
  });
  const fx = serviceFixture({ initialState: 'present' });
  const runtime = createDnsZoneRetirementRuntime({ registry: store, service: fx.service });
  const current = await runtime.get(operationId);

  await assert.rejects(
    runtime.retry({
      domainId,
      operationId,
      expectedUpdatedAt: current.updatedAt,
      snapshotDigest,
      confirmation: 'wrong',
    }),
    (error) => error.code === 'dns_zone_retirement_retry_stale',
  );
  assert.equal(fx.counts().deleteCalls, 0);

  const completed = await runtime.retry({
    domainId,
    operationId,
    expectedUpdatedAt: current.updatedAt,
    snapshotDigest,
    confirmation: current.recovery.retryConfirmation,
  });
  assert.equal(completed.status, 'deleted');
  assert.equal(fx.counts().deleteCalls, 1);
  assert.notEqual(failed.updatedAt, completed.updatedAt);
});

test('journaled retirement refuses stale Domain/ownership/retention preview before DELETE', async () => {
  const store = registry();
  const fx = serviceFixture({
    preview: matchingPreview({
      retention: Object.freeze({ configured: true, snapshotRetentionDays: 31 }),
      previewDigest: 'c'.repeat(64),
      confirmation: 'stale',
    }),
  });
  const runtime = createDnsZoneRetirementRuntime({ registry: store, service: fx.service });

  const failed = await runtime.start({
    domainId,
    previewDigest,
    confirmation: retirementConfirmation,
  });

  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'dns_zone_retirement_preview_stale');
  assert.equal(fx.counts().deleteCalls, 0);
});

test('interrupted snapshot drift becomes terminal failure without destructive retry', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(capture());
  await store.markDeleting(created.id);
  const fx = serviceFixture({ initialState: 'drift' });
  const runtime = createDnsZoneRetirementRuntime({ registry: store, service: fx.service });

  const recovery = await runtime.init();

  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.status, 'failed');
  assert.equal(recovery[0].operation.error.code, 'powerdns_zone_snapshot_delete_drift');
  assert.equal(fx.counts().deleteCalls, 0);
});

test('runtime helper binds retry confirmation to operation revision and snapshot digest', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(capture());
  const deleting = await store.markDeleting(created.id);
  const confirmation = dnsZoneRetirementRuntimeInternals.retryConfirmation(deleting);
  assert.equal(
    confirmation,
    `retry-dns-zone-retirement:${domainId}:${operationId}:${deleting.updatedAt}:${snapshotDigest}`,
  );
});
