import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MailSqlTemplateError,
  mailSqlTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailSqlConfiguration,
  renderDovecotSqlAuthConfig,
  renderDovecotSqlConfig,
  renderManagedMailSqlSeed,
  renderPostfixSqlAliasLookup,
  renderPostfixSqlDomainLookup,
  renderPostfixSqlMailboxLookup,
  renderPostfixSqlSenderLoginLookup,
} from '../src/index.js';

const HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 31).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 32).toString('base64').replace(/=+$/, '')}`;

function input(quotaBytes = 200 * 1024 * 1024) {
  return {
    domains: ['Example.com.'],
    accounts: [{ address: 'OWNER@EXAMPLE.COM', passwordHash: HASH, quotaBytes }],
    aliases: [{ source: 'INFO@example.com', destinations: ['owner@example.com'] }],
  };
}

test('renders one deterministic transactional SQLite seed with canonical virtual-mail state', () => {
  const rendered = renderManagedMailSqlSeed(input());

  assert.match(rendered, /^PRAGMA foreign_keys = ON;\nBEGIN IMMEDIATE;/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS virtual_domains/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS virtual_mailboxes/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS virtual_aliases/);
  assert.match(rendered, /DELETE FROM virtual_aliases;\nDELETE FROM virtual_mailboxes;\nDELETE FROM virtual_domains;/);
  assert.match(rendered, /INSERT INTO virtual_domains\(domain, enabled\) VALUES \('example\.com', 1\);/);
  assert.match(rendered, /INSERT INTO virtual_mailboxes\(address, domain, local_part, password, quota_bytes, enabled\) VALUES \('owner@example\.com', 'example\.com', 'owner', '\{ARGON2ID\}\$argon2id\$/);
  assert.match(rendered, /209715200, 1\);/);
  assert.match(rendered, /INSERT INTO virtual_aliases\(source, domain, destinations, enabled\) VALUES \('info@example\.com', 'example\.com', 'owner@example\.com', 1\);/);
  assert.match(rendered, /COMMIT;\n$/);
});

test('SQLite seed canonicalization makes equivalent mail state byte-identical', () => {
  const first = renderManagedMailSqlSeed(input());
  const second = renderManagedMailSqlSeed({
    domains: ['EXAMPLE.COM'],
    accounts: [{ address: 'owner@example.com.', passwordHash: HASH, quotaBytes: 200 * 1024 * 1024 }],
    aliases: [{ source: 'info@EXAMPLE.COM.', destinations: ['OWNER@example.com'] }],
  });
  assert.equal(second, first);
});

test('SQLite seed reuses Argon2id, quota, alias-cycle and domain-scope validation', () => {
  assert.throws(
    () => renderManagedMailSqlSeed({
      domains: ['example.com'],
      accounts: [{ address: 'owner@example.com', passwordHash: 'plaintext', quotaBytes: null }],
      aliases: [],
    }),
  );
  assert.throws(
    () => renderManagedMailSqlSeed({
      domains: ['example.com'],
      accounts: [{ address: 'owner@other.example', passwordHash: HASH, quotaBytes: null }],
      aliases: [],
    }),
  );
  assert.throws(
    () => renderManagedMailSqlSeed({
      domains: ['example.com'],
      accounts: [{ address: 'owner@example.com', passwordHash: HASH, quotaBytes: null }],
      aliases: [
        { source: 'first@example.com', destinations: ['second@example.com'] },
        { source: 'second@example.com', destinations: ['first@example.com'] },
      ],
    }),
  );
  assert.throws(
    () => renderManagedMailSqlSeed({
      domains: ['example.com'],
      accounts: [{ address: 'owner@example.com', passwordHash: HASH, quotaBytes: null }],
      aliases: [{ source: 'owner@example.com', destinations: ['other@example.com'] }],
    }),
    (error) => error instanceof MailSqlTemplateError && error.code === 'mail_sql_alias_mailbox_conflict',
  );
});

test('Postfix SQLite lookup configs use one private database and bounded exact queries', () => {
  for (const rendered of [
    renderPostfixSqlDomainLookup(),
    renderPostfixSqlMailboxLookup(),
    renderPostfixSqlAliasLookup(),
    renderPostfixSqlSenderLoginLookup(),
  ]) {
    assert.match(rendered, new RegExp('^dbpath = ' + mailSqlTemplatePolicy.databasePath.replaceAll('/', '\\/') + '$', 'm'));
    assert.equal(rendered.includes('password'), false);
    assert.equal(rendered.includes('ATTACH'), false);
  }
  assert.match(renderPostfixSqlDomainLookup(), /virtual_domains WHERE domain = '%s' AND enabled = 1/);
  assert.match(renderPostfixSqlMailboxLookup(), /virtual_mailboxes WHERE address = '%s' AND enabled = 1/);
  assert.match(renderPostfixSqlAliasLookup(), /SELECT destinations FROM virtual_aliases/);
  assert.match(renderPostfixSqlSenderLoginLookup(), /SELECT address FROM virtual_mailboxes/);
});

test('Dovecot SQL auth keeps static vmail userdb and obtains only protected credentials/quota from SQLite', () => {
  const sql = renderDovecotSqlConfig();
  const auth = renderDovecotSqlAuthConfig();

  assert.match(sql, /^driver = sqlite$/m);
  assert.match(sql, new RegExp('^connect = ' + mailSqlTemplatePolicy.databasePath.replaceAll('/', '\\/') + '$', 'm'));
  assert.match(sql, /SELECT password, CASE WHEN quota_bytes IS NULL THEN NULL ELSE '\*:bytes=' \|\| quota_bytes END AS userdb_quota_rule/);
  assert.match(auth, /^disable_plaintext_auth = yes$/m);
  assert.match(auth, /^  driver = sql$/m);
  assert.match(auth, new RegExp('^  args = ' + mailSqlTemplatePolicy.dovecotSqlPath.replaceAll('/', '\\/') + '$', 'm'));
  assert.match(auth, /^  driver = static$/m);
  assert.match(auth, /uid=vmail gid=vmail home=\/var\/lib\/yunpanel\/mail\/%d\/%n mail=maildir:~\/Maildir/);
  assert.equal(auth.includes('driver = pam'), false);
  assert.equal(auth.includes('passwd-file'), false);
});

test('SQL preview hides seed/password hashes while exposing only fixed lookup metadata', () => {
  const preview = previewManagedMailSqlConfiguration(input());

  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.databasePath, '/var/lib/yunpanel/mail/virtual-mail.sqlite3');
  assert.deepEqual(preview.postfixLookups, {
    domains: 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-domains.cf',
    mailboxes: 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf',
    aliases: 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-aliases.cf',
    senderLogin: 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf',
  });
  assert.deepEqual(preview.requirements, ['sqlite3', 'postfix_sqlite', 'dovecot_sqlite']);
  assert.deepEqual(preview.artifacts.map((artifact) => artifact.path), [
    mailSqlTemplatePolicy.seedPath,
    mailSqlTemplatePolicy.postfixDomainPath,
    mailSqlTemplatePolicy.postfixMailboxPath,
    mailSqlTemplatePolicy.postfixAliasPath,
    mailSqlTemplatePolicy.postfixSenderLoginPath,
    mailSqlTemplatePolicy.dovecotSqlPath,
    mailTemplatePolicy.dovecotAuthConfigPath,
  ]);
  const seed = preview.artifacts[0];
  assert.equal(seed.sensitive, true);
  assert.equal(seed.contentIncluded, false);
  assert.equal(Object.hasOwn(seed, 'content'), false);
  assert.equal(JSON.stringify(preview).includes(HASH), false);
  assert.equal(JSON.stringify(preview).includes('{ARGON2ID}'), false);
});
