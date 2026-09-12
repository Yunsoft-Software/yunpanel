import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailConfigurationService } from '../src/mail-configuration.js';

const HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 31).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 32).toString('base64').replace(/=+$/, '')}`;

function fixture() {
  const domain = {
    id: 'mail-domain-1',
    domainName: 'example.com',
    managementMode: 'local',
    status: 'enabled',
    revision: 3,
  };
  const mailbox = {
    id: 'mailbox-1',
    mailDomainId: domain.id,
    address: 'owner@example.com',
    enabled: true,
  };
  let forwardings = [{
    mailboxId: mailbox.id,
    source: mailbox.address,
    mode: 'copy',
    destinations: ['backup@elsewhere.test'],
  }];
  const service = createMailConfigurationService({
    mailDomainRegistry: {
      getMailDomain: async () => ({ ...domain }),
      listMailDomains: async () => [{ ...domain }],
    },
    mailboxRegistry: {
      listMailboxes: async () => [{ ...mailbox }],
      materializeEnabledAccounts: async () => [{ address: mailbox.address, passwordHash: HASH }],
    },
    mailAliasRegistry: { materializeEnabledAliases: async () => [] },
    mailboxQuotaRegistry: { listQuotas: async () => [] },
    mailboxForwardingRegistry: {
      materializeEnabledForwardings: async () => forwardings.map((policy) => ({
        ...policy,
        destinations: [...policy.destinations],
      })),
    },
  });
  return {
    service,
    setForwardings(value) { forwardings = value; },
    disableMailbox() { mailbox.enabled = false; },
  };
}

const transition = Object.freeze({
  mailDomainId: 'mail-domain-1',
  expectedRevision: 3,
  status: 'enabled',
});

test('mail configuration digest and counts change with enabled mailbox forwarding state', async () => {
  const state = fixture();
  const first = await state.service.previewTransition(transition);
  state.setForwardings([{
    mailboxId: 'mailbox-1',
    source: 'owner@example.com',
    mode: 'redirect',
    destinations: ['other@elsewhere.test'],
  }]);
  const second = await state.service.previewTransition(transition);

  assert.equal(first.readyToApply, true);
  assert.equal(first.configuration.counts.forwardings, 1);
  assert.equal(first.configuration.artifactDigests.some((artifact) => artifact.path === '/etc/dovecot/yunpanel-forwarding.sieve'), true);
  assert.equal(first.configuration.requirements.includes('dovecot_sieve'), true);
  assert.notEqual(first.configurationSha256, second.configurationSha256);
  assert.notEqual(first.previewDigest, second.previewDigest);
  assert.doesNotMatch(JSON.stringify(first), /backup@elsewhere\.test|redirect :copy/);
});

test('forwarding change after preview is rejected before host materialization', async () => {
  const state = fixture();
  const preview = await state.service.previewTransition(transition);
  state.setForwardings([]);

  await assert.rejects(
    state.service.materializeTransition(transition, {
      expectedPreviewDigest: preview.previewDigest,
      expectedConfigurationSha256: preview.configurationSha256,
    }),
    { code: 'mail_configuration_preview_stale', status: 409 },
  );
});

test('forwarding policy for a disabled mailbox is excluded from the active Sieve configuration', async () => {
  const state = fixture();
  state.disableMailbox();
  const preview = await state.service.previewTransition(transition);
  assert.equal(preview.readyToApply, false);
  assert.deepEqual(preview.blockers, ['mail_postmaster_mailbox_required']);
});

test('forwarding source identity mismatch fails closed', async () => {
  const state = fixture();
  state.setForwardings([{
    mailboxId: 'mailbox-1',
    source: 'other@example.com',
    mode: 'copy',
    destinations: ['backup@elsewhere.test'],
  }]);
  await assert.rejects(
    state.service.previewTransition(transition),
    { code: 'mail_configuration_forwarding_mismatch', status: 409 },
  );
});
