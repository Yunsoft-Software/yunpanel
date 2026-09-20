import assert from 'node:assert/strict';
import test from 'node:test';
import { mailSqlTemplatePolicy, mailSubmissionTemplatePolicy } from '@yunpanel/config-templates';
import { createMailConfigurationService } from '../src/mail-configuration.js';

function fixtureHash() {
  const salt = Buffer.alloc(16, 7).toString('base64').replace(/=+$/, '');
  const hash = Buffer.alloc(32, 9).toString('base64').replace(/=+$/, '');
  return ['$argon2id', 'v=19', 'm=65536,t=3,p=1', salt, hash].join('$');
}

function createFixture() {
  const mailDomain = {
    id: 'mail-domain-0001',
    domainName: 'example.com',
    managementMode: 'local',
    status: 'enabled',
    revision: 1,
  };
  const account = { address: 'owner@example.com', passwordHash: fixtureHash() };
  const service = createMailConfigurationService({
    mailDomainRegistry: {
      getMailDomain: async () => mailDomain,
      listMailDomains: async () => [mailDomain],
    },
    mailboxRegistry: {
      listMailboxes: async () => [{
        id: 'mailbox-1',
        mailDomainId: mailDomain.id,
        address: account.address,
        enabled: true,
      }],
      materializeEnabledAccounts: async () => [account],
    },
    mailAliasRegistry: { materializeEnabledAliases: async () => [] },
  });
  return { service };
}

test('last enabled mail domain produces an applyable empty submission-aware managed-set preview', async () => {
  const { service } = createFixture();
  const transition = { mailDomainId: 'mail-domain-0001', expectedRevision: 1, status: 'disabled' };
  const preview = await service.previewTransition(transition);

  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.domains, []);
  assert.deepEqual(preview.blockers, []);
  assert.deepEqual(preview.configuration.counts, { domains: 0, mailboxes: 0, aliases: 0, forwardings: 0 });
  assert.equal(preview.configuration.postfixMasterServices.length, 2);
  for (const service of preview.configuration.postfixMasterServices) {
    assert.equal(
      service.parameters.find(
        (parameter) => parameter.name === 'smtpd_sender_login_maps',
      ).value,
      'proxy:sqlite:' + mailSqlTemplatePolicy.postfixSenderLoginPath,
    );
  }
  assert.equal(
    preview.configuration.artifactDigests.some((artifact) => artifact.path === mailSqlTemplatePolicy.seedPath),
    true,
  );
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.configurationSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(preview), /argon2|passwordHash/i);
});

test('empty managed-set private materialization writes a zero-row SQLite seed', async () => {
  const { service } = createFixture();
  const transition = { mailDomainId: 'mail-domain-0001', expectedRevision: 1, status: 'disabled' };
  const preview = await service.previewTransition(transition);
  const bundle = await service.materializeTransition(transition, {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configurationSha256,
  });

  assert.deepEqual(bundle.transition, {
    mailDomainId: 'mail-domain-0001',
    previousRevision: 1,
    previousStatus: 'enabled',
    desiredStatus: 'disabled',
  });
  assert.equal(bundle.preview.sha256, preview.configurationSha256);
  assert.equal(bundle.sensitiveArtifacts.length, 1);
  assert.equal(bundle.sensitiveArtifacts[0].path, mailSqlTemplatePolicy.seedPath);
  assert.match(bundle.sensitiveArtifacts[0].content, /DELETE FROM virtual_mailboxes;/);
  assert.doesNotMatch(bundle.sensitiveArtifacts[0].content, /INSERT INTO virtual_mailboxes/);
  assert.equal(bundle.preview.requirements.includes('mail_sqlite'), true);
});
