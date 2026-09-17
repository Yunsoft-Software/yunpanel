import assert from 'node:assert/strict';
import test from 'node:test';
import { createDnsZoneDnssecRolloverRegistry } from '../src/dns-zone-dnssec-rollover-registry.js';
import {
  createDnsZoneDnssecRolloverRuntime,
  DnsZoneDnssecRolloverRuntimeError,
} from '../src/dns-zone-dnssec-rollover-runtime.js';

const operationId = '6b11545e-e9cf-4227-b525-21c986d7e3f4';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const oldDs = '12345 13 2 AABBCCDD';
const newDs = '22345 13 2 EEFF0011';
const initialDigest = 'a'.repeat(64);
const createdDigest = 'c'.repeat(64);
const publishedDigest = 'd'.repeat(64);
const activatedDigest = 'e'.repeat(64);
const deactivatedDigest = 'f'.repeat(64);
const deletedDigest = '1'.repeat(64);

function rolloverPreview({ digest = 'b'.repeat(64) } = {}) {
  return Object.freeze({
    version: 1,
    action: 'dnssec_key_rollover',
    domainId,
    serverId,
    zoneName: 'example.com',
    expectedKeySetDigest: initialDigest,
    expectedKeyIds: Object.freeze([7]),
    oldKey: Object.freeze({ id: 7, keyType: 'csk', algorithm: 'ECDSAP256SHA256', bits: 256, ds: Object.freeze([oldDs]) }),
    newKey: Object.freeze({ keyType: 'csk', algorithm: 'ECDSAP256SHA256', bits: 256, active: false, published: false }),
    parentDs: Object.freeze([oldDs]),
    stages: Object.freeze([
      'create_new_key',
      'publish_new_key',
      'verify_dnskey_propagation',
      'activate_new_key',
      'await_parent_ds_addition',
      'await_old_ds_retirement',
      'deactivate_old_key',
      'delete_old_key',
    ]),
    blockers: Object.freeze([]),
    applyAllowed: true,
    previewDigest: digest,
    confirmation: `rollover-dnssec:${domainId}:${digest}`,
    impact: Object.freeze({}),
  });
}

function publicKey({ id = 8, active = false, published = false } = {}) {
  return Object.freeze({
    id,
    keyType: 'csk',
    active,
    published,
    dnskey: id === 7 ? '257 3 13 AAAAOLDKEY' : '257 3 13 AAAANEWKEY',
    ds: Object.freeze(id === 7 ? [oldDs] : [newDs]),
    cds: Object.freeze(id === 7 ? [oldDs] : [newDs]),
    algorithm: 'ECDSAP256SHA256',
    bits: 256,
  });
}

function fixture({
  failCreateAfterMutation = false,
  failPublishAfterMutation = false,
  failActivateAfterMutation = false,
  failDeactivateAfterMutation = false,
  staleSecondPreview = false,
  propagationReady = false,
  parentRecords = [oldDs],
  parentRecordSequence = null,
  parentTtl = 300,
  parentCheckedAtSequence = null,
} = {}) {
  const registry = createDnsZoneDnssecRolloverRegistry({ idFactory: () => operationId });
  const calls = [];
  let created = false;
  let published = false;
  let activated = false;
  let deactivated = false;
  let createFailurePending = failCreateAfterMutation;
  let publishFailurePending = failPublishAfterMutation;
  let activateFailurePending = failActivateAfterMutation;
  let deactivateFailurePending = failDeactivateAfterMutation;
  let createMutations = 0;
  let publishMutations = 0;
  let activateMutations = 0;
  let deactivateMutations = 0;
  let previewCalls = 0;
  let parentStatusCalls = 0;
  const preview = rolloverPreview();
  const service = {
    status: async () => {
      calls.push('parent-status');
      const sequence = parentRecordSequence ?? [parentRecords];
      const index = parentStatusCalls;
      const records = sequence[Math.min(index, sequence.length - 1)];
      const checkedSequence = parentCheckedAtSequence ?? ['2026-09-17T10:00:00.000Z'];
      const checkedAt = checkedSequence[Math.min(index, checkedSequence.length - 1)];
      parentStatusCalls += 1;
      return Object.freeze({
        version: 1,
        domainId,
        serverId,
        zoneName: 'example.com',
        dnssec: true,
        localReady: true,
        keySetDigest: deactivated ? deactivatedDigest : activatedDigest,
        parent: Object.freeze({
          status: 'present',
          records: Object.freeze([...records]),
          ttl: parentTtl,
          checkedAt,
        }),
      });
    },
    previewRollover: async () => {
      calls.push('preview');
      previewCalls += 1;
      return staleSecondPreview && previewCalls > 1 ? rolloverPreview({ digest: '9'.repeat(64) }) : preview;
    },
    createRolloverKey: async (input) => {
      calls.push('create');
      assert.equal(input.expectedKeySetDigest, initialDigest);
      if (!created) {
        created = true;
        createMutations += 1;
      }
      if (createFailurePending) {
        createFailurePending = false;
        throw new Error('connection reset after create');
      }
      return Object.freeze({
        changed: createMutations === 1,
        keySetDigest: createdDigest,
        serial: 2026091701,
        createdKey: publicKey(),
      });
    },
    previewRolloverKeyState: async (input) => {
      calls.push(input.keyId === 7 ? 'deactivation-preview' : input.active ? 'activation-preview' : 'publication-preview');
      assert.equal([7, 8].includes(input.keyId), true);
      return Object.freeze({
        keySetDigest: input.keyId === 7 ? activatedDigest : published ? publishedDigest : createdDigest,
        targetKeySetDigest: input.keyId === 7 ? deactivatedDigest : input.active ? activatedDigest : publishedDigest,
        targetKey: publicKey({ id: input.keyId, active: input.active, published: input.published }),
      });
    },
    setRolloverKeyState: async (input) => {
      if (input.keyId === 7) {
        calls.push('deactivate');
        assert.equal(input.expectedKeySetDigest, activatedDigest);
        assert.equal(input.expectedTargetKeySetDigest, deactivatedDigest);
        assert.equal(input.expectedActive, true);
        assert.equal(input.expectedPublished, true);
        assert.equal(input.active, false);
        assert.equal(input.published, true);
        if (!deactivated) {
          deactivated = true;
          deactivateMutations += 1;
        }
        if (deactivateFailurePending) {
          deactivateFailurePending = false;
          throw new Error('connection reset after deactivate');
        }
        return Object.freeze({
          changed: deactivateMutations === 1,
          keySetDigest: deactivatedDigest,
          serial: 2026091704,
          updatedKey: publicKey({ id: 7, active: false, published: true }),
        });
      }
      if (input.active) {
        calls.push('activate');
        assert.equal(input.expectedKeySetDigest, publishedDigest);
        assert.equal(input.expectedTargetKeySetDigest, activatedDigest);
        assert.equal(input.expectedActive, false);
        assert.equal(input.expectedPublished, true);
        if (!activated) {
          activated = true;
          activateMutations += 1;
        }
        if (activateFailurePending) {
          activateFailurePending = false;
          throw new Error('connection reset after activate');
        }
        return Object.freeze({
          changed: activateMutations === 1,
          keySetDigest: activatedDigest,
          serial: 2026091703,
          updatedKey: publicKey({ active: true, published: true }),
        });
      }
      calls.push('publish');
      assert.equal(input.expectedKeySetDigest, createdDigest);
      assert.equal(input.expectedTargetKeySetDigest, publishedDigest);
      if (!published) {
        published = true;
        publishMutations += 1;
      }
      if (publishFailurePending) {
        publishFailurePending = false;
        throw new Error('connection reset after publish');
      }
      return Object.freeze({
        changed: publishMutations === 1,
        keySetDigest: publishedDigest,
        serial: 2026091702,
        updatedKey: publicKey({ published: true }),
      });
    },
    previewRolloverKeyDeletion: async (input) => {
      calls.push('deletion-preview');
      assert.equal(input.keyId, 7);
      assert.equal(deactivated, true);
      return Object.freeze({
        keySetDigest: deactivatedDigest,
        remainingKeySetDigest: deletedDigest,
        deletedKey: publicKey({ id: 7, active: false, published: true }),
        keys: Object.freeze([
          publicKey({ id: 7, active: false, published: true }),
          publicKey({ active: true, published: true }),
        ]),
      });
    },
    inspectRolloverPropagation: async (input) => {
      calls.push('propagation');
      if (!propagationReady) return Object.freeze({ status: 'waiting_ttl', ready: false });
      return Object.freeze({
        version: 1,
        zoneName: 'example.com',
        status: 'synced',
        ready: true,
        expectedSerial: input.expectedSerial,
        dnskeyTtl: 300,
        publishedAt: input.publishedAt,
        eligibleAfter: new Date(Date.parse(input.publishedAt) + 300_000).toISOString(),
        checkedAt: new Date(Date.parse(input.publishedAt) + 300_000).toISOString(),
        targets: Object.freeze([
          Object.freeze({ ready: true }),
          Object.freeze({ ready: true }),
        ]),
      });
    },
  };
  const runtime = createDnsZoneDnssecRolloverRuntime({ registry, service });
  return {
    calls,
    registry,
    runtime,
    service,
    preview,
    createMutations: () => createMutations,
    publishMutations: () => publishMutations,
    activateMutations: () => activateMutations,
    deactivateMutations: () => deactivateMutations,
  };
}

test('journals create and publish intents then stops before DNSKEY propagation activation gate', async () => {
  const fx = fixture();
  await fx.runtime.init();
  const operation = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });

  assert.equal(operation.status, 'verifying_dnskey_propagation');
  assert.equal(operation.evidence.newKeyId, 8);
  assert.equal(operation.evidence.keySetDigest, publishedDigest);
  assert.equal(operation.evidence.targetKeySetDigest, null);
  assert.equal(operation.evidence.propagation, null);
  assert.equal(Object.hasOwn(operation, 'confirmation'), false);
  assert.deepEqual(fx.calls, ['preview', 'preview', 'create', 'publication-preview', 'publish', 'propagation']);
  assert.equal(fx.createMutations(), 1);
  assert.equal(fx.publishMutations(), 1);
});

test('retries an uncertain key creation from persisted creating intent without duplicate generation', async () => {
  const fx = fixture({ failCreateAfterMutation: true });
  await fx.runtime.init();
  await assert.rejects(
    fx.runtime.start({ domainId, previewDigest: fx.preview.previewDigest, confirmation: fx.preview.confirmation }),
    /connection reset after create/,
  );
  assert.equal((await fx.registry.get(operationId)).status, 'creating_key');

  const recovered = await fx.runtime.run(operationId);
  assert.equal(recovered.status, 'verifying_dnskey_propagation');
  assert.equal(fx.createMutations(), 1);
  assert.equal(fx.publishMutations(), 1);
});

test('retries an uncertain publication from exact current and target digests without duplicate mutation', async () => {
  const fx = fixture({ failPublishAfterMutation: true });
  await fx.runtime.init();
  await assert.rejects(
    fx.runtime.start({ domainId, previewDigest: fx.preview.previewDigest, confirmation: fx.preview.confirmation }),
    /connection reset after publish/,
  );
  const interrupted = await fx.registry.get(operationId);
  assert.equal(interrupted.status, 'publishing_key');
  assert.equal(interrupted.evidence.keySetDigest, createdDigest);
  assert.equal(interrupted.evidence.targetKeySetDigest, publishedDigest);

  const recovered = await fx.runtime.run(operationId);
  assert.equal(recovered.status, 'verifying_dnskey_propagation');
  assert.equal(fx.publishMutations(), 1);
});

test('fails a journaled pending rollover if secure preflight identity changes before first mutation', async () => {
  const fx = fixture({ staleSecondPreview: true });
  await fx.runtime.init();
  const operation = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });

  assert.equal(operation.status, 'failed');
  assert.equal(operation.error.code, 'dnssec_rollover_preview_stale');
  assert.equal(fx.createMutations(), 0);
  assert.equal(fx.publishMutations(), 0);
});

test('restart init resumes an interrupted local mutation but never crosses the propagation gate', async () => {
  const fx = fixture();
  await fx.registry.init();
  const operation = await fx.registry.create(fx.preview);
  await fx.registry.advance(operation.id, 'creating_key', operation.evidence);

  const recovery = await fx.runtime.init();
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.status, 'verifying_dnskey_propagation');
  assert.equal(fx.createMutations(), 1);
  assert.equal(fx.publishMutations(), 1);
});

test('activates the new key only after persisting exact DNSKEY TTL propagation and target evidence', async () => {
  const fx = fixture({ propagationReady: true });
  await fx.runtime.init();
  const operation = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });

  assert.equal(operation.status, 'awaiting_parent_ds_addition');
  assert.equal(operation.evidence.keySetDigest, activatedDigest);
  assert.equal(operation.evidence.targetKeySetDigest, null);
  assert.equal(operation.evidence.serial, 2026091703);
  assert.equal(operation.evidence.propagation.status, 'synced');
  assert.equal(operation.evidence.propagation.dnskeyTtl, 300);
  assert.equal(operation.evidence.propagation.targetCount, 2);
  assert.deepEqual(fx.calls, [
    'preview', 'preview', 'create', 'publication-preview', 'publish', 'propagation', 'activation-preview', 'activate',
    'parent-status',
  ]);
  assert.equal(fx.publishMutations(), 1);
  assert.equal(fx.activateMutations(), 1);
});

test('waits for a clean double-DS parent state before entering old-DS retirement', async () => {
  const fx = fixture({ propagationReady: true, parentRecords: [oldDs, newDs] });
  await fx.runtime.init();
  const operation = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });

  assert.equal(operation.status, 'awaiting_parent_ds_retirement');
  assert.deepEqual(operation.evidence.parentDs, [oldDs, newDs]);
  assert.equal(fx.activateMutations(), 1);
});

test('does not accept a foreign parent DS as completed rollover addition', async () => {
  const foreignDs = '32345 13 2 11223344';
  const fx = fixture({ propagationReady: true, parentRecords: [oldDs, newDs, foreignDs] });
  await fx.runtime.init();
  const operation = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });

  assert.equal(operation.status, 'awaiting_parent_ds_addition');
  assert.deepEqual(operation.evidence.parentDs, [oldDs]);
  assert.equal(fx.activateMutations(), 1);
});

test('persists old-DS absence, waits the parent RRset TTL and deactivates the old key', async () => {
  const fx = fixture({
    propagationReady: true,
    parentRecordSequence: [[oldDs, newDs], [newDs]],
    parentCheckedAtSequence: [
      '2026-09-17T10:00:00.000Z',
      '2026-09-17T10:01:00.000Z',
      '2026-09-17T10:04:00.000Z',
      '2026-09-17T10:06:00.000Z',
    ],
  });
  await fx.runtime.init();
  const waiting = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });

  assert.equal(waiting.status, 'waiting_parent_ds_ttl');
  assert.deepEqual(waiting.evidence.parentRetirement, {
    ttl: 300,
    observedAt: '2026-09-17T10:01:00.000Z',
    eligibleAfter: '2026-09-17T10:06:00.000Z',
    checkedAt: null,
  });
  assert.notEqual(fx.calls.at(-1), 'deactivation-preview');

  const operation = await fx.runtime.run(operationId);
  assert.equal(operation.status, 'deleting_old_key');
  assert.equal(operation.evidence.keySetDigest, deactivatedDigest);
  assert.equal(operation.evidence.targetKeySetDigest, deletedDigest);
  assert.equal(operation.evidence.parentRetirement.checkedAt, '2026-09-17T10:06:00.000Z');
  assert.deepEqual(operation.evidence.parentDs, [newDs]);
  assert.deepEqual(fx.calls.slice(-4), ['deactivation-preview', 'parent-status', 'deactivate', 'deletion-preview']);
  assert.equal(fx.deactivateMutations(), 1);
});

test('resets the parent TTL gate if the old DS reappears before key deactivation', async () => {
  const fx = fixture({
    propagationReady: true,
    parentRecordSequence: [[oldDs, newDs], [newDs], [oldDs, newDs], [newDs], [newDs], [newDs]],
    parentCheckedAtSequence: [
      '2026-09-17T10:00:00.000Z',
      '2026-09-17T10:01:00.000Z',
      '2026-09-17T10:04:00.000Z',
      '2026-09-17T10:06:00.000Z',
      '2026-09-17T10:06:00.000Z',
      '2026-09-17T10:11:00.000Z',
    ],
  });
  await fx.runtime.init();
  const reset = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });

  assert.equal(reset.status, 'awaiting_parent_ds_retirement');
  assert.equal(reset.evidence.parentRetirement, null);
  assert.notEqual(fx.calls.at(-1), 'deactivation-preview');

  const restartedWait = await fx.runtime.run(operationId);
  assert.equal(restartedWait.status, 'waiting_parent_ds_ttl');
  assert.equal(restartedWait.evidence.parentRetirement.observedAt, '2026-09-17T10:06:00.000Z');
  assert.equal(restartedWait.evidence.parentRetirement.eligibleAfter, '2026-09-17T10:11:00.000Z');

  const operation = await fx.runtime.run(operationId);
  assert.equal(operation.status, 'deleting_old_key');
  assert.equal(operation.evidence.parentRetirement.checkedAt, '2026-09-17T10:11:00.000Z');
});

test('restart recovery preserves the first parent DS absence and its TTL deadline', async () => {
  const fx = fixture({
    propagationReady: true,
    parentRecordSequence: [[oldDs, newDs], [newDs], [newDs], [newDs]],
    parentCheckedAtSequence: [
      '2026-09-17T10:00:00.000Z',
      '2026-09-17T10:01:00.000Z',
      '2026-09-17T10:04:00.000Z',
      '2026-09-17T10:06:00.000Z',
    ],
  });
  await fx.runtime.init();
  const waiting = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });
  assert.equal(waiting.status, 'waiting_parent_ds_ttl');

  const restarted = createDnsZoneDnssecRolloverRuntime({ registry: fx.registry, service: fx.service });
  const recovery = await restarted.init();
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.status, 'deleting_old_key');
  assert.equal(recovery[0].operation.evidence.parentRetirement.observedAt, '2026-09-17T10:01:00.000Z');
  assert.equal(recovery[0].operation.evidence.parentRetirement.checkedAt, '2026-09-17T10:06:00.000Z');
});

test('rechecks clean parent DS evidence immediately before old-key deactivation', async () => {
  const fx = fixture({
    propagationReady: true,
    parentRecordSequence: [[oldDs, newDs], [newDs], [newDs], [newDs], [oldDs, newDs]],
    parentCheckedAtSequence: [
      '2026-09-17T10:00:00.000Z',
      '2026-09-17T10:01:00.000Z',
      '2026-09-17T10:04:00.000Z',
      '2026-09-17T10:06:00.000Z',
      '2026-09-17T10:06:01.000Z',
    ],
  });
  await fx.runtime.init();
  const waiting = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });
  assert.equal(waiting.status, 'waiting_parent_ds_ttl');

  const operation = await fx.runtime.run(operationId);
  assert.equal(operation.status, 'deactivating_old_key');
  assert.equal(operation.evidence.targetKeySetDigest, deactivatedDigest);
  assert.equal(fx.deactivateMutations(), 0);
  assert.notEqual(fx.calls.at(-1), 'deactivate');
});

test('retries an uncertain old-key deactivation without a duplicate mutation', async () => {
  const fx = fixture({
    propagationReady: true,
    failDeactivateAfterMutation: true,
    parentRecordSequence: [[oldDs, newDs], [newDs]],
    parentCheckedAtSequence: [
      '2026-09-17T10:00:00.000Z',
      '2026-09-17T10:01:00.000Z',
      '2026-09-17T10:04:00.000Z',
      '2026-09-17T10:06:00.000Z',
    ],
  });
  await fx.runtime.init();
  const waiting = await fx.runtime.start({
    domainId,
    previewDigest: fx.preview.previewDigest,
    confirmation: fx.preview.confirmation,
  });
  assert.equal(waiting.status, 'waiting_parent_ds_ttl');

  await assert.rejects(fx.runtime.run(operationId), /connection reset after deactivate/);
  const interrupted = await fx.registry.get(operationId);
  assert.equal(interrupted.status, 'deactivating_old_key');
  assert.equal(interrupted.evidence.keySetDigest, activatedDigest);
  assert.equal(interrupted.evidence.targetKeySetDigest, deactivatedDigest);

  const recovered = await fx.runtime.run(operationId);
  assert.equal(recovered.status, 'deleting_old_key');
  assert.equal(recovered.evidence.keySetDigest, deactivatedDigest);
  assert.equal(recovered.evidence.targetKeySetDigest, deletedDigest);
  assert.equal(fx.deactivateMutations(), 1);
});

test('retries an uncertain activation from persisted target digest without duplicate mutation', async () => {
  const fx = fixture({ propagationReady: true, failActivateAfterMutation: true });
  await fx.runtime.init();
  await assert.rejects(
    fx.runtime.start({ domainId, previewDigest: fx.preview.previewDigest, confirmation: fx.preview.confirmation }),
    /connection reset after activate/,
  );
  const interrupted = await fx.registry.get(operationId);
  assert.equal(interrupted.status, 'activating_key');
  assert.equal(interrupted.evidence.keySetDigest, publishedDigest);
  assert.equal(interrupted.evidence.targetKeySetDigest, activatedDigest);

  const recovered = await fx.runtime.run(operationId);
  assert.equal(recovered.status, 'awaiting_parent_ds_addition');
  assert.equal(recovered.evidence.keySetDigest, activatedDigest);
  assert.equal(fx.activateMutations(), 1);
});

test('rejects malformed start confirmation before journaling or host mutation', async () => {
  const fx = fixture();
  await fx.runtime.init();
  await assert.rejects(
    fx.runtime.start({ domainId, previewDigest: 'invalid', confirmation: 'wrong' }),
    (error) => error instanceof DnsZoneDnssecRolloverRuntimeError
      && error.code === 'dnssec_rollover_confirmation_invalid',
  );
  assert.deepEqual(await fx.registry.listForDomain(domainId), []);
});
