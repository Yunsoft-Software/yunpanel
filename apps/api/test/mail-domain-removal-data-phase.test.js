import assert from 'node:assert/strict';
import test from 'node:test';

import { OPERATIONS } from '@yunpanel/protocol';
import {
  createMailDomainRemovalDataPhase,
  mailDomainRemovalDataPhaseInternals,
} from '../src/mail-domain-removal-data-phase.js';

const operationId = '12345678-1234-4234-8234-123456789012';
const mailDomainId = '22345678-1234-4234-8234-123456789012';
const webDomainId = '32345678-1234-4234-8234-123456789012';
const snapshotSha256 = 'a'.repeat(64);
const cleanupEvidenceDigest = 'b'.repeat(64);
const backupContentSha256 = 'c'.repeat(64);

function operation(overrides = {}) {
  return {
    id: operationId,
    parentOperationId: '42345678-1234-4234-8234-123456789012',
    mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    sourceStatus: 'enabled',
    sourceRevision: 5,
    sourceUpdatedAt: '2026-09-19T08:00:00.000Z',
    removalMethod: 'local_verified_data_finalize',
    previewDigest: 'd'.repeat(64),
    planDigest: 'e'.repeat(64),
    cleanupPlan: {
      version: 2,
      mailDomainId,
      mailboxes: [],
      aliases: [],
      quotas: [],
      forwardings: [],
      dkim: null,
      mailData: {
        present: true,
        bytes: 128,
        snapshotSha256,
      },
      disableConfiguration: {
        previewDigest: 'f'.repeat(64),
        configurationSha256: '1'.repeat(64),
      },
    },
    status: 'backing_up',
    resumeStatus: null,
    disableJobId: 'mail-config-job-1',
    finalRevision: 6,
    cleanupEvidenceDigest,
    dataDeleteJobId: null,
    backupId: null,
    result: null,
    error: null,
    createdAt: '2026-09-19T09:00:00.000Z',
    updatedAt: '2026-09-19T09:05:00.000Z',
    ...overrides,
  };
}

function dataSnapshot(overrides = {}) {
  return {
    version: 1,
    scope: 'domain',
    identity: 'example.com',
    dataPath: '/var/lib/yunpanel/mail/example.com',
    present: true,
    bytes: 128,
    snapshotSha256,
    sideEffects: false,
    ...overrides,
  };
}

function backupManifest(backupId = 'mail-backup-job-1', overrides = {}) {
  return {
    version: 1,
    backupId,
    scope: 'domain',
    identity: 'example.com',
    sourcePath: '/var/lib/yunpanel/mail/example.com',
    sourcePresent: true,
    sourceSnapshotSha256: snapshotSha256,
    sourceFingerprintSha256: '2'.repeat(64),
    contentSha256: backupContentSha256,
    bytes: 128,
    files: 2,
    directories: 1,
    createdAt: '2026-09-19T09:10:00.000Z',
    sideEffects: true,
    ...overrides,
  };
}

function backupJob(id = 'mail-backup-job-1', overrides = {}) {
  return {
    id,
    serverId: 'local-server',
    type: 'mail_data_backup',
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    status: 'succeeded',
    result: {
      version: 1,
      backupId: id,
      mailDomainId,
      scope: 'domain',
      identity: 'example.com',
      sourcePresent: true,
      sourceSnapshotSha256: snapshotSha256,
      contentSha256: backupContentSha256,
      bytes: 128,
      files: 2,
      directories: 1,
      backedUp: true,
      sideEffects: true,
    },
    ...overrides,
  };
}

function deleteJob(id = 'mail-delete-job-1', backupId = 'mail-backup-job-1', overrides = {}) {
  return {
    id,
    serverId: 'local-server',
    type: 'mail_data_delete',
    operation: OPERATIONS.MAIL_DATA_DELETE,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    status: 'succeeded',
    result: {
      version: 1,
      transactionId: id,
      backupId,
      mailDomainId,
      resourceId: mailDomainId,
      expectedResourceRevision: 6,
      scope: 'domain',
      identity: 'example.com',
      sourcePresent: true,
      contentSha256: backupContentSha256,
      bytes: 128,
      files: 2,
      directories: 1,
      deleted: true,
      sideEffects: true,
    },
    ...overrides,
  };
}

function fixture({
  currentData = dataSnapshot(),
  currentMailboxes = [],
  enqueueJob = null,
  getJobs = new Map(),
  backup = null,
} = {}) {
  const calls = {
    enqueue: [],
    deletedMailboxes: [],
    inspectData: 0,
    inspectBackup: [],
  };
  const phase = createMailDomainRemovalDataPhase({
    mailDomainRegistry: {
      async getMailDomain() {
        return {
          id: mailDomainId,
          webDomainId,
          domainName: 'example.com',
          managementMode: 'local',
          status: 'disabled',
          revision: 6,
        };
      },
    },
    domainRegistry: {
      async getDomain() {
        return {
          id: webDomainId,
          primaryDomain: 'example.com',
          serverId: 'local-server',
        };
      },
    },
    mailboxRegistry: {
      async listMailboxes() {
        return structuredClone(currentMailboxes);
      },
      async deleteMailbox(id, options) {
        calls.deletedMailboxes.push({ id, options });
      },
    },
    mailDataInspector: {
      async inspectDomain() {
        calls.inspectData += 1;
        return structuredClone(currentData);
      },
    },
    mailDataBackupManager: {
      async inspectBackup(id) {
        calls.inspectBackup.push(id);
        return backup ? structuredClone(backup) : null;
      },
    },
    jobRegistry: {
      async enqueue(request) {
        calls.enqueue.push(request);
        if (enqueueJob instanceof Error) throw enqueueJob;
        return structuredClone(enqueueJob);
      },
      async getJob(id) {
        const value = getJobs.get(id);
        return value ? structuredClone(value) : null;
      },
    },
    localServerId: 'local-server',
  });
  return { phase, calls };
}

test('backing_up dispatch pins a deterministic verified backup job', async () => {
  const queued = backupJob('mail-backup-job-1', { status: 'queued', result: null });
  const state = fixture({ enqueueJob: queued });

  const result = await state.phase.execute(operation());

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'backing_up');
  assert.equal(result.evidence.backupId, 'mail-backup-job-1');
  assert.equal(result.sideEffects, true);
  assert.equal(state.calls.enqueue.length, 1);
  assert.deepEqual(state.calls.enqueue[0], {
    serverId: 'local-server',
    type: 'mail_data_backup',
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    payload: {
      mailDomainId,
      resourceId: mailDomainId,
      scope: 'domain',
      identity: 'example.com',
      expectedResourceRevision: 6,
      expectedSnapshotSha256: snapshotSha256,
    },
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    idempotencyKey: 'mail-domain-remove-backup:' + operationId,
  });
});

test('startup inspection never dispatches a missing backup job', async () => {
  const state = fixture();

  const result = await state.phase.inspect(operation());

  assert.equal(result.disposition, 'blocked');
  assert.equal(result.error.code, 'mail_domain_removal_backup_dispatch_required');
  assert.equal(result.sideEffects, false);
  assert.equal(state.calls.enqueue.length, 0);
  assert.equal(state.calls.inspectData, 0);
});

test('exact completed backup and persisted manifest advance to deleting_data', async () => {
  const id = 'mail-backup-job-1';
  const state = fixture({
    getJobs: new Map([[id, backupJob(id)]]),
    backup: backupManifest(id),
  });

  const result = await state.phase.execute(operation({ backupId: id }));

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'deleting_data');
  assert.equal(result.evidence.backupId, id);
  assert.equal(result.evidence.dataDeleteJobId, null);
  assert.deepEqual(state.calls.inspectBackup, [id]);
  assert.equal(state.calls.enqueue.length, 0);
});

test('deleting_data removes exactly one pinned mailbox credential per explicit continuation', async () => {
  const pinnedMailbox = {
    id: '52345678-1234-4234-8234-123456789012',
    mailDomainId,
    address: 'admin@example.com',
    enabled: true,
    revision: 3,
    updatedAt: '2026-09-19T08:10:00.000Z',
  };
  const state = fixture({ currentMailboxes: [pinnedMailbox] });
  const current = operation({
    status: 'deleting_data',
    backupId: 'mail-backup-job-1',
    cleanupPlan: {
      ...operation().cleanupPlan,
      mailboxes: [{
        id: pinnedMailbox.id,
        address: pinnedMailbox.address,
        enabled: pinnedMailbox.enabled,
        revision: pinnedMailbox.revision,
        updatedAt: pinnedMailbox.updatedAt,
      }],
    },
  });

  const result = await state.phase.execute(current);

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'deleting_data');
  assert.equal(state.calls.deletedMailboxes.length, 1);
  assert.deepEqual(state.calls.deletedMailboxes[0], {
    id: pinnedMailbox.id,
    options: {
      expectedRevision: pinnedMailbox.revision,
      confirmation: 'delete-mailbox:' + pinnedMailbox.address,
    },
  });
  assert.equal(state.calls.enqueue.length, 0);
});

test('startup inspection leaves remaining mailbox credentials untouched', async () => {
  const pinnedMailbox = {
    id: '52345678-1234-4234-8234-123456789012',
    mailDomainId,
    address: 'admin@example.com',
    enabled: true,
    revision: 3,
    updatedAt: '2026-09-19T08:10:00.000Z',
  };
  const state = fixture({ currentMailboxes: [pinnedMailbox] });
  const current = operation({
    status: 'deleting_data',
    backupId: 'mail-backup-job-1',
    cleanupPlan: {
      ...operation().cleanupPlan,
      mailboxes: [{
        id: pinnedMailbox.id,
        address: pinnedMailbox.address,
        enabled: pinnedMailbox.enabled,
        revision: pinnedMailbox.revision,
        updatedAt: pinnedMailbox.updatedAt,
      }],
    },
  });

  const result = await state.phase.inspect(current);

  assert.equal(result.disposition, 'blocked');
  assert.equal(result.error.code, 'mail_domain_removal_mailbox_cleanup_retry_required');
  assert.equal(result.sideEffects, false);
  assert.equal(state.calls.deletedMailboxes.length, 0);
  assert.equal(state.calls.enqueue.length, 0);
});

test('verified backup and unchanged snapshot dispatch exact mail data deletion', async () => {
  const backupId = 'mail-backup-job-1';
  const queued = deleteJob('mail-delete-job-1', backupId, { status: 'queued', result: null });
  const state = fixture({
    backup: backupManifest(backupId),
    enqueueJob: queued,
  });
  const current = operation({
    status: 'deleting_data',
    backupId,
  });

  const result = await state.phase.execute(current);

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'deleting_data');
  assert.equal(result.evidence.dataDeleteJobId, 'mail-delete-job-1');
  assert.equal(state.calls.enqueue.length, 1);
  assert.deepEqual(state.calls.enqueue[0], {
    serverId: 'local-server',
    type: 'mail_data_delete',
    operation: OPERATIONS.MAIL_DATA_DELETE,
    payload: {
      mailDomainId,
      resourceId: mailDomainId,
      backupId,
      scope: 'domain',
      identity: 'example.com',
      expectedResourceRevision: 6,
      expectedTargetSnapshotSha256: snapshotSha256,
    },
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    idempotencyKey: 'mail-domain-remove-data:' + operationId,
  });
});

test('startup inspection never dispatches missing data deletion', async () => {
  const state = fixture();
  const result = await state.phase.inspect(operation({
    status: 'deleting_data',
    backupId: 'mail-backup-job-1',
  }));

  assert.equal(result.disposition, 'blocked');
  assert.equal(result.error.code, 'mail_domain_removal_data_delete_dispatch_required');
  assert.equal(result.sideEffects, false);
  assert.equal(state.calls.enqueue.length, 0);
  assert.equal(state.calls.deletedMailboxes.length, 0);
});

test('exact completed delete plus absent live data advances to finalizing', async () => {
  const backupId = 'mail-backup-job-1';
  const deleteId = 'mail-delete-job-1';
  const state = fixture({
    currentData: dataSnapshot({
      present: false,
      bytes: 0,
      snapshotSha256: '9'.repeat(64),
    }),
    getJobs: new Map([[deleteId, deleteJob(deleteId, backupId)]]),
  });
  const current = operation({
    status: 'deleting_data',
    backupId,
    dataDeleteJobId: deleteId,
  });

  const result = await state.phase.inspect(current);

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'finalizing');
  assert.equal(result.sideEffects, false);
  assert.equal(result.evidence.dataDeleteJobId, deleteId);
  assert.equal(state.calls.enqueue.length, 0);
});

test('mailbox revision drift fails before credential or data mutation', async () => {
  const pinned = {
    id: '52345678-1234-4234-8234-123456789012',
    address: 'admin@example.com',
    enabled: true,
    revision: 3,
    updatedAt: '2026-09-19T08:10:00.000Z',
  };
  const state = fixture({
    currentMailboxes: [{
      ...pinned,
      mailDomainId,
      revision: 4,
    }],
  });
  const current = operation({
    status: 'deleting_data',
    backupId: 'mail-backup-job-1',
    cleanupPlan: {
      ...operation().cleanupPlan,
      mailboxes: [pinned],
    },
  });

  const result = await state.phase.execute(current);

  assert.equal(result.disposition, 'failed');
  assert.equal(result.error.code, 'mail_domain_removal_mailbox_drift');
  assert.equal(state.calls.deletedMailboxes.length, 0);
  assert.equal(state.calls.enqueue.length, 0);
});

test('idempotency identities remain operation-scoped and separate backup from delete', () => {
  const current = operation();
  assert.equal(
    mailDomainRemovalDataPhaseInternals.backupIdempotencyKey(current),
    'mail-domain-remove-backup:' + operationId,
  );
  assert.equal(
    mailDomainRemovalDataPhaseInternals.deleteIdempotencyKey(current),
    'mail-domain-remove-data:' + operationId,
  );
});
