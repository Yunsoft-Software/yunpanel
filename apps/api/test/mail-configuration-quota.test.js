import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailConfigurationService } from '../src/mail-configuration.js';

const HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 21).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 22).toString('base64').replace(/=+$/, '')}`;

function fixture(initialQuotaBytes = 100 * 1024 * 1024) {
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
  let quotaBytes = initialQuotaBytes;
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
    mailboxQuotaRegistry: {
      listQuotas: async () => quotaBytes === null ? [] : [{ mailboxId: mailbox.id, quotaBytes }],
    },
  });
  return { service, setQuota(value) { quotaBytes = value; } };
}

const transition = Object.freeze({
  mailDomainId: 'mail-domain-1',
  expectedRevision: 3,
  status: 'enabled',
});

test('mail configuration digest changes when mailbox quota policy changes', async () => {
  const state = fixture();
  const first = await state.service.previewTransition(transition);
  state.setQuota(200 * 1024 * 1024);
  const second = await state.service.previewTransition(transition);

  assert.equal(first.readyToApply, true);
  assert.equal(second.readyToApply, true);
  assert.notEqual(first.configurationSha256, second.configurationSha256);
  assert.notEqual(first.previewDigest, second.previewDigest);
  assert.equal(first.configuration.counts.mailboxes, 1);
});

test('quota change after preview is rejected before protected materialization', async () => {
  const state = fixture();
  const preview = await state.service.previewTransition(transition);
  state.setQuota(300 * 1024 * 1024);

  await assert.rejects(
    state.service.materializeTransition(transition, {
      expectedPreviewDigest: preview.previewDigest,
      expectedConfigurationSha256: preview.configurationSha256,
    }),
    { code: 'mail_configuration_preview_stale', status: 409 },
  );
});

test('quota-aware protected passwd material stays private while matching preview digest', async () => {
  const state = fixture(150 * 1024 * 1024);
  const preview = await state.service.previewTransition(transition);
  const materialized = await state.service.materializeTransition(transition, {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configurationSha256,
  });

  assert.equal(materialized.sensitiveArtifacts.length, 1);
  assert.match(materialized.sensitiveArtifacts[0].content, /userdb_quota_rule=\*:bytes=157286400/);
  assert.doesNotMatch(JSON.stringify(preview), /userdb_quota_rule|argon2id/i);
});
