import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createMailDeleteFinalizeService,
  MailDeleteFinalizeError,
} from '../src/mail-delete-finalize.js';

const mailDomainId = randomUUID();
const mailboxId = randomUUID();
const deleteJobId = randomUUID();

function fixture({ mailboxRevision = 3, domainRevision = 5, impactBlocked = false, resultResourceId = mailboxId } = {}) {
  const calls = [];
  const mailbox = {
    id: mailboxId,
    mailDomainId,
    address: 'owner@example.com',
    enabled: false,
    revision: mailboxRevision,
  };
  const mailDomain = {
    id: mailDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: 'disabled',
    revision: domainRevision,
  };
  const job = {
    id: deleteJobId,
    status: 'succeeded',
    operation: OPERATIONS.MAIL_DATA_DELETE,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    result: {
      version: 1,
      transactionId: deleteJobId,
      backupId: 'mail-backup-0001',
      mailDomainId,
      resourceId: resultResourceId,
      expectedResourceRevision: mailboxRevision,
      scope: 'mailbox',
      identity: 'owner@example.com',
      sourcePresent: true,
      contentSha256: 'a'.repeat(64),
      bytes: 100,
      files: 2,
      directories: 3,
      deleted: true,
      sideEffects: true,
    },
  };
  const service = createMailDeleteFinalizeService({
    mailboxRegistry: {
      async getMailbox(id) { return id === mailboxId ? mailbox : null; },
      async deleteMailbox(id, input) { calls.push(['deleteMailbox', id, structuredClone(input)]); },
    },
    mailDomainRegistry: {
      async getMailDomain(id) { return id === mailDomainId ? mailDomain : null; },
      async deleteMailDomain(id, input) { calls.push(['deleteMailDomain', id, structuredClone(input)]); },
    },
    mailDeleteImpactService: {
      async inspectMailbox(id) {
        calls.push(['impactMailbox', id]);
        return {
          resourceType: 'mailbox',
          resourceId: mailboxId,
          revision: mailboxRevision,
          safeToDelete: !impactBlocked,
          blockers: impactBlocked ? [{ code: 'mailbox_alias_reference_configured', count: 1 }] : [],
          mailData: { present: false },
          requiresDataBackup: false,
          confirmation: 'delete-mailbox:owner@example.com',
        };
      },
      async inspectMailDomain(id) {
        calls.push(['impactDomain', id]);
        return {
          resourceType: 'mail_domain',
          resourceId: mailDomainId,
          revision: domainRevision,
          safeToDelete: !impactBlocked,
          blockers: impactBlocked ? [{ code: 'mail_domain_dkim_key_exists', count: 1 }] : [],
          mailData: { present: false },
          requiresDataBackup: false,
          confirmation: `delete-mail-domain:${mailDomainId}:${domainRevision}`,
        };
      },
    },
    jobRegistry: {
      async getJob(id) { calls.push(['job', id]); return id === deleteJobId ? job : null; },
    },
  });
  return { service, calls, job };
}

test('mailbox finalization requires matching terminal delete job and fresh clear impact', async () => {
  const state = fixture();
  const result = await state.service.finalizeMailbox({
    mailboxId,
    expectedRevision: 3,
    deleteJobId,
    confirmation: 'delete-mailbox:owner@example.com',
  });
  assert.deepEqual(result, {
    id: mailboxId,
    resourceType: 'mailbox',
    deleted: true,
    deleteJobId,
    backupId: 'mail-backup-0001',
  });
  assert.deepEqual(state.calls.at(-1), [
    'deleteMailbox',
    mailboxId,
    { expectedRevision: 3, confirmation: 'delete-mailbox:owner@example.com' },
  ]);
});

test('mail-domain finalization uses revisioned typed confirmation after data is absent', async () => {
  const state = fixture({ resultResourceId: mailDomainId });
  Object.assign(state.job.result, {
    resourceId: mailDomainId,
    expectedResourceRevision: 5,
    scope: 'domain',
    identity: 'example.com',
  });
  const confirmation = `delete-mail-domain:${mailDomainId}:5`;
  const result = await state.service.finalizeMailDomain({
    mailDomainId,
    expectedRevision: 5,
    deleteJobId,
    confirmation,
  });
  assert.equal(result.deleted, true);
  assert.deepEqual(state.calls.at(-1), [
    'deleteMailDomain',
    mailDomainId,
    { expectedRevision: 5, confirmation },
  ]);
});

test('revision drift or mismatched terminal job cannot finalize deletion', async () => {
  const stale = fixture({ mailboxRevision: 4 });
  await assert.rejects(
    stale.service.finalizeMailbox({
      mailboxId,
      expectedRevision: 4,
      deleteJobId,
      confirmation: 'delete-mailbox:owner@example.com',
    }),
    (error) => error instanceof MailDeleteFinalizeError && error.code === 'mail_delete_job_mismatch',
  );
  assert.equal(stale.calls.some(([name]) => name === 'deleteMailbox'), false);

  const wrongResource = fixture({ resultResourceId: randomUUID() });
  await assert.rejects(
    wrongResource.service.finalizeMailbox({
      mailboxId,
      expectedRevision: 3,
      deleteJobId,
      confirmation: 'delete-mailbox:owner@example.com',
    }),
    (error) => error instanceof MailDeleteFinalizeError && error.code === 'mail_delete_job_mismatch',
  );
  assert.equal(wrongResource.calls.some(([name]) => name === 'deleteMailbox'), false);
});

test('fresh dependency impact blocks finalization even after host data delete succeeded', async () => {
  const state = fixture({ impactBlocked: true });
  await assert.rejects(
    state.service.finalizeMailbox({
      mailboxId,
      expectedRevision: 3,
      deleteJobId,
      confirmation: 'delete-mailbox:owner@example.com',
    }),
    (error) => error instanceof MailDeleteFinalizeError && error.code === 'mail_delete_impact_not_clear',
  );
  assert.equal(state.calls.some(([name]) => name === 'deleteMailbox'), false);
});
