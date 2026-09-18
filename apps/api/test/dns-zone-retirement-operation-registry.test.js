import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDnsZoneRetirementOperationRegistry,
  dnsZoneRetirementOperationPublicView,
  DnsZoneRetirementOperationRegistryError,
} from '../src/dns-zone-retirement-operation-registry.js';
import { powerDnsZoneManagerInternals } from '@yunpanel/host-runtime/powerdns-zone-manager';

const operationId = '12345678-1234-4234-8234-123456789012';
const domainId = '22345678-1234-4234-8234-123456789012';
const serverId = '32345678-1234-4234-8234-123456789012';

function snapshot(content = '203.0.113.10') {
  return powerDnsZoneManagerInternals.zoneSnapshot({
    zoneName: 'example.com',
    id: 'example.com.',
    kind: 'Primary',
    dnssec: false,
    rrsets: [{
      name: 'example.com.',
      type: 'A',
      ttl: 300,
      records: [{ content, disabled: false }],
      comments: [],
    }],
  });
}

function capture(overrides = {}) {
  const retained = overrides.snapshot ?? snapshot();
  const snapshotDigest = powerDnsZoneManagerInternals.zoneSnapshotDigest(retained);
  return {
    version: 1,
    domainId,
    serverId,
    zoneName: 'example.com',
    domainRevision: 4,
    previewDigest: 'a'.repeat(64),
    snapshotDigest,
    ownershipEvidenceDigest: 'b'.repeat(64),
    snapshotRetentionDays: 30,
    snapshot: retained,
    confirmation: `retire-authoritative-zone:${domainId}:4:${snapshotDigest}:${'b'.repeat(64)}:30:${'a'.repeat(64)}`,
    ...overrides,
  };
}

test('retirement journal persists private snapshot while public operation redacts snapshot and confirmation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dns-retirement-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const registry = createDnsZoneRetirementOperationRegistry({
    filePath,
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => operationId,
  });
  await registry.init();
  const created = await registry.create(capture());

  assert.equal(created.status, 'pending');
  assert.equal(created.snapshot.rrsets[0].records[0].content, '203.0.113.10');
  const publicView = dnsZoneRetirementOperationPublicView(created);
  assert.equal(publicView.snapshotDigest, created.snapshotDigest);
  assert.equal(Object.hasOwn(publicView, 'snapshot'), false);
  assert.equal(Object.hasOwn(publicView, 'confirmation'), false);
  assert.equal(JSON.stringify(publicView).includes('203.0.113.10'), false);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);

  const disk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(disk.version, 1);
  assert.equal(disk.operations[0].snapshot.rrsets[0].records[0].content, '203.0.113.10');
});

test('retirement lifecycle keeps monotonic revisions and computes retained snapshot deadline after deletion', async () => {
  let clock = Date.parse('2026-09-18T16:00:00.000Z');
  const registry = createDnsZoneRetirementOperationRegistry({
    now: () => clock,
    idFactory: () => operationId,
  });
  await registry.init();
  const created = await registry.create(capture());
  const deleting = await registry.markDeleting(created.id);
  assert.equal(deleting.status, 'deleting');
  assert.equal(Date.parse(deleting.updatedAt) > Date.parse(created.updatedAt), true);
  assert.deepEqual((await registry.listInterrupted()).map((operation) => operation.id), [operationId]);

  clock += 1000;
  const deleted = await registry.succeed(operationId, {
    changed: true,
    snapshotDigest: created.snapshotDigest,
  });
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.result.deleted, true);
  assert.equal(deleted.result.changed, true);
  assert.equal(deleted.result.snapshotDigest, created.snapshotDigest);
  assert.equal(
    Date.parse(deleted.result.retainUntil) - Date.parse(deleted.result.deletedAt),
    30 * 24 * 60 * 60 * 1000,
  );
  assert.deepEqual(await registry.listInterrupted(), []);
  assert.equal(dnsZoneRetirementOperationPublicView(deleted).recovery.required, false);
});

test('interrupted deleting state survives restart without being silently completed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dns-retirement-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  let clock = Date.parse('2026-09-18T16:00:00.000Z');
  const registry = createDnsZoneRetirementOperationRegistry({
    filePath,
    now: () => clock,
    idFactory: () => operationId,
  });
  await registry.init();
  const created = await registry.create(capture());
  clock += 1000;
  await registry.markDeleting(created.id);

  const restarted = createDnsZoneRetirementOperationRegistry({ filePath, now: () => clock });
  await restarted.init();
  const interrupted = await restarted.listInterrupted();
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].status, 'deleting');
  const publicView = dnsZoneRetirementOperationPublicView(interrupted[0]);
  assert.equal(publicView.recovery.required, true);
  assert.equal(publicView.recovery.automaticReplayBlocked, true);
});

test('failed retirement can re-enter deleting only explicitly and clears stale failure evidence', async () => {
  const registry = createDnsZoneRetirementOperationRegistry({
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => operationId,
  });
  await registry.init();
  const created = await registry.create(capture());
  await registry.markDeleting(created.id);
  const failed = await registry.fail(created.id, {
    code: 'powerdns_zone_api_unavailable',
    message: 'PowerDNS zone API is unavailable',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'powerdns_zone_api_unavailable');

  const retried = await registry.markDeleting(created.id);
  assert.equal(retried.status, 'deleting');
  assert.equal(retried.error, null);
});

test('retirement journal rejects snapshot digest mismatch and tampered persisted snapshots', async (t) => {
  const registry = createDnsZoneRetirementOperationRegistry({
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => operationId,
  });
  await registry.init();
  await assert.rejects(
    registry.create(capture({ snapshotDigest: 'f'.repeat(64) })),
    (error) => error instanceof DnsZoneRetirementOperationRegistryError
      && error.code === 'dns_zone_retirement_operation_state_invalid',
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dns-retirement-tamper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const valid = createDnsZoneRetirementOperationRegistry({
    filePath,
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => operationId,
  });
  await valid.init();
  await valid.create(capture());
  const disk = JSON.parse(await readFile(filePath, 'utf8'));
  disk.operations[0].snapshot.rrsets[0].records[0].content = '198.51.100.99';
  await writeFile(filePath, JSON.stringify(disk));

  const restarted = createDnsZoneRetirementOperationRegistry({ filePath });
  await assert.rejects(
    restarted.init(),
    (error) => error instanceof DnsZoneRetirementOperationRegistryError
      && error.code === 'dns_zone_retirement_operation_state_invalid',
  );
});
