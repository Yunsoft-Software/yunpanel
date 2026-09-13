import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DatabaseRestoreJobResultError,
  sanitizeDatabaseRestoreResult,
} from '../src/database-restore-job-result.js';

const jobId = '12345678-1234-4234-8234-123456789012';
const backupId = '22345678-1234-4234-8234-123456789012';
const selectedSha = 'a'.repeat(64);
const preRestoreSha = 'b'.repeat(64);
const job = {
  id: jobId,
  resourceId: 'app_main',
  payload: { databaseName: 'app_main', backupId, expectedBackupSha256: selectedSha },
};

function result(overrides = {}) {
  return {
    version: 1,
    transactionId: jobId,
    backupId,
    preRestoreBackupId: `pre-restore:${jobId}`,
    databaseName: 'app_main',
    engine: 'mariadb',
    dumpSha256: selectedSha,
    preRestoreDumpSha256: preRestoreSha,
    restored: true,
    verified: true,
    sideEffects: true,
    ...overrides,
  };
}

test('database restore sanitizer accepts exact selected and pre-restore evidence only', () => {
  assert.deepEqual(sanitizeDatabaseRestoreResult(job, result()), result());
});

test('database restore sanitizer rejects stale identity and private extras', () => {
  for (const candidate of [
    result({ transactionId: '32345678-1234-4234-8234-123456789012' }),
    result({ backupId: '42345678-1234-4234-8234-123456789012' }),
    result({ preRestoreBackupId: 'pre-restore:other-job' }),
    result({ dumpSha256: 'c'.repeat(64) }),
    result({ verified: false }),
    { ...result(), dumpPath: '/private/dump.sql' },
  ]) {
    assert.throws(
      () => sanitizeDatabaseRestoreResult(job, candidate),
      (error) => error instanceof DatabaseRestoreJobResultError && error.code === 'invalid_job_result',
    );
  }
});
