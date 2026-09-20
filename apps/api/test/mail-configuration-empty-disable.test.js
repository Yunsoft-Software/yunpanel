import assert from 'node:assert/strict';
import test from 'node:test';
import { mailSqlTemplatePolicy, mailSubmissionTemplatePolicy } from '@yunpanel/config-templates';
import { createMailConfigurationService } from '../src/mail-configuration.js';

const accountHash = ['$argon2id', 'v=19', 'm=65536,t=3,p=1', Buffer.alloc(16, 5).toString('base64').replace(/=+$/, ''), Buffer.alloc(32, 6).toString('base64').replace(/=+$/, '')].join('$');

test('disabling the only enabled local mail domain keeps deterministic submission teardown state', async () => {
  const domain = { id: 'mail-domain-0001', domainName: 'example.com', managementMode: 'local', status: 'enabled', revision: 1 };
  const service = createMailConfigurationService({
    mailDomainRegistry: {
      getMailDomain: async () => domain,
      listMailDomains: async () => [domain],
    },
    mailboxRegistry: {
      listMailboxes: async () => [{ id: 'mailbox-1', mailDomainId: domain.id, address: 'owner@example.com', enabled: true }],
      materializeEnabledAccounts: async () => [{ address: 'owner@example.com', passwordHash: accountHash }],
    },
    mailAliasRegistry: { materializeEnabledAliases: async () => [] },
  });

  const preview = await service.previewTransition({ mailDomainId: domain.id, expectedRevision: 1, status: 'disabled' });
  assert.equal(preview.readyToApply, true);
  assert.equal(preview.configuration !== null, true);
  assert.deepEqual(preview.blockers, []);
  assert.deepEqual(preview.configuration.postfixMasterServices, mailSubmissionTemplatePolicy.services.map((service) => ({
    ...service,
    parameters: service.parameters.map((parameter) => parameter.name === 'smtpd_sender_login_maps'
      ? { ...parameter, value: `proxy:sqlite:${mailSqlTemplatePolicy.postfixSenderLoginPath}` }
      : parameter),
  })));
  assert.equal(
    preview.configuration.artifactDigests.some((artifact) => artifact.path === mailSqlTemplatePolicy.postfixSenderLoginPath),
    true,
  );
});

test('disabling mail domain is blocked when Roundcube webmail mapping is active or in flight', async () => {
  const domain = { id: 'mail-domain-0001', domainName: 'example.com', managementMode: 'local', status: 'enabled', revision: 1 };
  for (const state of ['active', 'pending', 'removing']) {
    const service = createMailConfigurationService({
      mailDomainRegistry: {
        getMailDomain: async () => domain,
        listMailDomains: async () => [domain],
      },
      mailboxRegistry: {
        listMailboxes: async () => [{ id: 'mailbox-1', mailDomainId: domain.id, address: 'owner@example.com', enabled: true }],
        materializeEnabledAccounts: async () => [{ address: 'owner@example.com', passwordHash: accountHash }],
      },
      mailAliasRegistry: { materializeEnabledAliases: async () => [] },
      roundcubeDomainMappingRegistry: {
        getRecordForMailDomain: async (id) => (id === domain.id ? { id: 'mapping-1', mailDomainId: id, state } : null),
      },
    });

    const preview = await service.previewTransition({ mailDomainId: domain.id, expectedRevision: 1, status: 'disabled' });
    assert.equal(preview.readyToApply, false);
    assert.equal(preview.configuration, null);
    assert.deepEqual(preview.blockers, ['mail_domain_webmail_mapping_active']);

    await assert.rejects(
      service.materializeTransition(
        { mailDomainId: domain.id, expectedRevision: 1, status: 'disabled' },
        { expectedPreviewDigest: preview.previewDigest, expectedConfigurationSha256: 'a'.repeat(64) },
      ),
      (error) => error.name === 'MailConfigurationError' && error.code === 'mail_configuration_not_ready',
    );
  }
});

test('disabling mail domain is allowed once Roundcube webmail mapping is removed', async () => {
  const domain = { id: 'mail-domain-0001', domainName: 'example.com', managementMode: 'local', status: 'enabled', revision: 1 };
  const service = createMailConfigurationService({
    mailDomainRegistry: {
      getMailDomain: async () => domain,
      listMailDomains: async () => [domain],
    },
    mailboxRegistry: {
      listMailboxes: async () => [{ id: 'mailbox-1', mailDomainId: domain.id, address: 'owner@example.com', enabled: true }],
      materializeEnabledAccounts: async () => [{ address: 'owner@example.com', passwordHash: accountHash }],
    },
    mailAliasRegistry: { materializeEnabledAliases: async () => [] },
    roundcubeDomainMappingRegistry: {
      getRecordForMailDomain: async (id) => (id === domain.id ? { id: 'mapping-1', mailDomainId: id, state: 'removed' } : null),
    },
  });

  const preview = await service.previewTransition({ mailDomainId: domain.id, expectedRevision: 1, status: 'disabled' });
  assert.equal(preview.readyToApply, true);
  assert.equal(preview.configuration !== null, true);
  assert.deepEqual(preview.blockers, []);
});
