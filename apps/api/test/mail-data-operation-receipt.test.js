import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createMailDataOperationReceiptStore,
  MailDataOperationReceiptError,
} from '../src/mail-data-operation-receipt.js';

const serverId = randomUUID();
const jobId = randomUUID();
const mailDomainId = randomUUID();
const mailboxId = randomUUID();

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-data-receipt-'));
  try {
    return await run(createMailDataOperationReceiptStore({
      root,
      now: () => Date.parse('2026-09-13T22:30:00.000Z'),
    }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('backup receipt persists only secret-free protected evidence', async () => withStore(async (store, root) => {
  const receipt = await store.write({
    serverId,
    jobId,
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    result: {
      version: 1,
      backupId: jobId,
      mailDomainId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      sourcePresent: true,
      sourceSnapshotSha256: 'a'.repeat(64),
      contentSha256: 'b'.repeat(64),
      bytes: 100,
      files: 2,
      directories: 3,
      backedUp: true,
      sideEffects: true,
    },
  });
  assert.equal(receipt.backupId, jobId);
  assert.equal(receipt.backedUp, true);
  assert.doesNotMatch(JSON.stringify(receipt), /sourcePath|dataPath|message/);
  assert.deepEqual(await store.read(serverId, jobId), receipt);
  const filePath = path.join(root, serverId, `${jobId}.json`);
  assert.equal((await lstat(filePath)).mode & 0o777, 0o600);
  assert.equal((await lstat(path.dirname(filePath))).mode & 0o777, 0o700);
}));

test('restore receipt pins transaction, selected backup and pre-restore backup', async () => withStore(async (store) => {
  const receipt = await store.write({
    serverId,
    jobId,
    operation: OPERATIONS.MAIL_DATA_RESTORE,
    result: {
      version: 1,
      transactionId: jobId,
      backupId: 'mail-backup-selected',
      preRestoreBackupId: `pre-restore:${jobId}`,
      mailDomainId,
      scope: 'domain',
      identity: 'example.com',
      contentSha256: 'c'.repeat(64),
      bytes: 200,
      files: 4,
      directories: 5,
      restoredPresent: true,
      applied: true,
      sideEffects: true,
    },
  });
  assert.equal(receipt.transactionId, jobId);
  assert.equal(receipt.preRestoreBackupId, `pre-restore:${jobId}`);
  assert.equal(receipt.applied, true);
}));

test('delete receipt pins resource, transaction and verified backup without private paths', async () => withStore(async (store) => {
  const receipt = await store.write({
    serverId,
    jobId,
    operation: OPERATIONS.MAIL_DATA_DELETE,
    result: {
      version: 1,
      transactionId: jobId,
      backupId: 'mail-backup-selected',
      mailDomainId,
      resourceId: mailboxId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      sourcePresent: true,
      contentSha256: 'd'.repeat(64),
      bytes: 300,
      files: 6,
      directories: 7,
      deleted: true,
      sideEffects: true,
    },
  });
  assert.equal(receipt.operation, OPERATIONS.MAIL_DATA_DELETE);
  assert.equal(receipt.transactionId, jobId);
  assert.equal(receipt.resourceId, mailboxId);
  assert.equal(receipt.deleted, true);
  assert.doesNotMatch(JSON.stringify(receipt), /sourcePath|dataPath|tombstone/);
}));

test('receipt reader fails closed on unsafe mode or extra private fields', async () => withStore(async (store) => {
  await assert.rejects(
    store.write({
      serverId,
      jobId,
      operation: OPERATIONS.MAIL_DATA_BACKUP,
      result: {
        version: 1,
        backupId: jobId,
        mailDomainId,
        scope: 'mailbox',
        identity: 'owner@example.com',
        sourcePresent: true,
        sourceSnapshotSha256: 'a'.repeat(64),
        contentSha256: 'b'.repeat(64),
        bytes: 100,
        files: 2,
        directories: 3,
        backedUp: true,
        sideEffects: true,
        dataPath: '/private/mail',
      },
    }),
    (error) => error instanceof MailDataOperationReceiptError && error.code === 'mail_data_receipt_invalid',
  );

  await store.write({
    serverId,
    jobId,
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    result: {
      version: 1,
      backupId: jobId,
      mailDomainId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      sourcePresent: true,
      sourceSnapshotSha256: 'a'.repeat(64),
      contentSha256: 'b'.repeat(64),
      bytes: 100,
      files: 2,
      directories: 3,
      backedUp: true,
      sideEffects: true,
    },
  });
  const filePath = store.receiptPath(serverId, jobId);
  await chmod(filePath, 0o644);
  await assert.rejects(
    store.read(serverId, jobId),
    (error) => error instanceof MailDataOperationReceiptError && error.code === 'mail_data_receipt_unsafe',
  );
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /private\/mail/);
}));