import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mailForwardingTemplatePolicy, mailSpamPolicyTemplatePolicy } from '@yunpanel/config-templates';
import { createDomainRegistry } from '../src/domains/domain-registry.js';
import { createMailAliasRegistry } from '../src/mail/mail-alias-registry.js';
import { createMailConfigurationService } from '../src/mail/mail-configuration.js';
import { createMailDomainRegistry } from '../src/mail/mail-domain-registry.js';
import { createMailboxRegistry } from '../src/mail/mailbox-registry.js';
import { createServerRegistry } from '../src/runtime/server-registry.js';

test('saved delivery rules alter the normal mail plan without exposing data and are removed from the active scope', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yunpanel-mail-delivery-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const servers = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  const server = await servers.createLocalServer({ hostname: 'mail-pilot.example.test' });
  const domains = createDomainRegistry({
    filePath: path.join(root, 'domains.json'),
    serverExists: async (id) => Boolean(await servers.getServer(id)),
  });
  const mailDomainRegistry = createMailDomainRegistry({
    filePath: path.join(root, 'mail-domains.json'),
    getWebDomain: domains.getDomain,
  });
  const mailboxRegistry = createMailboxRegistry({
    filePath: path.join(root, 'mailboxes.json'),
    masterKey: randomBytes(32),
    getMailDomain: mailDomainRegistry.getMailDomain,
  });
  const mailAliasRegistry = createMailAliasRegistry({
    filePath: path.join(root, 'aliases.json'),
    getMailDomain: mailDomainRegistry.getMailDomain,
    listMailboxes: mailboxRegistry.listMailboxes,
  });
  const service = createMailConfigurationService({ mailDomainRegistry, mailboxRegistry, mailAliasRegistry });
  const password = randomBytes(24).toString('hex');
  async function createMailbox(domainName, localPart) {
    const web = await domains.createDomain({
      serverId: server.id, primaryDomain: domainName, targetType: 'proxy', target: { upstreamPort: 8500 },
    });
    const domain = await mailDomainRegistry.createMailDomain({
      domainName, webDomainId: web.id, managementMode: 'local',
    });
    const mailbox = await mailboxRegistry.createMailbox({
      mailDomainId: domain.id, address: localPart + '@' + domainName, password,
    });
    return { domain, mailbox };
  }
  const local = await createMailbox('policy.example.test', 'primary');
  const unrelated = await createMailbox('other.example.test', 'different');
  const input = { mailDomainId: local.domain.id, expectedRevision: local.domain.revision, status: 'enabled' };
  const before = await service.previewTransition(input);
  assert.equal(before.readyToApply, true);
  assert.equal(Object.hasOwn(before.configuration.counts, 'vacations'), false);
  assert.equal(before.configuration.artifactDigests.some(item => item.path === mailSpamPolicyTemplatePolicy.path), false);

  const vacation = { subject: 'Türkçe özel yanıt', body: 'Bunun içeriği önizlemede görünmez.' };
  const allow = ['friend@sender.example.test'];
  const deny = ['spammer@sender.example.test'];
  await mailboxRegistry.setDeliveryPolicy(unrelated.mailbox.id, {
    expectedRevision: unrelated.mailbox.revision, vacation: null, allow: ['unrelated@sender.example.test'], deny: [],
  });
  const saved = await mailboxRegistry.setDeliveryPolicy(local.mailbox.id, {
    expectedRevision: local.mailbox.revision, vacation, allow, deny,
  });
  const active = await service.previewTransition(input);
  const bind = preview => ({ expectedPreviewDigest: preview.previewDigest, expectedConfigurationSha256: preview.configurationSha256 });
  assert.equal(active.configuration.counts.vacations, 1);
  assert.equal(active.configuration.counts.spamAllow, 1);
  assert.equal(active.configuration.counts.spamDeny, 1);
  assert.notEqual(active.configurationSha256, before.configurationSha256);
  assert.doesNotMatch(JSON.stringify(active), /Bunun içeriği|friend@|spammer@|unrelated@/);
  await assert.rejects(service.materializeTransition(input, bind(before)), { code: 'mail_configuration_preview_stale', status: 409 });

  const bundle = await service.materializeTransition(input, bind(active));
  const sieve = bundle.sensitiveArtifacts.find(artifact => artifact.path === mailForwardingTemplatePolicy.sievePath);
  const spam = bundle.sensitiveArtifacts.find(artifact => artifact.path === mailSpamPolicyTemplatePolicy.path);
  assert.ok(sieve.content.includes(vacation.body));
  assert.ok(spam.content.includes(allow[0]));
  assert.ok(spam.content.includes(deny[0]));
  assert.doesNotMatch(spam.content, /unrelated@/);
  for (const artifact of [sieve, spam]) {
    const hash = createHash('sha256').update(artifact.content).digest('hex');
    assert.ok(active.configuration.artifactDigests.some(item => item.path === artifact.path && item.sha256 === hash && item.sensitive));
  }

  const resaved = await mailboxRegistry.setDeliveryPolicy(local.mailbox.id, {
    expectedRevision: saved.revision, vacation, allow, deny,
  });
  assert.equal(resaved.revision, saved.revision + 1);
  const current = await service.previewTransition(input);
  assert.notEqual(current.configurationSha256, active.configurationSha256);
  assert.deepEqual(current.configuration.artifactDigests, active.configuration.artifactDigests);
  await assert.rejects(service.materializeTransition(input, bind(active)), { code: 'mail_configuration_preview_stale' });

  const disabledBox = await mailboxRegistry.setEnabled(local.mailbox.id, { expectedRevision: resaved.revision, enabled: false });
  const inactive = await service.previewTransition(input);
  assert.equal(inactive.configuration.counts.vacations, 0);
  assert.equal(inactive.configuration.counts.spamAllow, 0);
  assert.equal(inactive.configuration.counts.spamDeny, 0);
  await assert.rejects(service.materializeTransition(input, bind(current)), { code: 'mail_configuration_preview_stale' });
  assert.equal((await mailboxRegistry.getDeliveryPolicy(local.mailbox.id)).revision, disabledBox.revision);

  const enabledDomain = await mailDomainRegistry.transitionLocalStatus(local.domain.id, {
    expectedRevision: local.domain.revision, status: 'enabled',
  });
  const lastDomain = { ...input, expectedRevision: enabledDomain.revision, status: 'disabled' };
  const teardown = await service.previewTransition(lastDomain);
  assert.equal(teardown.readyToApply, true);
  assert.equal(teardown.configuration.counts.spamAllow, 0);
  const teardownBundle = await service.materializeTransition(lastDomain, bind(teardown));
  assert.equal(
    teardownBundle.sensitiveArtifacts.find(artifact => artifact.path === mailSpamPolicyTemplatePolicy.path).content,
    mailSpamPolicyTemplatePolicy.header,
  );
});
