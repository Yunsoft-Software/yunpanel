import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWebsiteRestoreReceiptStore,
  WebsiteRestoreReceiptError,
  websiteRestoreReceiptInternals,
} from '../src/website-restore-receipt.js';

const websiteId = '2c387b02-8747-458a-b509-8f531d4d149e';
const repositoryId = '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c';
const snapshotId = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const preRestoreSnapshotId = '9z8y7x6w5v4u3t2s1r0q9p8o7n6m5l4k';
const previewDigest = 'a'.repeat(64);
const transactionId = `restore:${websiteId}:${previewDigest.slice(0, 16)}`;

test('website-restore-receipt writes and reads receipt with 0600 mode', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = createWebsiteRestoreReceiptStore({ root });

  const record = {
    transactionId,
    websiteId,
    websiteRevision: 2,
    repositoryId,
    snapshotId,
    preRestoreSnapshotId,
    status: 'pre_restore_created',
    previewDigest,
  };

  const written = await store.write(record);
  assert.equal(written.transactionId, transactionId);
  assert.equal(written.status, 'pre_restore_created');
  assert.equal(written.websiteRevision, 2);

  const read = await store.read(transactionId);
  assert.deepEqual(read, written);

  // Updating to succeeded
  const updated = await store.write({
    ...record,
    status: 'succeeded',
    healthCheck: { satisfied: true, statusCode: 200, attempts: 1 },
  });
  assert.equal(updated.status, 'succeeded');
  assert.equal(updated.healthCheck.satisfied, true);

  const readUpdated = await store.read(transactionId);
  assert.deepEqual(readUpdated, updated);
});

test('website-restore-receipt enforces idempotency on equivalent write', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = createWebsiteRestoreReceiptStore({ root });

  const record = {
    transactionId,
    websiteId,
    websiteRevision: 1,
    repositoryId,
    snapshotId,
    preRestoreSnapshotId,
    status: 'succeeded',
    healthCheck: { satisfied: true, statusCode: 200, attempts: 1 },
    previewDigest,
  };

  const first = await store.write(record);
  const second = await store.write(record);
  assert.equal(first.committedAt, second.committedAt);
});

test('website-restore-receipt detects conflict on divergent receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = createWebsiteRestoreReceiptStore({ root });

  const record = {
    transactionId,
    websiteId,
    websiteRevision: 1,
    repositoryId,
    snapshotId,
    preRestoreSnapshotId,
    status: 'succeeded',
    previewDigest,
  };

  await store.write(record);

  await assert.rejects(
    () => store.write({
      ...record,
      snapshotId: 'different_snapshot_id_123',
    }),
    (err) => err instanceof WebsiteRestoreReceiptError && err.code === 'website_restore_receipt_conflict',
  );
});
