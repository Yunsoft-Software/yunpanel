import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailConfigRollbackReceiptStore,
  MailConfigRollbackReceiptError,
} from '../src/mail-config-rollback-receipt.js';

const SERVER_ID = 'local-server';
const JOB_ID = '11111111-2222-4333-8444-555555555555';
const MAIL_DOMAIN_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function input(overrides = {}) {
  return {
    serverId: SERVER_ID,
    jobId: JOB_ID,
    mailDomainId: MAIL_DOMAIN_ID,
    sourceApplyJobId: 'mail-job-source-0001',
    previousRevision: 4,
    expectedCurrentRevision: 5,
    currentStatus: 'enabled',
    targetStatus: 'disabled',
    previewDigest: 'a'.repeat(64),
    currentConfigurationSha256: 'b'.repeat(64),
    sourcePlanSha256: 'c'.repeat(64),
    backupSha256: 'd'.repeat(64),
    compensationBackupSha256: 'e'.repeat(64),
    restored: true,
    ...overrides,
  };
}

test('managed mail rollback receipt persists exact secret-free restore evidence privately', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-rollback-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMailConfigRollbackReceiptStore({
    root,
    now: () => Date.parse('2026-09-17T12:00:00.000Z'),
  });
  const written = await store.write(input());
  assert.equal(written.recordedAt, '2026-09-17T12:00:00.000Z');
  assert.equal(written.restored, true);
  assert.doesNotMatch(JSON.stringify(written), /password|argon2|content|path/i);
  const target = store.receiptPath(SERVER_ID, JOB_ID);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await store.read(SERVER_ID, JOB_ID), written);
  assert.doesNotMatch(await readFile(target, 'utf8'), /password|argon2|content|path/i);
});

test('managed mail rollback receipt rejects revision drift, malformed identity and expanded state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-rollback-receipt-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMailConfigRollbackReceiptStore({ root });
  for (const invalid of [
    input({ expectedCurrentRevision: 4 }),
    input({ sourceApplyJobId: 'short' }),
    input({ targetStatus: 'ready' }),
    input({ compensationBackupSha256: 'short' }),
    input({ restored: false }),
    input({ backupPath: '/forbidden' }),
  ]) {
    await assert.rejects(
      store.write(invalid),
      (error) => error instanceof MailConfigRollbackReceiptError,
    );
  }
});

test('managed mail rollback receipt reader rejects unsafe or expanded persisted evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-rollback-receipt-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map();
  const target = path.join(root, SERVER_ID, `${JOB_ID}.json`);
  files.set(target, JSON.stringify({
    version: 1,
    recordedAt: '2026-09-17T12:00:00.000Z',
    ...input(),
    backupPath: '/forbidden',
  }));
  const store = createMailConfigRollbackReceiptStore({
    root,
    async lstatFn(pathname) {
      if (!files.has(pathname)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true, isSymbolicLink: () => false, mode: 0o100600 };
    },
    async readFileFn(pathname) { return files.get(pathname); },
  });
  await assert.rejects(store.read(SERVER_ID, JOB_ID), { code: 'mail_config_rollback_receipt_invalid' });

  const unsafe = createMailConfigRollbackReceiptStore({
    root,
    async lstatFn() { return { isFile: () => true, isSymbolicLink: () => true, mode: 0o100600 }; },
  });
  await assert.rejects(unsafe.read(SERVER_ID, JOB_ID), { code: 'mail_config_rollback_receipt_unsafe' });
});
