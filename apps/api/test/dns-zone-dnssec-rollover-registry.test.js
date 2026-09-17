import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDnsZoneDnssecRolloverRegistry,
  dnsZoneDnssecRolloverPublicView,
  DnsZoneDnssecRolloverRegistryError,
} from '../src/dns-zone-dnssec-rollover-registry.js';

const operationId = '6b11545e-e9cf-4227-b525-21c986d7e3f4';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const oldDs = '12345 13 2 AABBCCDD';
const newDs = '22345 13 2 EEFF0011';
const initialDigest = 'a'.repeat(64);

function preview() {
  const previewDigest = 'b'.repeat(64);
  return Object.freeze({
    version: 1,
    action: 'dnssec_key_rollover',
    domainId,
    serverId,
    zoneName: 'example.com',
    expectedKeySetDigest: initialDigest,
    expectedKeyIds: Object.freeze([7]),
    oldKey: Object.freeze({
      id: 7,
      keyType: 'csk',
      algorithm: 'ECDSAP256SHA256',
      bits: 256,
      ds: Object.freeze([oldDs]),
    }),
    newKey: Object.freeze({
      keyType: 'csk',
      algorithm: 'ECDSAP256SHA256',
      bits: 256,
      active: false,
      published: false,
    }),
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
    previewDigest,
    confirmation: `rollover-dnssec:${domainId}:${previewDigest}`,
    impact: Object.freeze({}),
  });
}

function evidence({
  newKeyId = null,
  keySetDigest = initialDigest,
  targetKeySetDigest = null,
  newKeyDs = [],
  serial = null,
  parentDs = [oldDs],
  propagation = null,
} = {}) {
  return Object.freeze({ newKeyId, keySetDigest, targetKeySetDigest, newKeyDs, serial, parentDs, propagation });
}

test('persists a private monotonic DNSSEC rollover journal without confirmation in public view', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dnssec-rollover-'));
  const filePath = path.join(directory, 'operations.json');
  let clock = Date.parse('2026-09-17T10:00:00.000Z');
  const registry = createDnsZoneDnssecRolloverRegistry({
    filePath,
    now: () => clock,
    idFactory: () => operationId,
  });
  await registry.init();
  const created = await registry.create(preview());

  assert.equal(created.status, 'pending');
  assert.equal(created.evidence.keySetDigest, initialDigest);
  assert.equal(created.evidence.newKeyId, null);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const publicView = dnsZoneDnssecRolloverPublicView(created);
  assert.equal(Object.hasOwn(publicView, 'confirmation'), false);
  assert.equal(JSON.stringify(publicView).includes('rollover-dnssec:'), false);

  clock += 1_000;
  await registry.advance(operationId, 'creating_key', evidence());
  const createdKeyEvidence = evidence({
    newKeyId: 8,
    keySetDigest: 'c'.repeat(64),
    targetKeySetDigest: 'd'.repeat(64),
    newKeyDs: [newDs],
    serial: 2026091701,
  });
  const publishing = await registry.advance(operationId, 'publishing_key', createdKeyEvidence);
  assert.equal(publishing.status, 'publishing_key');
  assert.equal(publishing.evidence.newKeyId, 8);

  const reopened = createDnsZoneDnssecRolloverRegistry({ filePath });
  await reopened.init();
  assert.equal((await reopened.get(operationId)).status, 'publishing_key');
  assert.deepEqual((await reopened.listActive()).map((entry) => entry.id), [operationId]);
});

test('allows only the exact next rollover stage and makes same-stage evidence idempotent', async () => {
  const registry = createDnsZoneDnssecRolloverRegistry({ idFactory: () => operationId });
  await registry.init();
  await registry.create(preview());
  const creating = await registry.advance(operationId, 'creating_key', evidence());
  const retried = await registry.advance(operationId, 'creating_key', evidence());
  assert.equal(retried, creating);

  await assert.rejects(
    registry.advance(operationId, 'verifying_dnskey_propagation', evidence()),
    (error) => error instanceof DnsZoneDnssecRolloverRegistryError && error.code === 'dnssec_rollover_transition_invalid',
  );
  await assert.rejects(
    registry.advance(operationId, 'creating_key', evidence({ keySetDigest: 'd'.repeat(64) })),
    (error) => error instanceof DnsZoneDnssecRolloverRegistryError && error.code === 'dnssec_rollover_evidence_conflict',
  );
});

test('requires new key and propagation evidence before later destructive stages', async () => {
  const registry = createDnsZoneDnssecRolloverRegistry({ idFactory: () => operationId });
  await registry.init();
  await registry.create(preview());
  await registry.advance(operationId, 'creating_key', evidence());

  await assert.rejects(
    registry.advance(operationId, 'publishing_key', evidence()),
    (error) => error instanceof DnsZoneDnssecRolloverRegistryError
      && error.code === 'dnssec_rollover_operation_state_invalid',
  );

  const withNewKey = evidence({
    newKeyId: 8,
    keySetDigest: 'c'.repeat(64),
    targetKeySetDigest: 'd'.repeat(64),
    newKeyDs: [newDs],
    serial: 2026091701,
  });
  await registry.advance(operationId, 'publishing_key', withNewKey);
  await registry.advance(operationId, 'verifying_dnskey_propagation', {
    ...withNewKey,
    keySetDigest: 'd'.repeat(64),
    targetKeySetDigest: null,
  });
  await assert.rejects(
    registry.advance(operationId, 'activating_key', {
      ...withNewKey,
      keySetDigest: 'd'.repeat(64),
      targetKeySetDigest: 'e'.repeat(64),
    }),
    (error) => error instanceof DnsZoneDnssecRolloverRegistryError
      && error.code === 'dnssec_rollover_operation_state_invalid',
  );
});

test('completes only after old-key deletion stage with exact public result evidence', async () => {
  const registry = createDnsZoneDnssecRolloverRegistry({ idFactory: () => operationId });
  await registry.init();
  await registry.create(preview());
  await registry.advance(operationId, 'creating_key', evidence());
  let current = evidence({
    newKeyId: 8,
    keySetDigest: 'c'.repeat(64),
    targetKeySetDigest: 'd'.repeat(64),
    newKeyDs: [newDs],
    serial: 2026091701,
  });
  await registry.advance(operationId, 'publishing_key', current);
  current = { ...current, keySetDigest: 'd'.repeat(64), targetKeySetDigest: null };
  await registry.advance(operationId, 'verifying_dnskey_propagation', current);
  current = {
    ...current,
    targetKeySetDigest: 'e'.repeat(64),
    serial: 2026091702,
    propagation: {
      status: 'synced',
      serial: 2026091702,
      dnskeyTtl: 300,
      publishedAt: '2026-09-17T10:00:00.000Z',
      eligibleAfter: '2026-09-17T10:05:00.000Z',
      checkedAt: '2026-09-17T10:05:00.000Z',
      targetCount: 2,
    },
  };
  await registry.advance(operationId, 'activating_key', current);
  current = { ...current, keySetDigest: 'e'.repeat(64), targetKeySetDigest: null, serial: 2026091702 };
  await registry.advance(operationId, 'awaiting_parent_ds_addition', current);
  current = { ...current, parentDs: [oldDs, newDs] };
  await registry.advance(operationId, 'awaiting_parent_ds_retirement', current);
  current = { ...current, parentDs: [newDs], targetKeySetDigest: 'f'.repeat(64) };
  await registry.advance(operationId, 'deactivating_old_key', current);
  current = { ...current, keySetDigest: 'f'.repeat(64), targetKeySetDigest: '1'.repeat(64) };
  await registry.advance(operationId, 'deleting_old_key', current);

  const completed = await registry.succeed(operationId, {
    oldKeyId: 7,
    newKeyId: 8,
    keySetDigest: '1'.repeat(64),
    serial: 2026091703,
    parentDs: [newDs],
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.newKeyId, 8);
  assert.deepEqual(await registry.listActive(), []);

  await assert.rejects(
    registry.fail(operationId, { code: 'too_late', message: 'too late' }),
    (error) => error instanceof DnsZoneDnssecRolloverRegistryError && error.code === 'dnssec_rollover_transition_invalid',
  );
});

test('rejects forged preview identity and malformed persisted state without echoing private content', async () => {
  const registry = createDnsZoneDnssecRolloverRegistry({ idFactory: () => operationId });
  await registry.init();
  await assert.rejects(
    registry.create({ ...preview(), newKey: { ...preview().newKey, privatekey: 'SECRET' } }),
    (error) => error instanceof DnsZoneDnssecRolloverRegistryError
      && error.code === 'dnssec_rollover_operation_state_invalid'
      && !error.message.includes('SECRET'),
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dnssec-rollover-invalid-'));
  const filePath = path.join(directory, 'operations.json');
  await writeFile(filePath, JSON.stringify({ version: 1, operations: [{ privatekey: 'SECRET' }] }), { mode: 0o600 });
  const corrupted = createDnsZoneDnssecRolloverRegistry({ filePath });
  await assert.rejects(
    corrupted.init(),
    (error) => error instanceof DnsZoneDnssecRolloverRegistryError
      && error.code === 'dnssec_rollover_operation_state_invalid'
      && !error.message.includes('SECRET'),
  );
  assert.equal((await readFile(filePath, 'utf8')).includes('SECRET'), true);
});

test('migrates a safe version-one pending journal and rewrites the store as version three', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dnssec-rollover-v1-'));
  const filePath = path.join(directory, 'operations.json');
  const writer = createDnsZoneDnssecRolloverRegistry({ filePath, idFactory: () => operationId });
  await writer.init();
  await writer.create(preview());
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  stored.version = 1;
  delete stored.operations[0].evidence.targetKeySetDigest;
  await writeFile(filePath, JSON.stringify(stored), { mode: 0o600 });

  const migrated = createDnsZoneDnssecRolloverRegistry({ filePath });
  await migrated.init();
  assert.equal((await migrated.get(operationId)).evidence.targetKeySetDigest, null);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 3);
});

test('fails closed instead of inventing TTL evidence for a progressed version-two journal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dnssec-rollover-v2-'));
  const filePath = path.join(directory, 'operations.json');
  const writer = createDnsZoneDnssecRolloverRegistry({ filePath, idFactory: () => operationId });
  await writer.init();
  await writer.create(preview());
  await writer.advance(operationId, 'creating_key', evidence());
  const publishing = evidence({
    newKeyId: 8,
    keySetDigest: 'c'.repeat(64),
    targetKeySetDigest: 'd'.repeat(64),
    newKeyDs: [newDs],
    serial: 2026091701,
  });
  await writer.advance(operationId, 'publishing_key', publishing);
  await writer.advance(operationId, 'verifying_dnskey_propagation', {
    ...publishing,
    keySetDigest: 'd'.repeat(64),
    targetKeySetDigest: null,
  });
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  stored.version = 2;
  stored.operations[0].status = 'activating_key';
  stored.operations[0].evidence.targetKeySetDigest = 'e'.repeat(64);
  stored.operations[0].evidence.propagation = {
    status: 'synced',
    serial: 2026091701,
    checkedAt: '2026-09-17T10:05:00.000Z',
  };
  await writeFile(filePath, JSON.stringify(stored), { mode: 0o600 });

  const migrated = createDnsZoneDnssecRolloverRegistry({ filePath });
  await assert.rejects(
    migrated.init(),
    (error) => error instanceof DnsZoneDnssecRolloverRegistryError
      && error.code === 'dnssec_rollover_operation_state_invalid'
      && /cannot be safely migrated/.test(error.message),
  );
});
