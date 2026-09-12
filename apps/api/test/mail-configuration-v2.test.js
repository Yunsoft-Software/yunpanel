import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailConfigurationService, MailConfigurationError } from '../src/mail-configuration.js';

function phc(saltByte, hashByte) {
  return ['$argon2id', 'v=19', 'm=65536,t=3,p=1', Buffer.alloc(16, saltByte).toString('base64').replace(/=+$/, ''), Buffer.alloc(32, hashByte).toString('base64').replace(/=+$/, '')].join('$');
}

function fixture({ candidateStatus = 'disabled', candidateMode = 'local', accounts = null, aliases = null } = {}) {
  const candidate = { id: 'mail-domain-0001', domainName: 'example.com', managementMode: candidateMode, status: candidateStatus, revision: 1 };
  let privateAccounts = accounts ?? [{ address: 'owner@example.com', passwordHash: phc(1, 2) }];
  let enabledAliases = aliases ?? [];
  const service = createMailConfigurationService({
    mailDomainRegistry: {
      getMailDomain: async () => candidate,
      listMailDomains: async () => [candidate],
    },
    mailboxRegistry: {
      listMailboxes: async () => privateAccounts.map((account, index) => ({ id: `mailbox-${index}`, mailDomainId: candidate.id, address: account.address, enabled: true })),
      materializeEnabledAccounts: async () => privateAccounts.map((account) => ({ ...account })),
    },
    mailAliasRegistry: {
      materializeEnabledAliases: async () => enabledAliases.map((alias) => ({
        source: alias.source,
        destinations: [...alias.destinations],
      })),
    },
  });
  return {
    service,
    setAccounts: (next) => { privateAccounts = next; },
    setAliases: (next) => { enabledAliases = next; },
  };
}

test('managed mail enable preview stays secret-free and requires a postmaster mailbox', async () => {
  const enabled = fixture();
  const preview = await enabled.service.previewTransition({ mailDomainId: 'mail-domain-0001', expectedRevision: 1, status: 'enabled' });
  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.domains, ['example.com']);
  assert.deepEqual(preview.blockers, []);
  assert.doesNotMatch(JSON.stringify(preview), /argon2|passwordHash/i);

  const noMailbox = fixture({ accounts: [] });
  const blocked = await noMailbox.service.previewTransition({ mailDomainId: 'mail-domain-0001', expectedRevision: 1, status: 'enabled' });
  assert.equal(blocked.readyToApply, false);
  assert.equal(blocked.configuration, null);
  assert.deepEqual(blocked.blockers, ['mail_postmaster_mailbox_required']);
});

test('private enable materialization becomes stale when protected mailbox state changes', async () => {
  const state = fixture();
  const transition = { mailDomainId: 'mail-domain-0001', expectedRevision: 1, status: 'enabled' };
  const preview = await state.service.previewTransition(transition);
  state.setAccounts([{ address: 'owner@example.com', passwordHash: phc(3, 4) }]);
  await assert.rejects(
    state.service.materializeTransition(transition, {
      expectedPreviewDigest: preview.previewDigest,
      expectedConfigurationSha256: preview.configurationSha256,
    }),
    (error) => error instanceof MailConfigurationError && error.code === 'mail_configuration_preview_stale' && error.status === 409,
  );
});

test('enabled aliases enter Postfix preview and stale an older apply digest when forwarding changes', async () => {
  const state = fixture({
    aliases: [{ source: 'info@example.com', destinations: ['owner@example.com', 'external@elsewhere.test'] }],
  });
  const transition = { mailDomainId: 'mail-domain-0001', expectedRevision: 1, status: 'enabled' };
  const preview = await state.service.previewTransition(transition);
  assert.equal(preview.configuration.counts.aliases, 1);
  const aliasMap = preview.configuration.artifactDigests.find(
    (artifact) => artifact.path === '/etc/yunpanel/mail/postfix/virtual-aliases',
  );
  assert.match(aliasMap.sha256, /^[a-f0-9]{64}$/);

  state.setAliases([{ source: 'info@example.com', destinations: ['external@changed.test'] }]);
  await assert.rejects(
    state.service.materializeTransition(transition, {
      expectedPreviewDigest: preview.previewDigest,
      expectedConfigurationSha256: preview.configurationSha256,
    }),
    (error) => error instanceof MailConfigurationError && error.code === 'mail_configuration_preview_stale' && error.status === 409,
  );
});

test('last enabled managed mail domain disables through a zero-account private bundle', async () => {
  const state = fixture({
    candidateStatus: 'enabled',
    aliases: [{ source: 'info@example.com', destinations: ['external@elsewhere.test'] }],
  });
  const transition = { mailDomainId: 'mail-domain-0001', expectedRevision: 1, status: 'disabled' };
  const preview = await state.service.previewTransition(transition);

  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.domains, []);
  assert.deepEqual(preview.blockers, []);
  assert.deepEqual(preview.configuration.counts, { domains: 0, mailboxes: 0, aliases: 0 });
  assert.match(preview.configurationSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(preview), /argon2|passwordHash|dovecot-lmtp|postmaster_address/i);

  const bundle = await state.service.materializeTransition(transition, {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configurationSha256,
  });
  assert.equal(bundle.preview.sha256, preview.configurationSha256);
  assert.equal(bundle.sensitiveArtifacts.length, 1);
  assert.equal(bundle.sensitiveArtifacts[0].path, '/etc/yunpanel/mail/dovecot/users');
  assert.equal(bundle.sensitiveArtifacts[0].content, '');
  const dovecotMail = bundle.preview.artifacts.find((artifact) => artifact.path === '/etc/dovecot/conf.d/99-yunpanel-mail.conf');
  assert.match(dovecotMail.content, /^protocols = imap$/m);
  assert.doesNotMatch(dovecotMail.content, /lmtp|postmaster_address|dovecot-lmtp/i);
});

test('external mail domains remain excluded from local configuration transitions', async () => {
  const state = fixture({ candidateMode: 'external' });
  await assert.rejects(
    state.service.previewTransition({ mailDomainId: 'mail-domain-0001', expectedRevision: 1, status: 'enabled' }),
    (error) => error instanceof MailConfigurationError && error.code === 'mail_domain_not_locally_managed' && error.status === 409,
  );
});
