import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailQuotaTemplateError,
  mailQuotaTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailQuotaConfiguration,
  renderDovecotQuotaAuthConfig,
  renderDovecotQuotaMailConfig,
  renderDovecotQuotaPasswdFile,
} from '../src/index.js';

const HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 11).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 12).toString('base64').replace(/=+$/, '')}`;

function input(quotaBytes = 512 * 1024 * 1024) {
  return {
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [{ source: 'info@example.com', destinations: ['owner@example.com'] }],
    accounts: [{ address: 'owner@example.com', passwordHash: HASH, quotaBytes }],
    postmasterAddress: 'owner@example.com',
  };
}

test('renders passwd-file userdb quota rule without exposing plaintext credentials', () => {
  const rendered = renderDovecotQuotaPasswdFile({
    domains: ['example.com'],
    accounts: [{ address: 'OWNER@EXAMPLE.COM.', passwordHash: HASH, quotaBytes: 104857600 }],
  });
  assert.equal(
    rendered,
    `owner@example.com:{ARGON2ID}${HASH}::::::userdb_quota_rule=*:bytes=104857600\n`,
  );
  assert.doesNotMatch(rendered, /plaintext|password=/i);
});

test('renders unlimited userdb row when no mailbox quota policy exists', () => {
  const rendered = renderDovecotQuotaPasswdFile({
    domains: ['example.com'],
    accounts: [{ address: 'owner@example.com', passwordHash: HASH, quotaBytes: null }],
  });
  assert.equal(rendered, `owner@example.com:{ARGON2ID}${HASH}::::::\n`);
});

test('quota auth uses passwd-file userdb and fail-closed authentication', () => {
  const config = renderDovecotQuotaAuthConfig();
  assert.equal(config.match(/driver = passwd-file/g)?.length, 2);
  assert.match(config, new RegExp(`args = username_format=%u ${mailTemplatePolicy.dovecotPasswdFilePath.replaceAll('/', '\\/')}`));
  assert.match(config, /default_fields = uid=vmail gid=vmail home=\/var\/lib\/yunpanel\/mail\/%d\/%n mail=maildir:~\/Maildir/);
  assert.equal(config.includes('driver = static'), false);
  assert.equal(config.includes('driver = pam'), false);
  assert.equal(config.match(/result_failure = return-fail/g)?.length, 2);
});

test('quota mail config loads quota enforcement and IMAP reporting plugins', () => {
  const config = renderDovecotQuotaMailConfig({
    domains: ['example.com'],
    postmasterAddress: 'owner@example.com',
  });
  assert.match(config, /^mail_plugins = \$mail_plugins quota$/m);
  assert.match(config, /^protocol imap \{$/m);
  assert.match(config, /^  mail_plugins = \$mail_plugins imap_quota$/m);
  assert.match(config, /^  quota = maildir:User quota$/m);
  assert.match(config, /unix_listener \/var\/spool\/postfix\/private\/dovecot-lmtp/);
});

test('quota-aware managed mail preview preserves canonical artifact order and hides passwd content', () => {
  const preview = previewManagedMailQuotaConfiguration(input());
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.counts, { domains: 1, mailboxes: 1, aliases: 1 });
  assert.deepEqual(preview.artifacts.map((artifact) => artifact.path), [
    mailTemplatePolicy.postfixVirtualDomainMapPath,
    mailTemplatePolicy.postfixVirtualMailboxMapPath,
    mailTemplatePolicy.postfixVirtualAliasMapPath,
    mailTemplatePolicy.dovecotPasswdFilePath,
    mailTemplatePolicy.dovecotAuthConfigPath,
    mailTemplatePolicy.dovecotMailConfigPath,
    mailTemplatePolicy.rspamdProxyConfigPath,
  ]);
  const passwd = preview.artifacts.find((artifact) => artifact.path === mailTemplatePolicy.dovecotPasswdFilePath);
  assert.equal(passwd.sensitive, true);
  assert.equal(passwd.contentIncluded, false);
  assert.equal(Object.hasOwn(passwd, 'content'), false);
  assert.doesNotMatch(JSON.stringify(preview), /argon2id|userdb_quota_rule/i);
});

test('quota policy changes alter managed configuration digest and enforce bounds', () => {
  const first = previewManagedMailQuotaConfiguration(input(100 * 1024 * 1024));
  const second = previewManagedMailQuotaConfiguration(input(200 * 1024 * 1024));
  assert.notEqual(first.sha256, second.sha256);
  assert.equal(mailQuotaTemplatePolicy.minQuotaBytes, 1024 * 1024);
  assert.equal(mailQuotaTemplatePolicy.maxQuotaBytes, 16 * 1024 * 1024 * 1024 * 1024);

  assert.throws(
    () => previewManagedMailQuotaConfiguration(input(1024)),
    (error) => error instanceof MailQuotaTemplateError && error.code === 'invalid_mailbox_quota_bytes',
  );
});
