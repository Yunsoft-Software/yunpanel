import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  createOperationEnvelope,
  isKnownOperation,
  OPERATIONS,
  validateOperationEnvelope,
} from '../src/index-extended.js';

const mailDomainId = '12345678-1234-4234-8234-123456789012';
const mailboxId = '22345678-1234-4234-8234-123456789012';
const digest = 'a'.repeat(64);

function envelope(operation, payload) {
  return {
    id: 'job-mail-data-0001',
    operation,
    payload,
    protocolVersion: AGENT_PROTOCOL_VERSION,
  };
}

test('mail data backup restore and delete are known exact-payload operations', () => {
  assert.equal(isKnownOperation(OPERATIONS.MAIL_DATA_BACKUP), true);
  assert.equal(isKnownOperation(OPERATIONS.MAIL_DATA_RESTORE), true);
  assert.equal(isKnownOperation(OPERATIONS.MAIL_DATA_DELETE), true);

  const backupPayload = {
    mailDomainId,
    resourceId: mailboxId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedResourceRevision: 3,
    expectedSnapshotSha256: digest,
  };
  const backup = createOperationEnvelope({ id: 'job-mail-data-0001', operation: OPERATIONS.MAIL_DATA_BACKUP, payload: backupPayload });
  assert.deepEqual(backup, envelope(OPERATIONS.MAIL_DATA_BACKUP, backupPayload));

  const restorePayload = {
    mailDomainId,
    resourceId: mailDomainId,
    backupId: 'backup-mail-0001',
    scope: 'domain',
    identity: 'example.com',
    expectedResourceRevision: 5,
    expectedTargetSnapshotSha256: digest,
  };
  const restore = createOperationEnvelope({ id: 'job-mail-data-0002', operation: OPERATIONS.MAIL_DATA_RESTORE, payload: restorePayload });
  assert.deepEqual(restore, {
    ...envelope(OPERATIONS.MAIL_DATA_RESTORE, restorePayload),
    id: 'job-mail-data-0002',
  });

  const deletePayload = {
    mailDomainId,
    resourceId: mailboxId,
    backupId: 'backup-mail-0001',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedResourceRevision: 3,
    expectedTargetSnapshotSha256: digest,
  };
  const deletion = createOperationEnvelope({ id: 'job-mail-data-0003', operation: OPERATIONS.MAIL_DATA_DELETE, payload: deletePayload });
  assert.deepEqual(deletion, {
    ...envelope(OPERATIONS.MAIL_DATA_DELETE, deletePayload),
    id: 'job-mail-data-0003',
  });
});

test('mail data protocol rejects malformed identities stale-shaped payloads and invalid backup ids', () => {
  for (const candidate of [
    envelope(OPERATIONS.MAIL_DATA_BACKUP, {
      mailDomainId,
      resourceId: mailboxId,
      scope: 'mailbox',
      identity: 'Owner@Example.COM',
      expectedResourceRevision: 3,
      expectedSnapshotSha256: digest,
    }),
    envelope(OPERATIONS.MAIL_DATA_BACKUP, {
      mailDomainId,
      resourceId: mailboxId,
      scope: 'domain',
      identity: 'example.com',
      expectedResourceRevision: 5,
      expectedSnapshotSha256: digest,
    }),
    envelope(OPERATIONS.MAIL_DATA_BACKUP, {
      mailDomainId,
      resourceId: mailDomainId,
      scope: 'domain',
      identity: 'example.com',
      expectedSnapshotSha256: digest,
    }),
    envelope(OPERATIONS.MAIL_DATA_RESTORE, {
      mailDomainId,
      resourceId: mailboxId,
      backupId: '../escape',
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedResourceRevision: 3,
      expectedTargetSnapshotSha256: digest,
    }),
    envelope(OPERATIONS.MAIL_DATA_RESTORE, {
      mailDomainId,
      resourceId: mailDomainId,
      backupId: 'backup-mail-0001',
      scope: 'domain',
      identity: 'EXAMPLE.com',
      expectedResourceRevision: 5,
      expectedTargetSnapshotSha256: digest,
    }),
    envelope(OPERATIONS.MAIL_DATA_DELETE, {
      mailDomainId,
      resourceId: mailboxId,
      backupId: 'backup-mail-0001',
      scope: 'domain',
      identity: 'example.com',
      expectedResourceRevision: 3,
      expectedTargetSnapshotSha256: digest,
    }),
    envelope(OPERATIONS.MAIL_DATA_DELETE, {
      mailDomainId,
      resourceId: mailboxId,
      backupId: 'backup-mail-0001',
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedResourceRevision: 0,
      expectedTargetSnapshotSha256: digest,
    }),
  ]) {
    const result = validateOperationEnvelope(candidate);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});