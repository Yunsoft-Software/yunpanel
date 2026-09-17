import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailConfigRollbackJournal,
  MailConfigRollbackJournalError,
} from '../src/mail-config-rollback-journal.js';

const SERVER_ID = 'local-server';
const JOB_ID = '11111111-2222-4333-8444-555555555555';

function input(overrides = {}) {
  return {
    serverId: SERVER_ID,
    jobId: JOB_ID,
    mailDomainId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
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
    ...overrides,
  };
}

test('mail rollback journal persists restoring intent before terminal source restore evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-rollback-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.parse('2026-09-17T13:00:00.000Z');
  const journal = createMailConfigRollbackJournal({ root, now: () => time });
  const begun = await journal.begin(input());
  assert.equal(begun.status, 'restoring_source');
  assert.equal(begun.lastErrorCode, null);
  assert.doesNotMatch(JSON.stringify(begun), /password|argon2|content|path/i);
  const target = journal.journalPath(SERVER_ID, JOB_ID);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  assert.equal((await stat(target)).mode & 0o777, 0o600);

  time += 1000;
  const restored = await journal.transition(SERVER_ID, JOB_ID, { status: 'restored' });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.updatedAt, '2026-09-17T13:00:01.000Z');
  assert.deepEqual(await journal.read(SERVER_ID, JOB_ID), restored);
});

test('mail rollback journal records bounded compensated failure and blocks terminal replay', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-rollback-journal-comp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = createMailConfigRollbackJournal({ root });
  await journal.begin(input());
  const compensated = await journal.transition(SERVER_ID, JOB_ID, {
    status: 'compensated',
    lastErrorCode: 'mail_restore_validation_failed',
  });
  assert.equal(compensated.lastErrorCode, 'mail_restore_validation_failed');
  await assert.rejects(
    journal.transition(SERVER_ID, JOB_ID, { status: 'restored' }),
    { code: 'mail_config_rollback_journal_terminal' },
  );
});

test('mail rollback journal rejects duplicate intent, malformed evidence and unsafe persisted files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-rollback-journal-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = createMailConfigRollbackJournal({ root });
  await journal.begin(input());
  await assert.rejects(journal.begin(input()), { code: 'mail_config_rollback_journal_conflict' });

  const other = createMailConfigRollbackJournal({ root: path.join(root, 'other') });
  for (const invalid of [
    input({ expectedCurrentRevision: 4 }),
    input({ sourceApplyJobId: 'short' }),
    input({ backupSha256: 'short' }),
    input({ backupPath: '/forbidden' }),
  ]) {
    await assert.rejects(other.begin(invalid), (error) => error instanceof MailConfigRollbackJournalError);
  }

  const unsafe = createMailConfigRollbackJournal({
    root,
    async lstatFn() { return { isFile: () => true, isSymbolicLink: () => true, mode: 0o100600 }; },
  });
  await assert.rejects(unsafe.read(SERVER_ID, JOB_ID), { code: 'mail_config_rollback_journal_unsafe' });
});
