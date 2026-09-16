import assert from 'node:assert/strict';
import test from 'node:test';
import { createDnsZoneDnssecOperationRegistry } from '../src/dns-zone-dnssec-operation-registry.js';
import {
  createDnsZoneDnssecRuntime,
  DnsZoneDnssecRuntimeError,
} from '../src/dns-zone-dnssec-runtime.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const enableDigest = 'a'.repeat(64);
const disableDigest = 'b'.repeat(64);
const ds = '12345 13 2 AABBCCDD';

function preview(enabled) {
  const previewDigest = enabled ? enableDigest : disableDigest;
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
    previewDigest,
    confirmation: `${enabled ? 'enable' : 'disable'}-dnssec:${domainId}:${previewDigest}`,
    registrar: Object.freeze({ addDs: Object.freeze([]), removeDsBeforeDisable: Object.freeze([]) }),
    impact: Object.freeze({}),
  });
}

function state(enabled = false) {
  return Object.freeze({
    domainId,
    serverId,
    zoneName: 'example.com',
    dnssec: enabled,
    localReady: enabled,
    status: enabled ? 'pending_parent_ds' : 'insecure',
    secureReady: false,
    serial: 2026091601,
    keys: Object.freeze([]),
    ds: Object.freeze(enabled ? [ds] : []),
    parent: Object.freeze({
      status: 'absent',
      records: Object.freeze([]),
      matchingRecords: Object.freeze([]),
      errorCode: null,
      checkedAt: '2026-09-16T00:50:00.000Z',
    }),
    registrar: Object.freeze({ addDs: Object.freeze(enabled ? [ds] : []), removeDsBeforeDisable: Object.freeze([]) }),
  });
}

function runtimeFixture() {
  const registry = createDnsZoneDnssecOperationRegistry();
  let current = state(false);
  let applyCalls = 0;
  const service = {
    status: async () => current,
    preview: async ({ enabled }) => preview(enabled),
    apply: async ({ enabled }) => {
      applyCalls += 1;
      current = state(enabled);
      return { applied: true, changed: true, ...current };
    },
  };
  return {
    registry,
    runtime: createDnsZoneDnssecRuntime({ registry, service }),
    applyCalls: () => applyCalls,
    setState(value) { current = value; },
  };
}

test('different DNSSEC mutation is rejected while an operation is applying for the same Domain', async () => {
  const { registry, runtime } = runtimeFixture();
  await registry.init();
  const active = await registry.create(preview(true));
  await registry.markApplying(active.id);

  const disable = preview(false);
  await assert.rejects(
    runtime.start({
      domainId,
      enabled: false,
      previewDigest: disable.previewDigest,
      confirmation: disable.confirmation,
    }),
    (error) => error instanceof DnsZoneDnssecRuntimeError && error.code === 'dnssec_operation_conflict',
  );
  assert.equal((await registry.listForDomain(domainId)).length, 1);
});

test('same DNSSEC request resumes the existing applying operation instead of creating a duplicate', async () => {
  const { registry, runtime, applyCalls, setState } = runtimeFixture();
  await registry.init();
  const enable = preview(true);
  const active = await registry.create(enable);
  await registry.markApplying(active.id);
  setState(state(true));

  const resumed = await runtime.start({
    domainId,
    enabled: true,
    previewDigest: enable.previewDigest,
    confirmation: enable.confirmation,
  });
  assert.equal(resumed.id, active.id);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(applyCalls(), 0);
  assert.equal((await registry.listForDomain(domainId)).length, 1);
});
