import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDnsZoneReapplyOperationRegistry,
  dnsZoneReapplyOperationPublicView,
  DnsZoneReapplyOperationRegistryError,
} from '../src/dns-zone-reapply-operation-registry.js';

const operationId = 'f77d9d70-3f77-4be9-b257-0ade06401fb7';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const previewDigest = 'a'.repeat(64);
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

function preview() {
  return Object.freeze({
    applyAllowed: true,
    noChanges: false,
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
    previewDigest,
    confirmation: `reapply-dns-zone-template:${domainId}:${previewDigest}`,
  });
}

function registry() {
  return createDnsZoneReapplyOperationRegistry({
    now: () => Date.parse('2026-09-16T00:00:00.000Z'),
    idFactory: () => operationId,
  });
}

test('DNS zone reapply journal deduplicates an identical active preview and hides confirmation publicly', async () => {
  const store = registry();
  await store.init();
  const first = await store.create(preview(), rollbackEvidence());
  const second = await store.create(preview(), rollbackEvidence());

  assert.equal(first.id, operationId);
  assert.equal(second.id, operationId);
  assert.equal((await store.listForDomain(domainId)).length, 1);
  const publicView = dnsZoneReapplyOperationPublicView(first);
  assert.equal(publicView.status, 'pending');
  assert.equal(publicView.targetSerial, 2026091601);
  assert.equal(first.sourceZoneDigest, sourceZoneDigest);
  assert.equal(Object.hasOwn(publicView, 'sourceZoneDigest'), false);
  assert.equal(Object.hasOwn(publicView, 'confirmation'), false);
  assert.equal(JSON.stringify(publicView).includes('reapply-dns-zone-template:'), false);
});

test('DNS zone reapply journal persists applying and succeeded evidence transitions', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(preview(), rollbackEvidence());
  const applying = await store.markApplying(created.id);

  assert.equal(applying.status, 'applying');
  assert.deepEqual((await store.listInterrupted()).map((entry) => entry.id), [created.id]);

  const succeeded = await store.succeed(created.id, {
    satisfied: true,
    zoneName: 'example.com',
    serial: 2026091601,
    changedRrsetCount: 3,
    manualRrsetCount: 1,
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.result.serial, 2026091601);
  assert.deepEqual(await store.listInterrupted(), []);
});

test('DNS zone reapply journal keeps only sanitized failure evidence', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(preview(), rollbackEvidence());
  await store.markApplying(created.id);
  const failed = await store.fail(created.id, {
    code: 'powerdns_zone_api_failed',
    message: 'PowerDNS zone API request failed with status 503',
  });

  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, {
    code: 'powerdns_zone_api_failed',
    message: 'PowerDNS zone API request failed with status 503',
  });
  assert.equal(failed.result, null);
});

test('DNS zone reapply journal rejects blocked previews and invalid terminal evidence', async () => {
  const store = registry();
  await store.init();
  await assert.rejects(
    store.create({ ...preview(), applyAllowed: false, confirmation: null }),
    (error) => error instanceof DnsZoneReapplyOperationRegistryError
      && error.code === 'dns_zone_reapply_operation_preview_invalid',
  );

  const created = await store.create(preview(), rollbackEvidence());
  await store.markApplying(created.id);
  await assert.rejects(
    store.succeed(created.id, {
      satisfied: true,
      zoneName: 'example.com',
      serial: 0,
      changedRrsetCount: 1,
      manualRrsetCount: 0,
    }),
    (error) => error instanceof DnsZoneReapplyOperationRegistryError
      && error.code === 'dns_zone_reapply_operation_state_invalid',
  );
});

test('version 1 operation journals migrate without claiming mail desired-state evidence', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-dns-reapply-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const legacy = {
    version: 1,
    operations: [{
      id: operationId,
      domainId,
      serverId,
      zoneName: 'example.com',
      domainRevision: 3,
      templateVersion: 4,
      dnsIdentityRevision: 2,
      observedSerial: 2026091501,
      targetSerial: 2026091601,
      previewDigest,
      confirmation: `reapply-dns-zone-template:${domainId}:${previewDigest}`,
      status: 'applying',
      result: null,
      error: null,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    }],
  };
  await writeFile(filePath, `${JSON.stringify(legacy)}\n`);

  const store = createDnsZoneReapplyOperationRegistry({ filePath });
  await store.init();
  assert.equal((await store.get(operationId)).mailStateDigest, null);
  assert.equal((await store.get(operationId)).sourceZoneDigest, null);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.version, 5);
  assert.equal(persisted.operations[0].mailStateDigest, null);
  assert.equal(persisted.operations[0].sourceZoneDigest, null);
  assert.equal(persisted.operations[0].sourceZoneSnapshot, null);
  assert.equal(persisted.operations[0].appliedZoneDigest, null);
  assert.equal(persisted.operations[0].appliedZoneSnapshot, null);
});


test('version 2 operation journals migrate without inventing exact source-zone evidence', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-dns-reapply-v2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const previous = {
    version: 2,
    operations: [{
      id: operationId,
      domainId,
      serverId,
      zoneName: 'example.com',
      domainRevision: 3,
      templateVersion: 4,
      dnsIdentityRevision: 2,
      mailStateDigest: 'c'.repeat(64),
      observedSerial: 2026091501,
      targetSerial: 2026091601,
      previewDigest,
      confirmation: `reapply-dns-zone-template:${domainId}:${previewDigest}`,
      status: 'applying',
      result: null,
      error: null,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    }],
  };
  await writeFile(filePath, `${JSON.stringify(previous)}\n`);

  const store = createDnsZoneReapplyOperationRegistry({ filePath });
  await store.init();
  const migrated = await store.get(operationId);
  assert.equal(migrated.mailStateDigest, 'c'.repeat(64));
  assert.equal(migrated.sourceZoneDigest, null);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.version, 5);
  assert.equal(persisted.operations[0].sourceZoneDigest, null);
  assert.equal(persisted.operations[0].sourceZoneSnapshot, null);
  assert.equal(persisted.operations[0].appliedZoneDigest, null);
  assert.equal(persisted.operations[0].appliedZoneSnapshot, null);
});


test('version 3 operation journals keep source digest but do not invent rollback snapshot evidence', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-dns-reapply-v3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const previous = {
    version: 3,
    operations: [{
      id: operationId,
      domainId,
      serverId,
      zoneName: 'example.com',
      domainRevision: 3,
      templateVersion: 4,
      dnsIdentityRevision: 2,
      mailStateDigest: 'c'.repeat(64),
      sourceZoneDigest,
      observedSerial: 2026091501,
      targetSerial: 2026091601,
      previewDigest,
      confirmation: `reapply-dns-zone-template:${domainId}:${previewDigest}`,
      status: 'applying',
      result: null,
      error: null,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    }],
  };
  await writeFile(filePath, `${JSON.stringify(previous)}\n`);

  const store = createDnsZoneReapplyOperationRegistry({ filePath });
  await store.init();
  const migrated = await store.get(operationId);
  assert.equal(migrated.sourceZoneDigest, sourceZoneDigest);
  assert.equal(migrated.sourceZoneSnapshot, null);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.version, 5);
  assert.equal(persisted.operations[0].sourceZoneSnapshot, null);
});


test('version 4 operation journals keep source snapshot but do not invent expected after-state', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-dns-reapply-v4-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const previous = {
    version: 4,
    operations: [{
      id: operationId,
      domainId,
      serverId,
      zoneName: 'example.com',
      domainRevision: 3,
      templateVersion: 4,
      dnsIdentityRevision: 2,
      mailStateDigest: 'c'.repeat(64),
      sourceZoneDigest,
      sourceZoneSnapshot,
      observedSerial: 2026091501,
      targetSerial: 2026091601,
      previewDigest,
      confirmation: `reapply-dns-zone-template:${domainId}:${previewDigest}`,
      status: 'applying',
      result: null,
      error: null,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    }],
  };
  await writeFile(filePath, `${JSON.stringify(previous)}\n`);

  const store = createDnsZoneReapplyOperationRegistry({ filePath });
  await store.init();
  const migrated = await store.get(operationId);
  assert.equal(migrated.sourceZoneDigest, sourceZoneDigest);
  assert.deepEqual(migrated.sourceZoneSnapshot, sourceZoneSnapshot);
  assert.equal(migrated.appliedZoneDigest, null);
  assert.equal(migrated.appliedZoneSnapshot, null);
  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.version, 5);
});


test('DNS zone reapply journal persists rollback lifecycle with monotonic revisions', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(preview(), rollbackEvidence());
  const applying = await store.markApplying(created.id);
  const succeeded = await store.succeed(created.id, {
    satisfied: true,
    zoneName: 'example.com',
    serial: 2026091601,
    changedRrsetCount: 3,
    manualRrsetCount: 1,
  });
  const rollingBack = await store.markRollingBack(created.id);

  assert.equal(rollingBack.status, 'rolling_back');
  assert.equal(Date.parse(applying.updatedAt) > Date.parse(created.updatedAt), true);
  assert.equal(Date.parse(succeeded.updatedAt) > Date.parse(applying.updatedAt), true);
  assert.equal(Date.parse(rollingBack.updatedAt) > Date.parse(succeeded.updatedAt), true);
  assert.deepEqual((await store.listInterruptedRollbacks()).map((entry) => entry.id), [created.id]);

  const rolledBack = await store.succeedRollback(created.id, {
    satisfied: true,
    zoneName: 'example.com',
    restoredRrsetCount: 2,
    kindRestored: true,
    sourceZoneDigest,
  });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.rollbackResult.sourceZoneDigest, sourceZoneDigest);
  assert.deepEqual(await store.listInterruptedRollbacks(), []);

  const publicView = dnsZoneReapplyOperationPublicView(rolledBack);
  assert.equal(publicView.rollback.status, 'succeeded');
  assert.equal(publicView.rollback.available, false);
  assert.equal(Object.hasOwn(publicView, 'sourceZoneSnapshot'), false);
  assert.equal(JSON.stringify(publicView).includes('managed source snapshot'), false);
});
