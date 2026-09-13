import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DatabaseBackupJobResultError,
  sanitizeDatabaseBackupResult,
} from '../src/database-backup-job-result.js';

const jobId = '12345678-1234-4234-8234-123456789012';
const digest = 'a'.repeat(64);
const job = Object.freeze({
  id: jobId,
  resourceId: 'app_main',
  payload: { databaseName: 'app_main' },
});

function result(overrides = {}) {
  return {
    version: 1,
    backupId: jobId,
    databaseName: 'app_main',
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: digest,
    dumpBytes: 4096,
    createdAt: '2026-09-13T03:30:00.000Z',
    backedUp: true,
    sideEffects: true,
    ...overrides,
  };
}

test('database backup sanitizer preserves only exact safe terminal metadata', () => {
  const sanitized = sanitizeDatabaseBackupResult(job, result());
  assert.deepEqual(sanitized, result());
  assert.equal(Object.hasOwn(sanitized, 'dumpPath'), false);
  assert.equal(Object.hasOwn(sanitized, 'sql'), false);
});

test('database backup sanitizer rejects identity drift and private extras', () => {
  for (const candidate of [
    result({ backupId: '22345678-1234-4234-8234-123456789012' }),
    result({ databaseName: 'other_db' }),
    result({ dumpSha256: 'bad' }),
    result({ backedUp: false }),
    { ...result(), dumpPath: '/var/lib/yunpanel/backups/databases/private/dump.sql' },
  ]) {
    assert.throws(
      () => sanitizeDatabaseBackupResult(job, candidate),
      (error) => error instanceof DatabaseBackupJobResultError && error.code === 'invalid_job_result',
    );
  }
});
