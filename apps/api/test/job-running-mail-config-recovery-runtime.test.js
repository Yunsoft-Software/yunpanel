import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningMailConfigRecoveryFromStores } from '../src/job-running-mail-config-recovery-runtime.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const hostname = 'host-1';
const mailDomainId = '87654321-1234-4234-8234-123456789012';
const digest = 'a'.repeat(64);

function resourceFactory(label, calls, extra = {}) {
  return ({ filePath }) => ({
    async init() { calls.push([`${label}.init`, filePath]); },
    ...extra,
  });
}

test('managed mail recovery runtime wires private registries, tls identity, receipt, materialization and active evidence', async () => {
  const calls = [];
  const fakeJobRegistry = { marker: 'durable' };
  const fakeDomainRegistry = {
    async init() { calls.push(['domain.init', '/work/state/domains.json']); },
    async getDomain(id) { calls.push(['domain.get', id]); return { id, serverId }; },
  };
  const fakeCertificateRegistry = {
    async init() { calls.push(['certificate.init', '/work/state/certificates.json']); },
    async getCertificate(id) { calls.push(['certificate.get', id]); return { id }; },
  };
  const fakeMailServiceIdentityRegistry = {
    async init() { calls.push(['mail-service-identity.init', '/work/state/mail-service-identity.json']); },
    async materializeForServer(id) { calls.push(['mail-service-identity.materialize', id]); return { serverId: id }; },
  };
  const fakeMailDomainRegistry = {
    async init() { calls.push(['mail-domain.init', '/work/state/mail-domains.json']); },
    async getMailDomain(id) { calls.push(['mail-domain.get', id]); return { id }; },
  };
  const fakeMailboxRegistry = {
    async init() { calls.push(['mailbox.init', '/work/state/mailboxes.json']); },
    async getMailbox(id) { calls.push(['mailbox.get', id]); return { id }; },
    async listMailboxes(filter) { calls.push(['mailbox.list', filter]); return []; },
  };
  const fakeMailboxQuotaRegistry = {
    async init() { calls.push(['mailbox-quota.init', '/work/state/mailbox-quotas.json']); },
  };
  const fakeMailboxForwardingRegistry = {
    async init() { calls.push(['mailbox-forwarding.init', '/work/state/mailbox-forwardings.json']); },
  };
  const fakeMailAliasRegistry = {
    async init() { calls.push(['mail-alias.init', '/work/state/mail-aliases.json']); },
  };

  const result = await runRunningMailConfigRecoveryFromStores({
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
      YUNPANEL_MAIL_SERVICE_IDENTITY_STORE: '/work/state/mail-service-identity.json',
      YUNPANEL_MAILBOX_STORE: '/work/state/mailboxes.json',
      YUNPANEL_MAILBOX_QUOTA_STORE: '/work/state/mailbox-quotas.json',
      YUNPANEL_MAILBOX_FORWARDING_STORE: '/work/state/mailbox-forwardings.json',
      YUNPANEL_MAIL_ALIAS_STORE: '/work/state/mail-aliases.json',
      YUNPANEL_SECRET_MASTER_KEY: 'private-master-key',
    },
    cwd: '/',
    serverRegistryFactory: ({ filePath }) => ({
      async init() { calls.push(['server.init', filePath]); },
      async getServer(id) { calls.push(['server.get', id]); return { id, hostname }; },
    }),
    domainRegistryFactory: () => fakeDomainRegistry,
    certificateRegistryFactory: () => fakeCertificateRegistry,
    applicationRegistryFactory: resourceFactory('application', calls),
    mailServiceIdentityRegistryFactory: ({ filePath, getWebDomain, getCertificate }) => {
      calls.push(['mail-service-identity.create', filePath]);
      assert.equal(typeof getWebDomain, 'function');
      assert.equal(typeof getCertificate, 'function');
      return fakeMailServiceIdentityRegistry;
    },
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
    mailboxQuotaRegistryFactory: ({ filePath, getMailbox }) => {
      calls.push(['mailbox-quota.create', filePath]);
      assert.equal(typeof getMailbox, 'function');
      return fakeMailboxQuotaRegistry;
    },
    mailboxForwardingRegistryFactory: ({ filePath, getMailbox }) => {
      calls.push(['mailbox-forwarding.create', filePath]);
      assert.equal(typeof getMailbox, 'function');
      return fakeMailboxForwardingRegistry;
    },
    mailAliasRegistryFactory: ({ filePath, getMailDomain, listMailboxes }) => {
      calls.push(['mail-alias.create', filePath]);
      assert.equal(typeof getMailDomain, 'function');
      assert.equal(typeof listMailboxes, 'function');
      return fakeMailAliasRegistry;
    },
    jobRegistryFactory: () => ({}),
    recoveryStoreFactory: () => ({}),
    durableRegistryFactory: ({ filePath }) => { calls.push(['durable.create', filePath]); return fakeJobRegistry; },
    contextReaderFactory: ({ filePath }) => {
      calls.push(['context.create', filePath]);
      return { async read(id) { calls.push(['context.read', id]); return { id, payload: {} }; } };
    },
    receiptStoreFactory: () => ({
      async read(receiptServerId, receiptJobId) {
        calls.push(['receipt.read', receiptServerId, receiptJobId]);
        return { serverId: receiptServerId, jobId: receiptJobId };
      },
    }),
    evidenceInspectorFactory: () => ({
      async inspect(preview) { calls.push(['evidence.inspect', preview]); return { satisfied: true, result: {} }; },
    }),
    mailConfigurationServiceFactory: ({
      mailDomainRegistry,
      mailboxRegistry,
      mailboxQuotaRegistry,
      mailboxForwardingRegistry,
      mailAliasRegistry,
      domainRegistry,
      mailServiceIdentityRegistry,
    }) => {
      assert.equal(mailDomainRegistry, fakeMailDomainRegistry);
      assert.equal(mailboxRegistry, fakeMailboxRegistry);
      assert.equal(mailboxQuotaRegistry, fakeMailboxQuotaRegistry);
      assert.equal(mailboxForwardingRegistry, fakeMailboxForwardingRegistry);
      assert.equal(mailAliasRegistry, fakeMailAliasRegistry);
      assert.equal(domainRegistry, fakeDomainRegistry);
      assert.equal(mailServiceIdentityRegistry, fakeMailServiceIdentityRegistry);
      return {
        async materializeTransition(input, expected) {
          calls.push(['materialize', input, expected]);
          return { preview: { sha256: digest }, sensitiveArtifacts: [] };
        },
      };
    },
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    recoverCommand: async (input) => {
      assert.equal(input.jobRegistry, fakeJobRegistry);
      assert.equal(input.mailDomainRegistry, fakeMailDomainRegistry);
      assert.deepEqual(await input.readOperationReceipt(serverId, jobId), { serverId, jobId });
      assert.deepEqual(
        await input.materializeTransition(
          { mailDomainId, expectedRevision: 1, status: 'enabled' },
          { expectedPreviewDigest: digest, expectedConfigurationSha256: digest },
        ),
        { preview: { sha256: digest }, sensitiveArtifacts: [] },
      );
      assert.deepEqual(await input.inspectActiveEvidence({ sha256: digest }), { satisfied: true, result: {} });
      return {
        serverId,
        jobId,
        operation: 'mail.config.apply',
        status: 'succeeded',
        recoveryMethod: 'verified_mail_config_receipt_and_active_host_state',
        reconciled: true,
      };
    },
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.statePaths.mailDomainStore, '/work/state/mail-domains.json');
  assert.equal(result.statePaths.mailServiceIdentityStore, '/work/state/mail-service-identity.json');
  assert.equal(result.statePaths.mailboxStore, '/work/state/mailboxes.json');
  assert.equal(result.statePaths.mailboxQuotaStore, '/work/state/mailbox-quotas.json');
  assert.equal(result.statePaths.mailboxForwardingStore, '/work/state/mailbox-forwardings.json');
  assert.equal(result.statePaths.mailAliasStore, '/work/state/mail-aliases.json');
  assert.ok(calls.some((entry) => entry[0] === 'mail-service-identity.create'
    && entry[1] === '/work/state/mail-service-identity.json'));
  assert.ok(calls.some((entry) => entry[0] === 'mail-domain.create' && entry[1] === '/work/state/mail-domains.json'));
  assert.ok(calls.some((entry) => entry[0] === 'mailbox.create'
    && entry[1] === '/work/state/mailboxes.json' && entry[2] === 'private-master-key'));
  assert.ok(calls.some((entry) => entry[0] === 'mailbox-quota.create' && entry[1] === '/work/state/mailbox-quotas.json'));
  assert.ok(calls.some((entry) => entry[0] === 'mailbox-forwarding.create' && entry[1] === '/work/state/mailbox-forwardings.json'));
  assert.ok(calls.some((entry) => entry[0] === 'mail-alias.create' && entry[1] === '/work/state/mail-aliases.json'));
  assert.ok(calls.some(([name]) => name === 'receipt.read'));
  assert.ok(calls.some(([name]) => name === 'materialize'));
  assert.ok(calls.some(([name]) => name === 'evidence.inspect'));
});

test('managed mail recovery runtime rejects wrong host before opening protected mail state', async () => {
  let mailRegistries = 0;
  let receipts = 0;
  let evidence = 0;
  await assert.rejects(
    runRunningMailConfigRecoveryFromStores({
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
      mailServiceIdentityRegistryFactory: () => { mailRegistries += 1; return { async init() {} }; },
      mailDomainRegistryFactory: () => { mailRegistries += 1; return { async init() {} }; },
      mailboxRegistryFactory: () => { mailRegistries += 1; return { async init() {} }; },
      mailboxQuotaRegistryFactory: () => { mailRegistries += 1; return { async init() {} }; },
      mailboxForwardingRegistryFactory: () => { mailRegistries += 1; return { async init() {} }; },
      mailAliasRegistryFactory: () => { mailRegistries += 1; return { async init() {} }; },
      jobRegistryFactory: () => ({}),
      recoveryStoreFactory: () => ({}),
      durableRegistryFactory: () => ({}),
      contextReaderFactory: () => ({ read: async () => ({}) }),
      receiptStoreFactory: () => { receipts += 1; return { read: async () => ({}) }; },
      evidenceInspectorFactory: () => { evidence += 1; return { inspect: async () => ({}) }; },
      mailConfigurationServiceFactory: () => ({ materializeTransition: async () => ({}) }),
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      recoverCommand: async () => ({}),
    }),
    { code: 'job_recovery_server_hostname_mismatch' },
  );
  assert.equal(mailRegistries, 0);
  assert.equal(receipts, 0);
  assert.equal(evidence, 0);
});