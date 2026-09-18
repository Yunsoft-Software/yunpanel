import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabaseDeletionReceiptStore } from '../src/database-deletion-receipt.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const databaseName = 'app_db';
const websiteId = '22345678-1234-4234-8234-123456789012';
const databaseBindingId = '32345678-1234-4234-8234-123456789012';
const backupId = '42345678-1234-4234-8234-123456789012';
const ownership = Object.freeze({
  websiteId,
  databaseBindingId,
  expectedBindingRevision: 7,
  backupId,
  expectedBackupSha256: 'a'.repeat(64),
});
const result = {
  engine: 'mariadb',
  version: '11.4.5-MariaDB',
  database: { name: databaseName, sizeBytes: 4096 },
  deleted: true,
};

async function withTemp(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-delete-receipt-'));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function mode(value) {
  return value.mode & 0o777;
}

test('database deletion receipt roundtrips safe metadata with private modes', async () => {
  await withTemp(async (parent) => {
    const root = path.join(parent, 'receipts');
    await mkdir(root, { mode: 0o755 });
    const store = createDatabaseDeletionReceiptStore({ root, now: () => Date.parse('2026-09-10T12:00:00.000Z') });
    const written = await store.write({ serverId, jobId, databaseName, ownership, result });
    assert.deepEqual(written.ownership, ownership);
    assert.deepEqual(written.result, result);
    assert.equal(mode(await stat(root)), 0o700);
    assert.equal(mode(await stat(path.join(root, serverId))), 0o700);
    assert.equal(mode(await stat(store.receiptPath(serverId, jobId))), 0o600);
    assert.deepEqual(await store.read(serverId, jobId), written);
  });
});

test('database deletion receipt remains backward-compatible with unscoped deletes', async () => {
  await withTemp(async (root) => {
    const store = createDatabaseDeletionReceiptStore({ root: path.join(root, 'receipts') });
    const written = await store.write({ serverId, jobId, databaseName, result });
    assert.equal(written.ownership, null);
    assert.equal((await store.read(serverId, jobId)).ownership, null);
  });
});

test('database deletion receipt rejects incomplete or stale-shaped ownership evidence', async () => {
  await withTemp(async (root) => {
    const store = createDatabaseDeletionReceiptStore({ root: path.join(root, 'receipts') });
    for (const invalidOwnership of [
      { websiteId },
      { ...ownership, expectedBindingRevision: 0 },
      { ...ownership, databaseBindingId: 'not-a-uuid' },
      { ...ownership, backupId: 'short' },
      { ...ownership, expectedBackupSha256: 'bad' },
      { ...ownership, password: 'forbidden' },
    ]) {
      await assert.rejects(
        store.write({ serverId, jobId, databaseName, ownership: invalidOwnership, result }),
        { code: 'database_deletion_receipt_ownership_invalid' },
      );
    }
  });
});

test('database deletion receipt rejects extra result data before persistence', async () => {
  await withTemp(async (root) => {
    const store = createDatabaseDeletionReceiptStore({ root: path.join(root, 'receipts') });
    await assert.rejects(
      store.write({ serverId, jobId, databaseName, result: { ...result, commandOutput: 'secret-data' } }),
      { code: 'database_deletion_receipt_result_invalid' },
    );
    assert.equal(await store.read(serverId, jobId), null);
  });
});

test('database deletion receipt requires exact database identity', async () => {
  await withTemp(async (root) => {
    const store = createDatabaseDeletionReceiptStore({ root: path.join(root, 'receipts') });
    await assert.rejects(
      store.write({ serverId, jobId, databaseName, result: { ...result, database: { name: 'other_db', sizeBytes: 4096 } } }),
      { code: 'database_deletion_receipt_result_invalid' },
    );
  });
});
