import assert from 'node:assert/strict';
import test from 'node:test';
import { mailSubmissionTemplatePolicy } from '@yunpanel/config-templates';
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
  assert.deepEqual(preview.configuration.postfixMasterServices, [mailSubmissionTemplatePolicy.service]);
  assert.equal(
    preview.configuration.artifactDigests.some((artifact) => artifact.path === mailSubmissionTemplatePolicy.senderLoginPath),
    true,
  );
});
