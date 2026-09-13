import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const serverId = randomUUID();
const mailDomainId = randomUUID();
const mailboxId = randomUUID();
const digest = 'a'.repeat(64);

async function queuedBackup(registry) {
  return registry.enqueue({
    serverId,
    type: 'mail_data_backup',
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    payload: {
      mailDomainId,
      resourceId: mailboxId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedResourceRevision: 3,
      expectedSnapshotSha256: digest,
    },
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    idempotencyKey: `mail-data-backup:${mailDomainId}:${digest}`,
  });
}

test('mail data backup durably enqueues, claims and completes with a secret-free result', async () => {
  const registry = createJobRegistry();
  const queued = await queuedBackup(registry);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.operation, OPERATIONS.MAIL_DATA_BACKUP);

  const claimed = await registry.claimNext(serverId);
  assert.equal(claimed.job.id, queued.id);
  assert.equal(claimed.envelope.operation, OPERATIONS.MAIL_DATA_BACKUP);
  assert.deepEqual(claimed.envelope.payload, {
    mailDomainId,
    resourceId: mailboxId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedResourceRevision: 3,
    expectedSnapshotSha256: digest,
  });

  const terminal = await registry.complete({
    serverId,
    jobId: queued.id,
    status: 'succeeded',
    result: {
      version: 1,
      backupId: queued.id,
      mailDomainId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      sourcePresent: true,
      sourceSnapshotSha256: digest,
      contentSha256: 'b'.repeat(64),
      bytes: 4096,
      files: 4,
      directories: 5,
      backedUp: true,
      sideEffects: true,
    },
  });
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.result.backupId, queued.id);
  assert.equal(JSON.stringify(terminal.result).includes('/var/lib/yunpanel/mail'), false);
  assert.equal(JSON.stringify(terminal.result).includes('message'), false);
});

test('mail data restore pins selected backup and pre-restore identity in terminal result', async () => {
  const registry = createJobRegistry();
  const queued = await registry.enqueue({
    serverId,
    type: 'mail_data_restore',
    operation: OPERATIONS.MAIL_DATA_RESTORE,
    payload: {
      mailDomainId,
      resourceId: mailDomainId,
      backupId: 'mail-backup-selected',
      scope: 'domain',
      identity: 'example.com',
      expectedResourceRevision: 5,
      expectedTargetSnapshotSha256: digest,
    },
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    idempotencyKey: `mail-data-restore:${mailDomainId}:${digest}`,
  });
  await registry.claimNext(serverId);
  const terminal = await registry.complete({
    serverId,
    jobId: queued.id,
    status: 'succeeded',
    result: {
      version: 1,
      transactionId: queued.id,
      backupId: 'mail-backup-selected',
      preRestoreBackupId: `pre-restore:${queued.id}`,
      mailDomainId,
      scope: 'domain',
      identity: 'example.com',
      contentSha256: 'c'.repeat(64),
      bytes: 8192,
      files: 8,
      directories: 9,
      restoredPresent: true,
      applied: true,
      sideEffects: true,
    },
  });
  assert.equal(terminal.result.transactionId, queued.id);
  assert.equal(terminal.result.preRestoreBackupId, `pre-restore:${queued.id}`);
  assert.equal(terminal.result.applied, true);
});

test('mail data delete durably pins resource backup revision and secret-free absence result', async () => {
  const registry = createJobRegistry();
  const queued = await registry.enqueue({
    serverId,
    type: 'mail_data_delete',
    operation: OPERATIONS.MAIL_DATA_DELETE,
    payload: {
      mailDomainId,
      resourceId: mailboxId,
      backupId: 'mail-backup-selected',
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedResourceRevision: 3,
      expectedTargetSnapshotSha256: digest,
    },
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    idempotencyKey: `mail-data-delete:${mailDomainId}:${digest}`,
  });
  const claimed = await registry.claimNext(serverId);
  assert.equal(claimed.envelope.operation, OPERATIONS.MAIL_DATA_DELETE);
  assert.equal(claimed.envelope.payload.resourceId, mailboxId);

  const terminal = await registry.complete({
    serverId,
    jobId: queued.id,
    status: 'succeeded',
    result: {
      version: 1,
      transactionId: queued.id,
      backupId: 'mail-backup-selected',
      mailDomainId,
      resourceId: mailboxId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      sourcePresent: true,
      contentSha256: 'd'.repeat(64),
      bytes: 4096,
      files: 4,
      directories: 5,
      deleted: true,
      sideEffects: true,
    },
  });
  assert.equal(terminal.result.resourceId, mailboxId);
  assert.equal(terminal.result.expectedResourceRevision, 3);
  assert.equal(terminal.result.deleted, true);
  assert.doesNotMatch(JSON.stringify(terminal.result), /tombstone|sourcePath|dataPath/);
});

test('mail data completion rejects private or mismatched result fields', async () => {
  const registry = createJobRegistry();
  const queued = await queuedBackup(registry);
  await registry.claimNext(serverId);
  await assert.rejects(
    registry.complete({
      serverId,
      jobId: queued.id,
      status: 'succeeded',
      result: {
        version: 1,
        backupId: queued.id,
        mailDomainId,
        scope: 'mailbox',
        identity: 'owner@example.com',
        sourcePresent: true,
        sourceSnapshotSha256: digest,
        contentSha256: 'b'.repeat(64),
        bytes: 4096,
        files: 4,
        directories: 5,
        backedUp: true,
        sideEffects: true,
        dataPath: '/private/mail/data',
      },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );
});

test('mail data uses the existing mail-domain lock shared with managed mail configuration', async () => {
  const registry = createJobRegistry();
  await registry.enqueue({
    serverId,
    type: 'mail_config_apply',
    operation: OPERATIONS.MAIL_CONFIG_APPLY,
    payload: {
      mailDomainId,
      expectedRevision: 2,
      desiredStatus: 'disabled',
      previewDigest: 'b'.repeat(64),
      configurationSha256: 'c'.repeat(64),
    },
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
  });
  await assert.rejects(
    queuedBackup(registry),
    (error) => error instanceof JobRegistryError && error.code === 'mail_domain_job_conflict' && error.status === 409,
  );
});