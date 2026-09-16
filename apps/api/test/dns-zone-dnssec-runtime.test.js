import assert from 'node:assert/strict';
import test from 'node:test';
import { createDnsZoneDnssecOperationRegistry } from '../src/dns-zone-dnssec-operation-registry.js';
import {
  createDnsZoneDnssecRuntime,
  DnsZoneDnssecRuntimeError,
} from '../src/dns-zone-dnssec-runtime.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const digest = 'b'.repeat(64);
const ds = '12345 13 2 AABBCCDD';

function state({ enabled = false, localReady = enabled, parentStatus = 'absent', parentRecords = [], status = null } = {}) {
  const localDs = enabled && localReady ? [ds] : [];
  const matching = parentStatus === 'present' && parentRecords.includes(ds) && localReady ? [ds] : [];
  const derivedStatus = status ?? (enabled
    ? !localReady ? 'signing_material_incomplete'
      : parentStatus === 'present' ? (matching.length ? 'secure_ready' : 'parent_ds_mismatch')
        : parentStatus === 'unverifiable' ? 'parent_ds_unverifiable' : 'pending_parent_ds'
    : parentStatus === 'present' ? 'parent_ds_without_dnssec'
      : parentStatus === 'unverifiable' ? 'insecure_parent_unverifiable' : 'insecure');
  return Object.freeze({
    domainId,
    serverId,
    zoneName: 'example.com',
    dnssec: enabled,
    localReady,
    status: derivedStatus,
    secureReady: derivedStatus === 'secure_ready',
    serial: 2026091601,
    keys: Object.freeze([]),
    ds: Object.freeze(localDs),
    parent: Object.freeze({
      status: parentStatus,
      records: Object.freeze([...parentRecords]),
      matchingRecords: Object.freeze(matching),
      errorCode: parentStatus === 'unverifiable' ? 'ETIMEOUT' : null,
      checkedAt: '2026-09-16T00:40:00.000Z',
    }),
    registrar: Object.freeze({ addDs: localDs, removeDsBeforeDisable: parentRecords }),
  });
}

function preview(enabled) {
  return Object.freeze({
    version: 1,
    domainId,
    serverId,
    zoneName: 'example.com',
    targetEnabled: enabled,
    currentDnssec: !enabled,
    currentLocalReady: !enabled,
    currentDs: Object.freeze([]),
    parentStatus: 'absent',
    parentRecords: Object.freeze([]),
    parentMatchingRecords: Object.freeze([]),
    blockers: Object.freeze([]),
    status: enabled ? 'insecure' : 'pending_parent_ds',
    noChanges: false,
    applyAllowed: true,
    previewDigest: digest,
    confirmation: `${enabled ? 'enable' : 'disable'}-dnssec:${domainId}:${digest}`,
    registrar: Object.freeze({ addDs: Object.freeze([]), removeDsBeforeDisable: Object.freeze([]) }),
    impact: Object.freeze({}),
  });
}

function fixture({ targetEnabled = true, initialState = state(), applyBehavior = 'success', previewValue = null } = {}) {
  const calls = [];
  let currentState = initialState;
  const service = {
    status: async () => { calls.push('status'); return currentState; },
    preview: async () => { calls.push('preview'); return previewValue ?? preview(targetEnabled); },
    apply: async () => {
      calls.push('apply');
      const after = targetEnabled ? state({ enabled: true }) : state({ enabled: false });
      if (applyBehavior === 'mutate-then-throw') {
        currentState = after;
        throw Object.assign(new Error('connection reset'), { code: 'dnssec_provider_uncertain' });
      }
      if (applyBehavior === 'throw') throw Object.assign(new Error('provider failed'), { code: 'dnssec_provider_failed' });
      currentState = after;
      return { applied: true, changed: true, ...after };
    },
  };
  const registry = createDnsZoneDnssecOperationRegistry();
  const runtime = createDnsZoneDnssecRuntime({ registry, service });
  return {
    calls,
    registry,
    runtime,
    setState(value) { currentState = value; },
  };
}

test('durable DNSSEC runtime journals and completes a normal enable operation', async () => {
  const { calls, runtime } = fixture({ targetEnabled: true });
  await runtime.init();
  const plan = await runtime.preview({ domainId, enabled: true });
  const operation = await runtime.start({
    domainId,
    enabled: true,
    previewDigest: plan.previewDigest,
    confirmation: plan.confirmation,
  });

  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.targetEnabled, true);
  assert.equal(operation.result.dnssec, true);
  assert.equal(operation.result.status, 'pending_parent_ds');
  assert.equal(calls.filter((entry) => entry === 'apply').length, 1);
  assert.equal(Object.hasOwn(operation, 'confirmation'), false);
});

test('restart recovery completes an already-applied DNSSEC enable without a second provider mutation', async () => {
  const { calls, registry, runtime, setState } = fixture({ targetEnabled: true });
  await registry.init();
  const operation = await registry.create(preview(true));
  await registry.markApplying(operation.id);
  setState(state({ enabled: true }));

  const recovery = await runtime.init();
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.status, 'succeeded');
  assert.equal(calls.filter((entry) => entry === 'apply').length, 0);
});

test('restart recovery does not accept dnssec=true without signing keys and DS evidence', async () => {
  const blockedPreview = Object.freeze({
    ...preview(true),
    currentDnssec: true,
    currentLocalReady: false,
    status: 'signing_material_incomplete',
    blockers: Object.freeze([{ code: 'dnssec_signing_material_incomplete' }]),
    applyAllowed: false,
    confirmation: null,
  });
  const { calls, registry, runtime, setState } = fixture({ targetEnabled: true, previewValue: blockedPreview });
  await registry.init();
  const operation = await registry.create(preview(true));
  await registry.markApplying(operation.id);
  setState(state({ enabled: true, localReady: false }));

  const result = await runtime.run(operation.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'dnssec_preview_stale');
  assert.equal(calls.filter((entry) => entry === 'apply').length, 0);
});

test('uncertain DNSSEC provider response is reconciled by authoritative post-condition', async () => {
  const { calls, runtime } = fixture({ targetEnabled: true, applyBehavior: 'mutate-then-throw' });
  await runtime.init();
  const plan = await runtime.preview({ domainId, enabled: true });
  const operation = await runtime.start({
    domainId,
    enabled: true,
    previewDigest: plan.previewDigest,
    confirmation: plan.confirmation,
  });

  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.result.dnssec, true);
  assert.equal(calls.filter((entry) => entry === 'apply').length, 1);
});

test('recovery marks disabled DNSSEC with a reappeared parent DS as unsafe failure', async () => {
  const { registry, runtime, setState } = fixture({ targetEnabled: false, initialState: state({ enabled: true }) });
  await registry.init();
  const operation = await registry.create(preview(false));
  await registry.markApplying(operation.id);
  setState(state({ enabled: false, parentStatus: 'present', parentRecords: [ds] }));

  const result = await runtime.run(operation.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'dnssec_disable_parent_regressed');
});

test('recovery leaves a disabled operation applying when parent DS cannot be verified', async () => {
  const { registry, runtime, setState } = fixture({ targetEnabled: false, initialState: state({ enabled: true }) });
  await registry.init();
  const operation = await registry.create(preview(false));
  await registry.markApplying(operation.id);
  setState(state({ enabled: false, parentStatus: 'unverifiable' }));

  await assert.rejects(
    runtime.run(operation.id),
    (error) => error instanceof DnsZoneDnssecRuntimeError && error.code === 'dnssec_recovery_parent_unverifiable',
  );
  assert.equal((await registry.get(operation.id)).status, 'applying');
});

test('runtime fails a journaled operation when its exact preview contract becomes stale', async () => {
  const stale = { ...preview(true), previewDigest: 'c'.repeat(64), confirmation: `enable-dnssec:${domainId}:${'c'.repeat(64)}` };
  const { registry, runtime } = fixture({ targetEnabled: true, previewValue: stale });
  await registry.init();
  const operation = await registry.create(preview(true));
  await registry.markApplying(operation.id);

  const result = await runtime.run(operation.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'dnssec_preview_stale');
});
