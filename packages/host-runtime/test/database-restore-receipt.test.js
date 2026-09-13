import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDatabaseRestoreReceiptStore,
  DatabaseRestoreReceiptError,
} from '../src/database-restore-receipt.js';

const input = Object.freeze({
  version: 1,
  transactionId: 'restore-0001',
  backupId: 'backup-0001',
  preRestoreBackupId: 'pre-restore:restore-0001',
  databaseName: 'app_main',
  engine: 'mariadb',
  dumpSha256: 'a'.repeat(64),
  preRestoreDumpSha256: 'b'.repeat(64),
  restored: true,
  verified: true,
  sideEffects: true,
});

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-restore-receipt-'));
  const root = path.join(base, 'receipts');
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = createDatabaseRestoreReceiptStore({
    root,
    now: () => Date.parse('2026-09-13T04:30:00.000Z'),
    randomSuffix: () => 'abcdef1234567890',
  });
  return { base, root, store };
}

test('database restore receipt is atomically persisted with private permissions', async (t) => {
  const fx = await fixture(t);
  const receipt = await fx.store.write(input);
  assert.deepEqual(receipt, {
    ...input,
    committedAt: '2026-09-13T04:30:00.000Z',
  });
  const rootMetadata = await lstat(fx.root);
  const fileMetadata = await lstat(fx.store.receiptPath(input.transactionId));
  assert.equal(rootMetadata.mode & 0o777, 0o700);
  assert.equal(fileMetadata.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(fx.store.receiptPath(input.transactionId), 'utf8')), receipt);
  assert.deepEqual(await fx.store.read(input.transactionId), receipt);
});

test('identical database restore receipt writes are idempotent and preserve commit time', async (t) => {
  const fx = await fixture(t);
  const first = await fx.store.write(input);
  const second = await fx.store.write(input);
  assert.deepEqual(second, first);
});

test('database restore receipt rejects conflicting evidence for the same transaction', async (t) => {
  const fx = await fixture(t);
  await fx.store.write(input);
  await assert.rejects(
    fx.store.write({ ...input, dumpSha256: 'c'.repeat(64) }),
    (error) => error instanceof DatabaseRestoreReceiptError && error.code === 'database_restore_receipt_conflict',
  );
});

test('database restore receipt reader rejects symlink evidence', async (t) => {
  const fx = await fixture(t);
  await rm(fx.root, { recursive: true, force: true });
  await writeFile(path.join(fx.base, 'target.json'), `${JSON.stringify({ ...input, committedAt: '2026-09-13T04:30:00.000Z' })}\n`, { mode: 0o600 });
  await rm(fx.root, { recursive: true, force: true });
  await import('node:fs/promises').then(({ mkdir }) => mkdir(fx.root, { mode: 0o700 }));
  await symlink(path.join(fx.base, 'target.json'), fx.store.receiptPath(input.transactionId));
  await assert.rejects(
    fx.store.read(input.transactionId),
    (error) => error instanceof DatabaseRestoreReceiptError && error.code === 'database_restore_receipt_file_invalid',
  );
});
