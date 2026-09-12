import assert from 'node:assert/strict';
import test from 'node:test';
import {
  previewManagedMailApplyPlan,
  previewManagedMailEmptyConfiguration,
  renderDovecotEmptyManagedSetConfig,
} from '../src/index.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('empty managed mail configuration is deterministic and secret-free', () => {
  const first = previewManagedMailEmptyConfiguration();
  const second = previewManagedMailEmptyConfiguration();

  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.counts, { domains: 0, mailboxes: 0, aliases: 0 });
  assert.equal(first.readyToApply, false);
  assert.equal(first.sideEffects, false);

  const postfixMaps = first.artifacts.slice(0, 3);
  assert.deepEqual(postfixMaps.map((artifact) => [artifact.path, artifact.entries, artifact.sha256]), [
    ['/etc/yunpanel/mail/postfix/virtual-domains', 0, EMPTY_SHA256],
    ['/etc/yunpanel/mail/postfix/virtual-mailboxes', 0, EMPTY_SHA256],
    ['/etc/yunpanel/mail/postfix/virtual-aliases', 0, EMPTY_SHA256],
  ]);

  const passwd = first.artifacts.find((artifact) => artifact.path === '/etc/yunpanel/mail/dovecot/users');
  assert.equal(passwd.sensitive, true);
  assert.equal(passwd.contentIncluded, false);
  assert.equal(passwd.sha256, EMPTY_SHA256);
  assert.equal(Object.hasOwn(passwd, 'content'), false);
  assert.doesNotMatch(JSON.stringify(first), /argon2|passwordHash/i);
});

test('empty managed set disables Dovecot LMTP while keeping fail-closed passwd authentication', () => {
  const config = renderDovecotEmptyManagedSetConfig();
  assert.match(config, /^protocols = imap$/m);
  assert.match(config, /^mail_home = \/var\/lib\/yunpanel\/mail\/%d\/%n$/m);
  assert.match(config, /^mail_location = maildir:~\/Maildir$/m);
  assert.doesNotMatch(config, /lmtp|postmaster_address|dovecot-lmtp/i);

  const preview = previewManagedMailEmptyConfiguration();
  const auth = preview.artifacts.find((artifact) => artifact.path === '/etc/dovecot/conf.d/10-auth.conf');
  const mail = preview.artifacts.find((artifact) => artifact.path === '/etc/dovecot/conf.d/99-yunpanel-mail.conf');
  assert.match(auth.content, /driver = passwd-file/);
  assert.doesNotMatch(auth.content, /driver = pam/);
  assert.equal(mail.content, config);
});

test('empty managed set remains compatible with the allowlisted apply plan', () => {
  const preview = previewManagedMailEmptyConfiguration();
  const plan = previewManagedMailApplyPlan(preview);

  assert.equal(plan.previewSha256, preview.sha256);
  assert.equal(plan.sensitiveMaterialRequired, true);
  assert.equal(plan.readyToExecute, false);
  assert.equal(plan.sideEffects, false);
  assert.deepEqual(plan.stages.compile.map((command) => command.args[0]), [
    'hash:/etc/yunpanel/mail/postfix/virtual-domains',
    'hash:/etc/yunpanel/mail/postfix/virtual-mailboxes',
    'hash:/etc/yunpanel/mail/postfix/virtual-aliases',
  ]);
  assert.deepEqual(plan.stages.reload.map((command) => command.args[1]), ['rspamd', 'dovecot', 'postfix']);
  assert.deepEqual(plan.stages.health.map((command) => command.args[2]), ['rspamd', 'dovecot', 'postfix']);
});
