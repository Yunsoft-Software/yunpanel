import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningMailDataRecoveryFromStores } from '../src/job-running-mail-data-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'host-1';

function resourceFactory(label, calls, extra = {}) {
  return ({ filePath }) => ({
    async init() { calls.push([`${label}.init`, filePath]); },
    ...extra,
  });
}

test('mail data recovery runtime reconstructs registries receipt backup restore and delete evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const fakeMailDomainRegistry = {
    async init() { calls.push(['mail-domain.init']); },
    async getMailDomain(id) { return { id, webDomainId: 'web-1', managementMode: 'local', status: 'disabled' }; },
  };
  const fakeMailboxRegistry = {
    async init() { calls.push(['mailbox.init']); },
    async getMailbox(id) { return { id, mailDomainId: 'mail-1', address: 'owner@example.com', revision: 3 }; },
  };
  const fakeBackupManager = {
    async inspectBackup(id) { calls.push(['backup.inspect', id]); return { backupId: id }; },
    async materializeBackup(id) { return { manifest: { backupId: id }, dataPath: '/private/backup' }; },
  };
  const fakeRestoreManager = {
    async inspectRestored(input) { calls.push(['restore.inspect', input]); return { satisfied: true, result: {} }; },
  };
  const fakeDeleteManager = {
    async inspectDeleted(input) { calls.push(['delete.inspect', input]); return { satisfied: true, result: {} }; },
  };

  const result = await runRunningMailDataRecoveryFromStores({
    serverId,
    jobId,
    hostname,
    env: {
      YUNPANEL_SERVER_STORE: '/work/state/servers.json',
      YUNPANEL_DOMAIN_STORE: '/work/state/domains.json',
      YUNPANEL_JOB_STORE: '/work/state/jobs.json',
      YUNPANEL_CERTIFICATE_STORE: '/work/state/certificates.json',
      YUNPANEL_APPLICATION_STORE: '/work/state/applications.json',
      YUNPANEL_MAIL_DOMAIN_STORE: '/work/state/mail-domains.json',
      YUNPANEL_MAILBOX_STORE: '/work/state/mailboxes.json',
      YUNPANEL_SECRET_MASTER_KEY: 'private-test-key',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { return { id, hostname }; },
    }),
    domainRegistryFactory: () => ({
      async init() { calls.push(['domain.init']); },
      async getDomain(id) { return { id, serverId, primaryDomain: 'example.com' }; },
    }),
    certificateRegistryFactory: resourceFactory('certificate', calls),
    applicationRegistryFactory: resourceFactory('application', calls),
    mailDomainRegistryFactory: ({ filePath, getWebDomain }) => {
      calls.push(['mail-domain.create', filePath]);
      assert.equal(typeof getWebDomain, 'function');
      return fakeMailDomainRegistry;
    },
    mailboxRegistryFactory: ({ filePath, masterKey, getMailDomain }) => {
      calls.push(['mailbox.create', filePath, masterKey]);
      assert.equal(typeof getMailDomain, 'function');
      return fakeMailboxRegistry;
    },
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => ({
      async read(id) { calls.push(['context.read', filePath, id]); return { id }; },
    }),
    receiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) {
        calls.push(['receipt.read', receiptServerId, receiptJobId]);
        return { serverId: receiptServerId, jobId: receiptJobId };
      },
    }),
    backupManagerFactory: () => fakeBackupManager,
    restoreManagerFactory: ({ backupManager }) => {
      assert.equal(backupManager, fakeBackupManager);
      return fakeRestoreManager;
    },
    deleteManagerFactory: ({ backupManager }) => {
      assert.equal(backupManager, fakeBackupManager);
      return fakeDeleteManager;
    },
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.equal(input.mailDomainRegistry, fakeMailDomainRegistry);
      assert.equal(input.mailboxRegistry, fakeMailboxRegistry);
      assert.deepEqual(await input.readOperationReceipt(serverId, jobId), { serverId, jobId });
      assert.deepEqual(await input.inspectBackup('backup-1'), { backupId: 'backup-1' });
      assert.deepEqual(
        await input.inspectRestored({ backupId: 'backup-1', scope: 'mailbox', identity: 'owner@example.com' }),
        { satisfied: true, result: {} },
      );
      assert.deepEqual(
        await input.inspectDeleted({ transactionId: jobId, backupId: 'backup-1', scope: 'mailbox', identity: 'owner@example.com' }),
        { satisfied: true, result: {} },
      );
      return {
        serverId,
        jobId,
        operation: 'mail.data.delete',
        status: 'succeeded',
        recoveryMethod: 'verified_mail_data_delete_receipt_backup_and_absence',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.statePaths.mailDomainStore, '/work/state/mail-domains.json');
  assert.equal(result.statePaths.mailboxStore, '/work/state/mailboxes.json');
  assert.ok(calls.some(([name]) => name === 'receipt.read'));
  assert.ok(calls.some(([name]) => name === 'backup.inspect'));
  assert.ok(calls.some(([name]) => name === 'restore.inspect'));
  assert.ok(calls.some(([name]) => name === 'delete.inspect'));
});

test('mail data recovery runtime rejects wrong host before opening protected mailbox state', async () => {
  let protectedState = 0;
  await assert.rejects(
    runRunningMailDataRecoveryFromStores({
      serverId,
      jobId,
      hostname,
      serverRegistryFactory: () => ({
        async init() {},
        async getServer() { return { id: serverId, hostname: 'other-host' }; },
      }),
      domainRegistryFactory: () => ({ async init() {} }),
      certificateRegistryFactory: () => ({ async init() {} }),
      applicationRegistryFactory: () => ({ async init() {} }),
      mailDomainRegistryFactory: () => { protectedState += 1; return { async init() {} }; },
      mailboxRegistryFactory: () => { protectedState += 1; return { async init() {} }; },
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => ({ read: async () => ({}) }),
      receiptStoreFactory: () => ({ read: async () => ({}) }),
      backupManagerFactory: () => ({ inspectBackup: async () => null, materializeBackup: async () => null }),
      restoreManagerFactory: () => ({ inspectRestored: async () => ({}) }),
      deleteManagerFactory: () => ({ inspectDeleted: async () => ({}) }),
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(protectedState, 0);
});