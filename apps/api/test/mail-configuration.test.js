import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailConfigurationService, MailConfigurationError } from '../src/mail-configuration.js';

const HASH_A = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')}`;
const HASH_B = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 3).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 4).toString('base64').replace(/=+$/, '')}`;

function fixture({ candidateStatus = 'disabled', candidateMode = 'local', accounts = null } = {}) {
  const candidate = {
    id: 'mail-domain-0001',
    domainName: 'example.com',
    managementMode: candidateMode,
    status: candidateStatus,
    revision: 1,
  };
  const domains = [candidate];
  let privateAccounts = accounts ?? [{ address: 'owner@example.com', passwordHash: HASH_A }];
  const mailboxRegistry = {
    listMailboxes: async () => privateAccounts.map((account, index) => ({
      id: `mailbox-${index}`,
      mailDomainId: candidate.id,
      address: account.address,
      enabled: true,
    })),
    materializeEnabledAccounts: async () => privateAccounts.map((account) => Object.freeze({ ...account })),
  };
  const service = createMailConfigurationService({
    mailDomainRegistry: {
      getMailDomain: async (id) => domains.find((domain) => domain.id === id) ?? null,
      listMailDomains: async () => domains.map((domain) => Object.freeze({ ...domain })),
    },
    mailboxRegistry,
  });
  return {
    candidate,
    service,
    setAccounts(next) { privateAccounts = next; },
  };
}

test('managed mail transition preview is deterministic and secret-free', async () => {
  const { service } = fixture();
  const preview = await service.previewTransition({
    mailDomainId: 'mail-domain-0001',
    expectedRevision: 1,
    status: 'enabled',
  });

  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.domains, ['example.com']);
  assert.equal(preview.currentStatus, 'disabled');
  assert.equal(preview.desiredStatus, 'enabled');
  assert.deepEqual(preview.blockers, []);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.configurationSha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.configuration.counts.mailboxes, 1);
  assert.equal(preview.configuration.artifactDigests.some((artifact) => artifact.sensitive), true);
  assert.equal(JSON.stringify(preview).includes(HASH_A), false);
  assert.equal(JSON.stringify(preview).includes('{ARGON2ID}'), false);
});

test('private transition materialization binds protected content to both preview digests', async () => {
  const state = fixture();
  const transition = {
    mailDomainId: 'mail-domain-0001',
    expectedRevision: 1,
    status: 'enabled',
  };
  const preview = await state.service.previewTransition(transition);
  const bundle = await state.service.materializeTransition(transition, {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configurationSha256,
  });

  assert.equal(bundle.preview.sha256, preview.configurationSha256);
  assert.equal(bundle.sensitiveArtifacts.length, 1);
  assert.equal(bundle.sensitiveArtifacts[0].path, '/etc/yunpanel/mail/dovecot/users');
  assert.equal(bundle.sensitiveArtifacts[0].content.includes(HASH_A), true);

  state.setAccounts([{ address: 'owner@example.com', passwordHash: HASH_B }]);
  await assert.rejects(
    state.service.materializeTransition(transition, {
      expectedPreviewDigest: preview.previewDigest,
      expectedConfigurationSha256: preview.configurationSha256,
    }),
    (error) => error instanceof MailConfigurationError
      && error.code === 'mail_configuration_preview_stale'
      && error.status === 409,
  );
});

test('managed mail transition reports blockers instead of fabricating an applyable config', async () => {
  const noMailbox = fixture({ accounts: [] });
  const enable = await noMailbox.service.previewTransition({
    mailDomainId: 'mail-domain-0001',
    expectedRevision: 1,
    status: 'enabled',
  });
  assert.equal(enable.readyToApply, false);
  assert.equal(enable.configuration, null);
  assert.deepEqual(enable.blockers, ['mail_postmaster_mailbox_required']);

  const enabled = fixture({ candidateStatus: 'enabled' });
  const disable = await enabled.service.previewTransition({
    mailDomainId: 'mail-domain-0001',
    expectedRevision: 1,
    status: 'disabled',
  });
  assert.equal(disable.readyToApply, false);
  assert.equal(disable.configuration, null);
  assert.deepEqual(disable.blockers, ['mail_configuration_empty_set_not_supported']);
});

test('external mail domains cannot produce a local configuration transition', async () => {
  const { service } = fixture({ candidateMode: 'external' });
  await assert.rejects(
    service.previewTransition({
      mailDomainId: 'mail-domain-0001',
      expectedRevision: 1,
      status: 'enabled',
    }),
    (error) => error instanceof MailConfigurationError
      && error.code === 'mail_domain_not_locally_managed'
      && error.status === 409,
  );
});
