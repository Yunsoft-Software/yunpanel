import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailDataBackupResourceError,
  mailDataBackupIdentity,
  mailDataBackupResource,
} from '../src/mail-data-backup-resource.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const mailDomainId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const mailboxId = '0bb78242-03a6-429f-9d17-7725c521437c';

function preview(overrides = {}) {
  return {
    version: 1,
    operation: 'mail_data_backup',
    mailDomainId,
    scope: 'domain',
    resourceId: mailDomainId,
    identity: 'example.com',
    expectedRevision: 7,
    snapshotSha256: 'a'.repeat(64),
    sourcePresent: true,
    bytes: 12345,
    previewDigest: 'b'.repeat(64),
    confirmation: 'not-part-of-resource',
    sideEffects: false,
    ...overrides,
  };
}

test('mail data backup resource reuses the guarded backup preview identity', () => {
  const resource = mailDataBackupResource({ serverId, preview: preview() });

  assert.match(resource.identity, /^mail-data:[a-f0-9]{64}$/);
  assert.equal(resource.type, 'mail_data');
  assert.equal(resource.serverId, serverId);
  assert.equal(resource.mailDomainId, mailDomainId);
  assert.equal(resource.scope, 'domain');
  assert.equal(resource.resourceId, mailDomainId);
  assert.equal(resource.sourceIdentity, 'example.com');
  assert.deepEqual(resource.snapshot, {
    revision: 7,
    snapshotSha256: 'a'.repeat(64),
    sourcePresent: true,
    bytes: 12345,
  });
  assert.deepEqual(resource.policy, { disposition: 'include', reason: 'managed_mail_data' });
  const serialized = JSON.stringify(resource);
  assert.doesNotMatch(serialized, /confirmation|previewDigest|sideEffects/);
});

test('mail data resource identity is stable across revision and content changes', () => {
  const first = mailDataBackupResource({ serverId, preview: preview() });
  const second = mailDataBackupResource({ serverId, preview: preview({
    expectedRevision: 8,
    snapshotSha256: 'c'.repeat(64),
    bytes: 99999,
  }) });

  assert.equal(first.identity, second.identity);
  assert.notDeepEqual(first.snapshot, second.snapshot);
});

test('mailbox scoped backup gets a separate stable resource identity', () => {
  const domainIdentity = mailDataBackupIdentity({ mailDomainId, scope: 'domain', resourceId: mailDomainId });
  const mailboxIdentity = mailDataBackupIdentity({ mailDomainId, scope: 'mailbox', resourceId: mailboxId });
  const resource = mailDataBackupResource({ serverId, preview: preview({
    scope: 'mailbox',
    resourceId: mailboxId,
    identity: 'user@example.com',
  }) });

  assert.notEqual(domainIdentity, mailboxIdentity);
  assert.equal(resource.identity, mailboxIdentity);
  assert.equal(resource.sourceIdentity, 'user@example.com');
});

test('absent mail data is explicit and excluded rather than fabricated as backed up', () => {
  const resource = mailDataBackupResource({ serverId, preview: preview({
    sourcePresent: false,
    bytes: 0,
    snapshotSha256: '0'.repeat(64),
  }) });

  assert.deepEqual(resource.policy, { disposition: 'exclude', reason: 'mail_data_absent' });
  assert.equal(resource.snapshot.sourcePresent, false);
  assert.equal(resource.snapshot.bytes, 0);
});

test('mail data resource rejects malformed revision, digest and scope evidence', () => {
  assert.throws(
    () => mailDataBackupResource({ serverId, preview: preview({ expectedRevision: 0 }) }),
    (error) => error instanceof MailDataBackupResourceError
      && error.code === 'mail_data_backup_resource_preview_invalid',
  );
  assert.throws(
    () => mailDataBackupResource({ serverId, preview: preview({ snapshotSha256: 'bad' }) }),
    (error) => error instanceof MailDataBackupResourceError
      && error.code === 'mail_data_backup_resource_preview_invalid',
  );
  assert.throws(
    () => mailDataBackupResource({ serverId, preview: preview({ scope: 'server' }) }),
    (error) => error instanceof MailDataBackupResourceError,
  );
});
