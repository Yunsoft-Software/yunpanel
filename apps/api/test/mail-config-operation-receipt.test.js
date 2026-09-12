import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailConfigOperationReceiptStore,
  MailConfigOperationReceiptError,
} from '../src/mail-config-operation-receipt.js';

const SERVER_ID = 'local-server';
const JOB_ID = '11111111-2222-4333-8444-555555555555';
const MAIL_DOMAIN_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function input(overrides = {}) {
  return {
    serverId: SERVER_ID,
    jobId: JOB_ID,
    mailDomainId: MAIL_DOMAIN_ID,
    desiredStatus: 'enabled',
    previewDigest: 'a'.repeat(64),
    configurationSha256: 'b'.repeat(64),
    planSha256: 'c'.repeat(64),
    readinessSha256: 'd'.repeat(64),
    applied: true,
    ...overrides,
  };
}

test('managed mail operation receipt persists only protected secret-free evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMailConfigOperationReceiptStore({
    root,
    now: () => Date.parse('2026-09-12T12:00:00.000Z'),
  });

  const written = await store.write(input());
  assert.equal(written.recordedAt, '2026-09-12T12:00:00.000Z');
  assert.equal(written.applied, true);
  assert.equal(JSON.stringify(written).includes('password'), false);
  assert.equal(JSON.stringify(written).includes('argon2'), false);

  const target = store.receiptPath(SERVER_ID, JOB_ID);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await store.read(SERVER_ID, JOB_ID), written);
  assert.equal((await readFile(target, 'utf8')).includes('password'), false);
});

test('managed mail receipt rejects forged status, digests and applied state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-receipt-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMailConfigOperationReceiptStore({ root });

  for (const invalid of [
    input({ desiredStatus: 'ready' }),
    input({ previewDigest: 'short' }),
    input({ configurationSha256: 'e'.repeat(63) }),
    input({ applied: false }),
    input({ mailDomainId: 'not-a-uuid' }),
  ]) {
    await assert.rejects(
      store.write(invalid),
      (error) => error instanceof MailConfigOperationReceiptError,
    );
  }
});
