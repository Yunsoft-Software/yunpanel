import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailDkimOperationReceiptStore,
  MailDkimOperationReceiptError,
} from '../src/mail-dkim-operation-receipt.js';

const serverId = 'local-server';
const jobId = 'mail-dkim-job-001';
const mailDomainId = '85f4ca20-56df-4ecb-a335-384e67fd3ca0';
const input = Object.freeze({
  serverId,
  jobId,
  mailDomainId,
  expectedKeyRevision: 1,
  previewDigest: 'a'.repeat(64),
  configurationSha256: 'b'.repeat(64),
  applied: true,
});

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-dkim-receipt-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('persists and reopens only secret-free protected DKIM recovery evidence', async () => withTempDirectory(async (root) => {
  const store = createMailDkimOperationReceiptStore({
    root,
    now: () => Date.parse('2026-09-12T20:00:00.000Z'),
  });
  const written = await store.write(input);
  assert.equal(written.recordedAt, '2026-09-12T20:00:00.000Z');
  assert.equal(written.mailDomainId, mailDomainId);
  assert.deepEqual(await store.read(serverId, jobId), written);

  const receiptPath = store.receiptPath(serverId, jobId);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.dirname(receiptPath))).mode & 0o777, 0o700);
  assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
  const persisted = await readFile(receiptPath, 'utf8');
  assert.doesNotMatch(persisted, /PRIVATE KEY|privateKey|selector|publicKey/i);
}));

test('receipt reader rejects unsafe mode and invalid identity/checksums', async () => withTempDirectory(async (root) => {
  const store = createMailDkimOperationReceiptStore({ root });
  await store.write(input);
  const receiptPath = store.receiptPath(serverId, jobId);
  await chmod(receiptPath, 0o644);
  await assert.rejects(
    store.read(serverId, jobId),
    (error) => error instanceof MailDkimOperationReceiptError && error.code === 'mail_dkim_receipt_unsafe',
  );
  await assert.rejects(
    createMailDkimOperationReceiptStore({ root }).write({ ...input, previewDigest: 'bad' }),
    (error) => error instanceof MailDkimOperationReceiptError && error.code === 'mail_dkim_receipt_checksum_invalid',
  );
}));
