import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailDataJobResultError,
  sanitizeMailDataBackupResult,
  sanitizeMailDataRestoreResult,
} from '../src/mail-data-job-result.js';

const mailDomainId = '12345678-1234-4234-8234-123456789012';
const jobId = '87654321-1234-4234-8234-123456789012';
const digest = 'a'.repeat(64);

function backupJob() {
  return {
    id: jobId,
    payload: {
      mailDomainId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedSnapshotSha256: digest,
    },
  };
}

function backupResult(overrides = {}) {
  return {
    version: 1,
    backupId: jobId,
    mailDomainId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    sourcePresent: true,
    sourceSnapshotSha256: digest,
    contentSha256: 'b'.repeat(64),
    bytes: 1024,
    files: 3,
    directories: 4,
    backedUp: true,
    sideEffects: true,
    ...overrides,
  };
}

test('backup sanitizer emits only bounded secret-free evidence', () => {
  assert.deepEqual(sanitizeMailDataBackupResult(backupJob(), backupResult()), backupResult());
  for (const result of [
    backupResult({ sourcePath: '/var/lib/yunpanel/mail/example.com/owner' }),
    backupResult({ backupId: 'other-backup-id' }),
    backupResult({ sourceSnapshotSha256: 'c'.repeat(64) }),
    backupResult({ files: -1 }),
    backupResult({ backedUp: false }),
  ]) {
    assert.throws(
      () => sanitizeMailDataBackupResult(backupJob(), result),
      (error) => error instanceof MailDataJobResultError && error.code === 'invalid_job_result',
    );
  }
});

function restoreJob() {
  return {
    id: jobId,
    payload: {
      mailDomainId,
      backupId: 'mail-backup-selected',
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedTargetSnapshotSha256: digest,
    },
  };
}

function restoreResult(overrides = {}) {
  return {
    version: 1,
    transactionId: jobId,
    backupId: 'mail-backup-selected',
    preRestoreBackupId: `pre-restore:${jobId}`,
    mailDomainId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    contentSha256: 'd'.repeat(64),
    bytes: 2048,
    files: 5,
    directories: 6,
    restoredPresent: true,
    applied: true,
    sideEffects: true,
    ...overrides,
  };
}

test('restore sanitizer pins transaction and pre-restore backup identities', () => {
  assert.deepEqual(sanitizeMailDataRestoreResult(restoreJob(), restoreResult()), restoreResult());
  for (const result of [
    restoreResult({ dataPath: '/private/mail/data' }),
    restoreResult({ transactionId: 'other-job-0001' }),
    restoreResult({ preRestoreBackupId: 'pre-restore:other-job-0001' }),
    restoreResult({ backupId: 'different-backup' }),
    restoreResult({ contentSha256: 'not-a-digest' }),
    restoreResult({ restoredPresent: false }),
  ]) {
    assert.throws(
      () => sanitizeMailDataRestoreResult(restoreJob(), result),
      (error) => error instanceof MailDataJobResultError && error.code === 'invalid_job_result',
    );
  }
});
