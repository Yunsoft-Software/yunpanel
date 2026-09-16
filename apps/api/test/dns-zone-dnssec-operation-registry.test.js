import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDnsZoneDnssecOperationRegistry,
  dnsZoneDnssecOperationPublicView,
  DnsZoneDnssecOperationRegistryError,
} from '../src/dns-zone-dnssec-operation-registry.js';

const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const operationId = 'f59889d5-a6b2-4aca-976b-8ff745f92f13';

function preview(enabled = true) {
  const previewDigest = 'a'.repeat(64);
  return {
    applyAllowed: true,
    noChanges: false,
    domainId,
    serverId,
    zoneName: 'example.com',
    targetEnabled: enabled,
    previewDigest,
    confirmation: `${enabled ? 'enable' : 'disable'}-dnssec:${domainId}:${previewDigest}`,
  };
}

function result(enabled = true) {
  return {
    zoneName: 'example.com',
    dnssec: enabled,
    status: enabled ? 'pending_parent_ds' : 'insecure',
    secureReady: false,
    serial: 2026091601,
    ds: enabled ? ['12345 13 2 AABBCCDD'] : [],
    parentStatus: 'absent',
    parentRecords: [],
    parentMatchingRecords: [],
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dnssec-operation-'));
  const filePath = path.join(root, 'operations.json');
  const registry = createDnsZoneDnssecOperationRegistry({
    filePath,
    now: () => Date.parse('2026-09-16T00:40:00.000Z'),
    idFactory: () => operationId,
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await registry.init();
  return { filePath, registry };
}

test('DNSSEC operation journal persists private confirmation but hides it from public state', async (t) => {
  const { filePath, registry } = await fixture(t);
  const created = await registry.create(preview(true));
  const publicView = dnsZoneDnssecOperationPublicView(created);

  assert.equal(created.status, 'pending');
  assert.equal(created.confirmation.startsWith('enable-dnssec:'), true);
  assert.equal(Object.hasOwn(publicView, 'confirmation'), false);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.operations[0].confirmation, created.confirmation);
});

test('DNSSEC operation journal transitions applying to succeeded with bounded public evidence', async (t) => {
  const { registry } = await fixture(t);
  const created = await registry.create(preview(true));
  const applying = await registry.markApplying(created.id);
  assert.equal(applying.status, 'applying');

  const succeeded = await registry.succeed(created.id, result(true));
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.result.dnssec, true);
  assert.deepEqual(succeeded.result.ds, ['12345 13 2 AABBCCDD']);
  assert.equal((await registry.listInterrupted()).length, 0);
});

test('DNSSEC operation journal keeps interrupted applying operations discoverable after restart', async (t) => {
  const { filePath, registry } = await fixture(t);
  const created = await registry.create(preview(false));
  await registry.markApplying(created.id);

  const reopened = createDnsZoneDnssecOperationRegistry({ filePath });
  await reopened.init();
  const interrupted = await reopened.listInterrupted();
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].id, created.id);
  assert.equal(interrupted[0].targetEnabled, false);
});

test('DNSSEC operation journal rejects malformed terminal evidence', async (t) => {
  const { registry } = await fixture(t);
  const created = await registry.create(preview(true));
  await registry.markApplying(created.id);

  await assert.rejects(
    registry.succeed(created.id, { ...result(true), parentStatus: 'maybe' }),
    (error) => error instanceof DnsZoneDnssecOperationRegistryError && error.code === 'dnssec_operation_state_invalid',
  );
});
