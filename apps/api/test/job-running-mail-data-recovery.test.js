import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  JobRunningMailDataRecoveryError,
  recoverRunningMailData,
} from '../src/job-running-mail-data-recovery.js';

const serverId = randomUUID();
const mailDomainId = randomUUID();
const mailboxId = randomUUID();
const jobId = randomUUID();
const snapshot = 'a'.repeat(64);
const content = 'b'.repeat(64);

function base({ operation = OPERATIONS.MAIL_DATA_BACKUP, mailboxRevision = 3, domainStatus = 'disabled' } = {}) {
  const payload = operation === OPERATIONS.MAIL_DATA_BACKUP ? {
    mailDomainId,
    resourceId: mailboxId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedResourceRevision: 3,
    expectedSnapshotSha256: snapshot,
  } : {
    mailDomainId,
    resourceId: mailboxId,
    backupId: 'mail-backup-selected',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedResourceRevision: 3,
    expectedTargetSnapshotSha256: snapshot,
  };
  const calls = [];
  const result = operation === OPERATIONS.MAIL_DATA_BACKUP ? {
    version: 1,
    backupId: jobId,
    mailDomainId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    sourcePresent: true,
    sourceSnapshotSha256: snapshot,
    contentSha256: content,
    bytes: 100,
    files: 2,
    directories: 3,
    backedUp: true,
    sideEffects: true,
  } : {
    version: 1,
    transactionId: jobId,
    backupId: 'mail-backup-selected',
    preRestoreBackupId: `pre-restore:${jobId}`,
    mailDomainId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    contentSha256: content,
    bytes: 100,
    files: 2,
    directories: 3,
    restoredPresent: true,
    applied: true,
    sideEffects: true,
  };
  const receipt = {
    version: 1,
    recordedAt: '2026-09-13T01:30:00.000Z',
    serverId,
    jobId,
    operation,
    ...result,
  };
  return {
    calls,
    payload,
    result,
    receipt,
    dependencies: {
      serverId,
      jobId,
      jobRegistry: {
        async getJob(id) {
          assert.equal(id, jobId);
          return { id: jobId, serverId, status: 'running', operation, resourceType: 'mail_domain', resourceId: mailDomainId, payload };
        },
        async beginReconciliation(identity) {
          calls.push(['begin', identity]);
          return { ...identity, status: 'running', pending: true };
        },
        async complete(input) {
          calls.push(['complete', input]);
          return { id: jobId, serverId, status: 'succeeded', operation, resourceType: 'mail_domain', resourceId: mailDomainId, result: input.result };
        },
        async acknowledgeReconciliation(identity) {
          calls.push(['ack', identity]);
          return { ...identity, status: 'succeeded', acknowledged: true };
        },
      },
      domainRegistry: {},
      certificateRegistry: {},
      applicationRegistry: {},
      mailDomainRegistry: {
        async getMailDomain(id) {
          assert.equal(id, mailDomainId);
          return {
            id: mailDomainId,
            domainName: 'example.com',
            managementMode: 'local',
            status: domainStatus,
            revision: 5,
          };
        },
      },
      mailboxRegistry: {
        async getMailbox(id) {
          assert.equal(id, mailboxId);
          return { id: mailboxId, mailDomainId, address: 'owner@example.com', revision: mailboxRevision, enabled: false };
        },
      },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      loadJobContext: async () => ({
        id: jobId,
        serverId,
        status: 'running',
        operation,
        resourceType: 'mail_domain',
        resourceId: mailDomainId,
        payload,
      }),
      readOperationReceipt: async () => receipt,
      inspect: async () => ({
        jobs: [{ jobId, serverId, status: 'running', operation, resourceType: 'mail_domain', resourceId: mailDomainId }],
      }),
      reconcile: async ({ job }) => {
        calls.push(['reconcile', job.operation]);
        return { reconciled: true, error: null };
      },
    },
  };
}

test('running mail data backup closes only from matching receipt and verified backup manifest', async () => {
  const state = base();
  state.dependencies.inspectBackup = async (id) => {
    assert.equal(id, jobId);
    return {
      version: 1,
      backupId: jobId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      sourcePresent: true,
      sourceSnapshotSha256: snapshot,
      contentSha256: content,
      bytes: 100,
      files: 2,
      directories: 3,
    };
  };
  state.dependencies.inspectRestored = async () => { throw new Error('not used'); };

  const recovered = await recoverRunningMailData(state.dependencies);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.operation, OPERATIONS.MAIL_DATA_BACKUP);
  assert.equal(recovered.recoveryMethod, 'verified_mail_data_backup_receipt_and_manifest');
  const completion = state.calls.find(([name]) => name === 'complete')[1];
  assert.deepEqual(completion.result, state.result);
});

test('running mail data restore requires selected backup, pre-restore backup and live restored evidence', async () => {
  const state = base({ operation: OPERATIONS.MAIL_DATA_RESTORE });
  state.dependencies.inspectBackup = async (id) => {
    if (id === 'mail-backup-selected') {
      return {
        backupId: id,
        scope: 'mailbox',
        identity: 'owner@example.com',
        sourcePresent: true,
        sourceSnapshotSha256: 'c'.repeat(64),
        contentSha256: content,
        bytes: 100,
        files: 2,
        directories: 3,
      };
    }
    assert.equal(id, `pre-restore:${jobId}`);
    return {
      backupId: id,
      scope: 'mailbox',
      identity: 'owner@example.com',
      sourcePresent: true,
      sourceSnapshotSha256: snapshot,
      contentSha256: 'd'.repeat(64),
      bytes: 90,
      files: 1,
      directories: 3,
    };
  };
  state.dependencies.inspectRestored = async (input) => {
    assert.deepEqual(input, { backupId: 'mail-backup-selected', scope: 'mailbox', identity: 'owner@example.com' });
    return {
      satisfied: true,
      result: {
        version: 1,
        backupId: 'mail-backup-selected',
        scope: 'mailbox',
        identity: 'owner@example.com',
        contentSha256: content,
        bytes: 100,
        files: 2,
        directories: 3,
        restoredPresent: true,
        applied: true,
        sideEffects: true,
      },
    };
  };

  const recovered = await recoverRunningMailData(state.dependencies);
  assert.equal(recovered.operation, OPERATIONS.MAIL_DATA_RESTORE);
  assert.equal(recovered.recoveryMethod, 'verified_mail_data_restore_receipt_backup_and_live_state');
  const completion = state.calls.find(([name]) => name === 'complete')[1];
  assert.deepEqual(completion.result, state.result);
});

test('resource revision drift leaves running mail data job unresolved before evidence completion', async () => {
  const state = base({ mailboxRevision: 4 });
  let evidenceRead = false;
  state.dependencies.inspectBackup = async () => { evidenceRead = true; return null; };
  state.dependencies.inspectRestored = async () => { evidenceRead = true; return null; };

  await assert.rejects(
    recoverRunningMailData(state.dependencies),
    (error) => error instanceof JobRunningMailDataRecoveryError
      && error.code === 'job_mail_data_recovery_resource_mismatch',
  );
  assert.equal(evidenceRead, false);
  assert.equal(state.calls.some(([name]) => name === 'complete'), false);
});