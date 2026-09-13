import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createLocalHostOperations,
  localHostOperationInternals,
} from '../src/local-host-operations.js';

const jobId = '12345678-1234-4234-8234-123456789012';
const backupId = '22345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';
const digest = 'a'.repeat(64);
const preRestoreDigest = 'b'.repeat(64);

function publicResult(overrides = {}) {
  return {
    version: 1,
    backupId: jobId,
    databaseName,
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: digest,
    dumpBytes: 4096,
    createdAt: '2026-09-13T04:00:00.000Z',
    backedUp: true,
    sideEffects: true,
    ...overrides,
  };
}

function restoreResult(overrides = {}) {
  return {
    version: 1,
    transactionId: jobId,
    backupId,
    preRestoreBackupId: `pre-restore:${jobId}`,
    databaseName,
    engine: 'mariadb',
    dumpSha256: digest,
    preRestoreDumpSha256: preRestoreDigest,
    restored: true,
    verified: true,
    sideEffects: true,
    ...overrides,
  };
}

test('database backup uses the job identity as private backup identity and returns safe metadata', async () => {
  const calls = [];
  const operations = createLocalHostOperations({
    databaseDumpManager: {
      async backup(input) {
        calls.push(input);
        return publicResult();
      },
    },
  });
  assert.equal(operations.supports(OPERATIONS.DATABASE_BACKUP), true);
  const result = await operations.executeOperation(
    OPERATIONS.DATABASE_BACKUP,
    { databaseName },
    { jobId, resourceType: 'database', resourceId: databaseName },
  );
  assert.deepEqual(calls, [{ backupId: jobId, databaseName }]);
  assert.deepEqual(result, publicResult());
  assert.equal(Object.hasOwn(result, 'dumpPath'), false);
});

test('database backup execution context must match the queued database resource', async () => {
  let executions = 0;
  const operations = createLocalHostOperations({
    databaseDumpManager: {
      async backup() { executions += 1; return publicResult(); },
    },
  });
  await assert.rejects(
    operations.executeOperation(
      OPERATIONS.DATABASE_BACKUP,
      { databaseName },
      { jobId, resourceType: 'database', resourceId: 'other_db' },
    ),
    { code: 'database_backup_execution_context_invalid' },
  );
  assert.equal(executions, 0);
});

test('database backup adapter rejects private paths returned by the manager', async () => {
  const operations = createLocalHostOperations({
    databaseDumpManager: {
      async backup() { return { ...publicResult(), dumpPath: '/private/dump.sql' }; },
    },
  });
  await assert.rejects(
    operations.executeOperation(
      OPERATIONS.DATABASE_BACKUP,
      { databaseName },
      { jobId, resourceType: 'database', resourceId: databaseName },
    ),
    { code: 'database_backup_unconfirmed' },
  );
});

test('database restore pins selected backup digest and job identity into the host transaction', async () => {
  const calls = [];
  const operations = createLocalHostOperations({
    databaseRestoreManager: {
      async restore(input) { calls.push(input); return restoreResult(); },
    },
  });
  const payload = { databaseName, backupId, expectedBackupSha256: digest };
  const result = await operations.executeOperation(
    OPERATIONS.DATABASE_RESTORE,
    payload,
    { jobId, resourceType: 'database', resourceId: databaseName },
  );
  assert.deepEqual(calls, [{
    transactionId: jobId,
    backupId,
    databaseName,
    expectedBackupSha256: digest,
  }]);
  assert.deepEqual(result, restoreResult());
  assert.equal(Object.hasOwn(result, 'dumpPath'), false);
});

test('database restore rejects context drift and private manager output', async () => {
  const payload = { databaseName, backupId, expectedBackupSha256: digest };
  let executions = 0;
  const contextDrift = createLocalHostOperations({
    databaseRestoreManager: {
      async restore() { executions += 1; return restoreResult(); },
    },
  });
  await assert.rejects(
    contextDrift.executeOperation(
      OPERATIONS.DATABASE_RESTORE,
      payload,
      { jobId, resourceType: 'database', resourceId: 'other_db' },
    ),
    { code: 'database_restore_execution_context_invalid' },
  );
  assert.equal(executions, 0);

  const privateOutput = createLocalHostOperations({
    databaseRestoreManager: {
      async restore() { return { ...restoreResult(), dumpPath: '/private/dump.sql' }; },
    },
  });
  await assert.rejects(
    privateOutput.executeOperation(
      OPERATIONS.DATABASE_RESTORE,
      payload,
      { jobId, resourceType: 'database', resourceId: databaseName },
    ),
    { code: 'database_restore_unconfirmed' },
  );
});

test('database execution helpers reject malformed job identities', () => {
  assert.throws(
    () => localHostOperationInternals.assertDatabaseBackupExecutionContext(
      { databaseName },
      { jobId: 'short', resourceType: 'database', resourceId: databaseName },
    ),
    { code: 'database_backup_execution_context_invalid' },
  );
  assert.throws(
    () => localHostOperationInternals.assertDatabaseRestoreExecutionContext(
      { databaseName },
      { jobId: 'short', resourceType: 'database', resourceId: databaseName },
    ),
    { code: 'database_restore_execution_context_invalid' },
  );
});
