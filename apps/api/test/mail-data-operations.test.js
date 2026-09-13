import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createMailDataOperationsService,
  MailDataOperationsError,
} from '../src/mail-data-operations.js';

const localServerId = randomUUID();
const webDomainId = randomUUID();
const mailDomainId = randomUUID();
const mailboxId = randomUUID();
const digest = 'a'.repeat(64);

function fixture({ domainStatus = 'disabled', mailboxRevision = 3, activeJobs = [], selectedBackup = null } = {}) {
  const enqueued = [];
  const mailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: domainStatus,
    revision: 5,
  };
  const mailbox = {
    id: mailboxId,
    mailDomainId,
    address: 'owner@example.com',
    enabled: false,
    revision: mailboxRevision,
  };
  const service = createMailDataOperationsService({
    localServerId,
    mailDomainRegistry: { async getMailDomain(id) { return id === mailDomainId ? mailDomain : null; } },
    domainRegistry: {
      async getDomain(id) {
        return id === webDomainId ? { id, serverId: localServerId, primaryDomain: 'example.com' } : null;
      },
    },
    mailboxRegistry: { async getMailbox(id) { return id === mailboxId ? mailbox : null; } },
    mailDataInspector: {
      async inspectMailbox(address) {
        assert.equal(address, 'owner@example.com');
        return {
          version: 1,
          scope: 'mailbox',
          identity: address,
          dataPath: '/var/lib/yunpanel/mail/example.com/owner',
          present: true,
          bytes: 4096,
          snapshotSha256: digest,
          sideEffects: false,
        };
      },
      async inspectDomain(domain) {
        assert.equal(domain, 'example.com');
        return {
          version: 1,
          scope: 'domain',
          identity: domain,
          dataPath: '/var/lib/yunpanel/mail/example.com',
          present: true,
          bytes: 8192,
          snapshotSha256: digest,
          sideEffects: false,
        };
      },
    },
    mailDataBackupManager: {
      async inspectBackup(id) {
        if (selectedBackup) return selectedBackup;
        return id === 'mail-backup-0001' ? {
          version: 1,
          backupId: id,
          scope: 'mailbox',
          identity: 'owner@example.com',
          sourcePath: '/var/lib/yunpanel/mail/example.com/owner',
          sourcePresent: true,
          sourceSnapshotSha256: 'b'.repeat(64),
          sourceFingerprintSha256: 'c'.repeat(64),
          contentSha256: 'd'.repeat(64),
          bytes: 2048,
          files: 2,
          directories: 3,
          createdAt: '2026-09-13T21:30:00.000Z',
          sideEffects: true,
        } : null;
      },
    },
    jobRegistry: {
      async listJobs() { return activeJobs; },
      async enqueue(input) {
        enqueued.push(structuredClone(input));
        return { id: randomUUID(), status: 'queued', operation: input.operation };
      },
    },
  });
  return { service, enqueued, mailDomain, mailbox };
}

test('mailbox backup preview queues one secret-free mail-domain locked job', async () => {
  const state = fixture();
  const preview = await state.service.previewBackup({ scope: 'mailbox', resourceId: mailboxId });
  assert.equal(preview.mailDomainId, mailDomainId);
  assert.equal(preview.identity, 'owner@example.com');
  assert.equal(preview.expectedRevision, 3);
  assert.equal(preview.sourcePresent, true);
  assert.equal(preview.bytes, 4096);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.sideEffects, false);

  const queued = await state.service.queueBackup({
    scope: 'mailbox',
    resourceId: mailboxId,
    expectedRevision: preview.expectedRevision,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(queued.previewDigest, preview.previewDigest);
  assert.equal(state.enqueued.length, 1);
  assert.deepEqual(state.enqueued[0], {
    serverId: localServerId,
    type: 'mail_data_backup',
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    payload: {
      mailDomainId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedSnapshotSha256: digest,
    },
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    idempotencyKey: `mail-data-backup:${mailDomainId}:${preview.previewDigest}`,
  });
  assert.doesNotMatch(JSON.stringify(state.enqueued[0]), /sourcePath|message|contentSha256/);
});

test('restore preview requires disabled domain and exact selected backup identity', async () => {
  const enabled = fixture({ domainStatus: 'enabled' });
  await assert.rejects(
    enabled.service.previewRestore({ scope: 'mailbox', resourceId: mailboxId, backupId: 'mail-backup-0001' }),
    (error) => error instanceof MailDataOperationsError && error.code === 'mail_data_restore_domain_disable_required',
  );

  const mismatch = fixture({ selectedBackup: {
    version: 1,
    backupId: 'mail-backup-0001',
    scope: 'domain',
    identity: 'example.com',
    sourcePresent: true,
    contentSha256: 'd'.repeat(64),
    bytes: 100,
  } });
  await assert.rejects(
    mismatch.service.previewRestore({ scope: 'mailbox', resourceId: mailboxId, backupId: 'mail-backup-0001' }),
    (error) => error instanceof MailDataOperationsError && error.code === 'mail_data_restore_backup_mismatch',
  );
});

test('restore queues selected backup against the same mail-domain resource lock', async () => {
  const state = fixture();
  const preview = await state.service.previewRestore({
    scope: 'mailbox', resourceId: mailboxId, backupId: 'mail-backup-0001',
  });
  assert.equal(preview.targetSnapshotSha256, digest);
  assert.equal(preview.backupContentSha256, 'd'.repeat(64));
  assert.equal(preview.targetPresent, true);

  await state.service.queueRestore({
    scope: 'mailbox',
    resourceId: mailboxId,
    backupId: 'mail-backup-0001',
    expectedRevision: preview.expectedRevision,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(state.enqueued.length, 1);
  assert.deepEqual(state.enqueued[0].payload, {
    mailDomainId,
    backupId: 'mail-backup-0001',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedTargetSnapshotSha256: digest,
  });
  assert.equal(state.enqueued[0].resourceType, 'mail_domain');
  assert.equal(state.enqueued[0].resourceId, mailDomainId);
  assert.equal(state.enqueued[0].operation, OPERATIONS.MAIL_DATA_RESTORE);
});

test('active mail-domain jobs block backup and restore previews before enqueue', async () => {
  const state = fixture({ activeJobs: [{ id: randomUUID(), status: 'running' }] });
  await assert.rejects(
    state.service.previewBackup({ scope: 'domain', resourceId: mailDomainId }),
    (error) => error instanceof MailDataOperationsError && error.code === 'mail_domain_job_conflict',
  );
  await assert.rejects(
    state.service.previewRestore({ scope: 'mailbox', resourceId: mailboxId, backupId: 'mail-backup-0001' }),
    (error) => error instanceof MailDataOperationsError && error.code === 'mail_domain_job_conflict',
  );
  assert.equal(state.enqueued.length, 0);
});
