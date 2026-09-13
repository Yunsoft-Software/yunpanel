import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations } from '../src/local-host-operations.js';

const mailDomainId = randomUUID();
const jobId = randomUUID();
const digest = 'a'.repeat(64);

function runtime() {
  const calls = [];
  const operations = createLocalHostOperations({
    mailDataBackupManager: {
      async backup(input) {
        calls.push(['backup', structuredClone(input)]);
        return {
          version: 1,
          backupId: input.backupId,
          scope: input.scope,
          identity: input.identity,
          sourcePath: '/var/lib/yunpanel/mail/example.com/owner',
          sourcePresent: true,
          sourceSnapshotSha256: input.expectedSnapshotSha256,
          sourceFingerprintSha256: 'b'.repeat(64),
          contentSha256: 'c'.repeat(64),
          bytes: 1024,
          files: 2,
          directories: 3,
          createdAt: '2026-09-13T22:00:00.000Z',
          sideEffects: true,
        };
      },
    },
    mailDataRestoreManager: {
      async restore(input) {
        calls.push(['restore', structuredClone(input)]);
        return {
          version: 1,
          transactionId: input.transactionId,
          backupId: input.backupId,
          preRestoreBackupId: `pre-restore:${input.transactionId}`,
          scope: input.scope,
          identity: input.identity,
          contentSha256: 'd'.repeat(64),
          bytes: 2048,
          files: 4,
          directories: 5,
          restoredPresent: true,
          applied: true,
          sideEffects: true,
          privateDataPath: '/private/not-public',
        };
      },
    },
  });
  return { operations, calls };
}

const execution = Object.freeze({
  jobId,
  resourceType: 'mail_domain',
  resourceId: mailDomainId,
});

test('local mail data backup uses job id as backup id and returns only safe evidence', async () => {
  const { operations, calls } = runtime();
  assert.equal(operations.supports(OPERATIONS.MAIL_DATA_BACKUP), true);
  const result = await operations.executeOperation(OPERATIONS.MAIL_DATA_BACKUP, {
    mailDomainId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedResourceRevision: 3,
    expectedSnapshotSha256: digest,
  }, execution);
  assert.deepEqual(calls, [['backup', {
    backupId: jobId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedSnapshotSha256: digest,
  }]]);
  assert.deepEqual(result, {
    version: 1,
    backupId: jobId,
    mailDomainId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    sourcePresent: true,
    sourceSnapshotSha256: digest,
    contentSha256: 'c'.repeat(64),
    bytes: 1024,
    files: 2,
    directories: 3,
    backedUp: true,
    sideEffects: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /sourcePath|privateDataPath|\/var\/lib\/yunpanel\/mail/);
});

test('local mail data restore uses job id as transaction and strips private manager fields', async () => {
  const { operations, calls } = runtime();
  assert.equal(operations.supports(OPERATIONS.MAIL_DATA_RESTORE), true);
  const result = await operations.executeOperation(OPERATIONS.MAIL_DATA_RESTORE, {
    mailDomainId,
    backupId: 'mail-backup-selected',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedResourceRevision: 3,
    expectedTargetSnapshotSha256: digest,
  }, execution);
  assert.deepEqual(calls, [['restore', {
    transactionId: jobId,
    backupId: 'mail-backup-selected',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedTargetSnapshotSha256: digest,
  }]]);
  assert.equal(result.transactionId, jobId);
  assert.equal(result.preRestoreBackupId, `pre-restore:${jobId}`);
  assert.equal(result.contentSha256, 'd'.repeat(64));
  assert.equal(result.applied, true);
  assert.doesNotMatch(JSON.stringify(result), /privateDataPath|\/private/);
});

test('mail data operation rejects wrong execution resource before touching managers', async () => {
  const { operations, calls } = runtime();
  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_DATA_BACKUP, {
      mailDomainId,
      scope: 'domain',
      identity: 'example.com',
      expectedResourceRevision: 5,
      expectedSnapshotSha256: digest,
    }, {
      jobId,
      resourceType: 'mail_domain',
      resourceId: randomUUID(),
    }),
    { code: 'mail_execution_context_invalid' },
  );
  assert.deepEqual(calls, []);
});
