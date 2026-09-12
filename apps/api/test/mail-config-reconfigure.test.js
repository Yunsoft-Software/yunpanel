import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailConfigurationService } from '../src/mail-configuration.js';

const HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 5).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 6).toString('base64').replace(/=+$/, '')}`;

function serviceFor(status = 'enabled') {
  const domain = {
    id: 'mail-domain-1',
    domainName: 'example.com',
    managementMode: 'local',
    status,
    revision: 4,
  };
  return createMailConfigurationService({
    mailDomainRegistry: {
      getMailDomain: async (id) => id === domain.id ? { ...domain } : null,
      listMailDomains: async () => [{ ...domain }],
    },
    mailboxRegistry: {
      listMailboxes: async () => [{
        id: 'mailbox-1',
        mailDomainId: domain.id,
        address: 'owner@example.com',
        enabled: true,
      }],
      materializeEnabledAccounts: async () => [{ address: 'owner@example.com', passwordHash: HASH }],
    },
    mailAliasRegistry: {
      materializeEnabledAliases: async () => [{
        source: 'info@example.com',
        destinations: ['owner@example.com'],
      }],
    },
  });
}

test('enabled managed mail domain can preview an in-place configuration refresh', async () => {
  const service = serviceFor('enabled');
  const preview = await service.previewTransition({
    mailDomainId: 'mail-domain-1',
    expectedRevision: 4,
    status: 'enabled',
  });

  assert.equal(preview.currentStatus, 'enabled');
  assert.equal(preview.desiredStatus, 'enabled');
  assert.equal(preview.expectedRevision, 4);
  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.domains, ['example.com']);
  assert.equal(preview.configuration.counts.aliases, 1);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.configurationSha256, /^[a-f0-9]{64}$/);
});

test('disabled to disabled remains a rejected no-op', async () => {
  const service = serviceFor('disabled');
  await assert.rejects(
    service.previewTransition({
      mailDomainId: 'mail-domain-1',
      expectedRevision: 4,
      status: 'disabled',
    }),
    { code: 'mail_domain_status_no_change', status: 409 },
  );
});
