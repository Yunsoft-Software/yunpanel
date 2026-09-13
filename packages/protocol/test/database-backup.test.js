import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  isKnownOperation,
  validateOperationEnvelope,
} from '@yunpanel/protocol';

const id = '12345678-1234-4234-8234-123456789012';
const backupId = '22345678-1234-4234-8234-123456789012';
const digest = 'a'.repeat(64);

test('database backup is a known mutation with an exact public payload', () => {
  assert.equal(OPERATIONS.DATABASE_BACKUP, 'database.backup');
  assert.equal(isKnownOperation(OPERATIONS.DATABASE_BACKUP), true);
  const envelope = createOperationEnvelope({
    id,
    operation: OPERATIONS.DATABASE_BACKUP,
    payload: { databaseName: 'app_main' },
  });
  assert.deepEqual(envelope, {
    id,
    operation: 'database.backup',
    payload: { databaseName: 'app_main' },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
});

test('database backup rejects system names, unsafe names and private extras', () => {
  for (const payload of [
    { databaseName: 'mysql' },
    { databaseName: '../app' },
    { databaseName: 'app-main' },
    { databaseName: 'app_main', dumpPath: '/var/lib/yunpanel/backups/private.sql' },
    { databaseName: 'app_main', sql: 'SELECT 1' },
  ]) {
    const validation = validateOperationEnvelope({
      id,
      operation: OPERATIONS.DATABASE_BACKUP,
      payload,
      protocolVersion: AGENT_PROTOCOL_VERSION,
    });
    assert.equal(validation.ok, false);
  }
});

test('database restore pins safe backup identity and checksum only', () => {
  assert.equal(OPERATIONS.DATABASE_RESTORE, 'database.restore');
  assert.equal(isKnownOperation(OPERATIONS.DATABASE_RESTORE), true);
  const envelope = createOperationEnvelope({
    id,
    operation: OPERATIONS.DATABASE_RESTORE,
    payload: { databaseName: 'app_main', backupId, expectedBackupSha256: digest },
  });
  assert.deepEqual(envelope, {
    id,
    operation: 'database.restore',
    payload: { databaseName: 'app_main', backupId, expectedBackupSha256: digest },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
});

test('database restore rejects stale or private material in the queued payload', () => {
  for (const payload of [
    { databaseName: 'app_main', backupId, expectedBackupSha256: 'bad' },
    { databaseName: 'mysql', backupId, expectedBackupSha256: digest },
    { databaseName: 'app_main', backupId: 'short', expectedBackupSha256: digest },
    { databaseName: 'app_main', backupId, expectedBackupSha256: digest, dumpPath: '/private/dump.sql' },
    { databaseName: 'app_main', backupId, expectedBackupSha256: digest, sql: 'DROP DATABASE mysql' },
  ]) {
    const validation = validateOperationEnvelope({
      id,
      operation: OPERATIONS.DATABASE_RESTORE,
      payload,
      protocolVersion: AGENT_PROTOCOL_VERSION,
    });
    assert.equal(validation.ok, false);
  }
});
