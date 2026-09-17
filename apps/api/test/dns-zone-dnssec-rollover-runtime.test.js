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

function publicKey({ published = false } = {}) {
  return Object.freeze({
    id: 8,
    keyType: 'csk',
    active: false,
    published,
    dnskey: '257 3 13 AAAANEWKEY',
    ds: Object.freeze([newDs]),
    cds: Object.freeze([newDs]),
    algorithm: 'ECDSAP256SHA256',
    bits: 256,
  });
}

function fixture({ failCreateAfterMutation = false, failPublishAfterMutation = false, staleSecondPreview = false } = {}) {
  const registry = createDnsZoneDnssecRolloverRegistry({ idFactory: () => operationId });
  const calls = [];
  let created = false;
  let published = false;
  let createFailurePending = failCreateAfterMutation;
  let publishFailurePending = failPublishAfterMutation;
  let createMutations = 0;
  let publishMutations = 0;
  let previewCalls = 0;
  const preview = rolloverPreview();
  const service = {
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
      calls.push('publication-preview');
      assert.equal(input.keyId, 8);
      return Object.freeze({
        keySetDigest: published ? publishedDigest : createdDigest,
        targetKeySetDigest: publishedDigest,
        targetKey: publicKey({ published: true }),
      });
    },
    setRolloverKeyState: async (input) => {
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
  };
  const runtime = createDnsZoneDnssecRolloverRuntime({ registry, service });
  return {
    calls,
    registry,
    runtime,
    preview,
    createMutations: () => createMutations,
    publishMutations: () => publishMutations,
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
  assert.deepEqual(fx.calls, ['preview', 'preview', 'create', 'publication-preview', 'publish']);
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
