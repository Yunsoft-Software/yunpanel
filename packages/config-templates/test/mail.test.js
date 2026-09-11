import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailTemplateError,
  mailTemplatePolicy,
  previewDovecotPasswdFile,
  previewDovecotVirtualMailConfig,
  previewPostfixVirtualDomainMap,
  previewPostfixVirtualMaps,
  previewRspamdPostfixIntegration,
  renderDovecotAuthConfig,
  renderDovecotMailConfig,
  renderDovecotPasswdFile,
  renderPostfixVirtualAliasMap,
  renderPostfixVirtualDomainMap,
  renderPostfixVirtualMailboxMap,
  renderRspamdProxyConfig,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')}`;

test('renders a canonical deterministic Postfix virtual domain map', () => {
  const rendered = renderPostfixVirtualDomainMap(['Z.example.com.', 't\u00fcrkiye.example']);
  assert.equal(rendered, 'xn--trkiye-3ya.example OK\nz.example.com OK\n');
});

test('previews the exact source map and fixed validation commands without side effects', () => {
  const preview = previewPostfixVirtualDomainMap(['mail.example.com']);
  assert.deepEqual(preview, {
    version: 1,
    path: '/etc/yunpanel/mail/postfix/virtual-domains',
    lookup: 'hash:/etc/yunpanel/mail/postfix/virtual-domains',
    sha256: '8ff47cf9683bea83852eaf8089e850e46502ba1456c626bd246c68875907b261',
    bytes: 20,
    entries: 1,
    content: 'mail.example.com OK\n',
    compile: { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/virtual-domains'] },
    validate: { file: '/usr/sbin/postfix', args: ['check'] },
    sideEffects: false,
  });
  assert.equal(mailTemplatePolicy.maxManagedDomains, 1_000);
});

test('renders an empty domain map for an explicit empty managed set', () => {
  const preview = previewPostfixVirtualDomainMap([]);
  assert.equal(preview.content, '');
  assert.equal(preview.entries, 0);
  assert.equal(preview.bytes, 0);
  assert.equal(preview.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('rejects invalid, duplicate and oversized managed domain state', () => {
  assert.throws(
    () => renderPostfixVirtualDomainMap('example.com'),
    (error) => error instanceof MailTemplateError && error.code === 'invalid_mail_domains',
  );
  assert.throws(
    () => renderPostfixVirtualDomainMap(['Example.com', 'example.com.']),
    (error) => error instanceof MailTemplateError && error.code === 'duplicate_mail_domain',
  );
  assert.throws(
    () => renderPostfixVirtualDomainMap(['not a domain']),
    (error) => error instanceof MailTemplateError && error.code === 'invalid_mail_domain',
  );
  assert.throws(
    () => renderPostfixVirtualDomainMap(Array.from({ length: 1_001 }, (_, index) => `${index}.example.com`)),
    (error) => error instanceof MailTemplateError && error.code === 'too_many_mail_domains',
  );
});

test('renders canonical Postfix mailbox lookup entries only for managed domains', () => {
  assert.equal(renderPostfixVirtualMailboxMap({
    domains: ['example.com'],
    mailboxes: ['Sales+EU@EXAMPLE.COM.', 'admin@example.com'],
  }), 'admin@example.com 1\nsales+eu@example.com 1\n');

  assert.throws(
    () => renderPostfixVirtualMailboxMap({ domains: ['example.com'], mailboxes: ['admin@other.example'] }),
    (error) => error instanceof MailTemplateError && error.code === 'mailbox_domain_unmanaged',
  );
  assert.throws(
    () => renderPostfixVirtualMailboxMap({ domains: ['example.com'], mailboxes: ['Admin@example.com', 'admin@EXAMPLE.COM'] }),
    (error) => error instanceof MailTemplateError && error.code === 'duplicate_mailbox',
  );
});

test('renders bounded canonical forwarding aliases without map control characters', () => {
  assert.equal(renderPostfixVirtualAliasMap({
    domains: ['example.com'],
    aliases: [{ source: 'Info@Example.com', destinations: ['Sales@Other.example', 'owner@example.com', 'sales@other.example'] }],
  }), 'info@example.com owner@example.com, sales@other.example\n');

  for (const alias of [
    { source: '#root@example.com', destinations: ['owner@example.com'] },
    { source: 'root@example.com\nroot', destinations: ['owner@example.com'] },
    { source: 'root@example.com', destinations: [] },
  ]) assert.throws(() => renderPostfixVirtualAliasMap({ domains: ['example.com'], aliases: [alias] }), MailTemplateError);
  assert.throws(
    () => renderPostfixVirtualAliasMap({
      domains: ['example.com'], aliases: [{ source: 'info@other.example', destinations: ['owner@example.com'] }],
    }),
    (error) => error instanceof MailTemplateError && error.code === 'mail_alias_domain_unmanaged',
  );
  assert.throws(
    () => renderPostfixVirtualAliasMap({
      domains: ['example.com'],
      aliases: [
        { source: 'first@example.com', destinations: ['second@example.com'] },
        { source: 'second@example.com', destinations: ['first@example.com'] },
      ],
    }),
    (error) => error instanceof MailTemplateError && error.code === 'mail_alias_cycle',
  );
});

test('previews the complete Postfix map set and rejects mailbox-alias ambiguity', () => {
  const preview = previewPostfixVirtualMaps({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [{ source: 'info@example.com', destinations: ['owner@example.com'] }],
  });
  assert.equal(preview.version, 1);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.sideEffects, false);
  assert.deepEqual(preview.artifacts.map((entry) => [entry.path, entry.entries]), [
    ['/etc/yunpanel/mail/postfix/virtual-domains', 1],
    ['/etc/yunpanel/mail/postfix/virtual-mailboxes', 1],
    ['/etc/yunpanel/mail/postfix/virtual-aliases', 1],
  ]);
  assert.equal(previewPostfixVirtualMaps({
    aliases: [{ source: 'INFO@example.com', destinations: ['owner@example.com'] }],
    mailboxes: ['Owner@example.com'],
    domains: ['EXAMPLE.com'],
  }).sha256, preview.sha256);
  assert.throws(
    () => previewPostfixVirtualMaps({
      domains: ['example.com'], mailboxes: ['info@example.com'],
      aliases: [{ source: 'INFO@example.com', destinations: ['owner@example.com'] }],
    }),
    (error) => error instanceof MailTemplateError && error.code === 'mail_alias_mailbox_conflict',
  );
});

test('renders Dovecot passwd-file rows from canonical Argon2id hashes only', () => {
  const content = renderDovecotPasswdFile({
    domains: ['example.com'],
    accounts: [
      { address: 'Sales@EXAMPLE.COM.', passwordHash: ARGON2ID_HASH },
      { address: 'admin@example.com', passwordHash: ARGON2ID_HASH },
    ],
  });
  assert.equal(content, `admin@example.com:{ARGON2ID}${ARGON2ID_HASH}\nsales@example.com:{ARGON2ID}${ARGON2ID_HASH}\n`);
  assert.equal(content.includes('plaintext'), false);
});

test('Dovecot passwd preview never returns password hashes or rendered content', () => {
  const preview = previewDovecotPasswdFile({
    domains: ['example.com'],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
  });
  assert.deepEqual(Object.keys(preview).sort(), [
    'bytes', 'contentIncluded', 'entries', 'path', 'sensitive', 'sha256', 'sideEffects', 'validate', 'version',
  ]);
  assert.equal(preview.path, '/etc/yunpanel/mail/dovecot/users');
  assert.equal(preview.entries, 1);
  assert.equal(preview.sensitive, true);
  assert.equal(preview.contentIncluded, false);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(preview).includes(ARGON2ID_HASH), false);
});

test('Dovecot passwd rendering rejects weak, noncanonical and out-of-scope account state', () => {
  for (const passwordHash of [
    'plaintext',
    ARGON2ID_HASH.replace('m=65536', 'm=32768'),
    ARGON2ID_HASH.replace('t=3', 't=2'),
    `${ARGON2ID_HASH}=`,
    ARGON2ID_HASH.replace(/\$[^$]+$/, '$c2hvcnQ'),
  ]) assert.throws(
    () => renderDovecotPasswdFile({
      domains: ['example.com'], accounts: [{ address: 'owner@example.com', passwordHash }],
    }),
    (error) => error instanceof MailTemplateError && error.code === 'invalid_mailbox_password_hash',
  );
  assert.throws(
    () => renderDovecotPasswdFile({
      domains: ['example.com'], accounts: [{ address: 'owner@other.example', passwordHash: ARGON2ID_HASH }],
    }),
    (error) => error instanceof MailTemplateError && error.code === 'mailbox_domain_unmanaged',
  );
});

test('renders fail-closed Dovecot virtual authentication without PAM fallback', () => {
  const config = renderDovecotAuthConfig();
  assert.match(config, /^disable_plaintext_auth = yes$/m);
  assert.match(config, /^auth_mechanisms = plain login$/m);
  assert.match(config, /^auth_username_format = %Lu$/m);
  assert.match(config, /driver = passwd-file/);
  assert.match(config, /username_format=%u \/etc\/yunpanel\/mail\/dovecot\/users/);
  assert.equal(config.match(/result_failure = return-fail/g)?.length, 2);
  assert.equal(config.match(/result_internalfail = return-fail/g)?.length, 2);
  assert.equal(config.includes('driver = pam'), false);
  assert.equal(config.includes('allow_all_users'), false);
});

test('renders Dovecot Maildir and Postfix LMTP socket from fixed paths', () => {
  const config = renderDovecotMailConfig({ domains: ['example.com'], postmasterAddress: 'Postmaster@EXAMPLE.COM.' });
  assert.match(config, /^protocols = imap lmtp$/m);
  assert.match(config, /^mail_home = \/var\/lib\/yunpanel\/mail\/%d\/%n$/m);
  assert.match(config, /^mail_location = maildir:~\/Maildir$/m);
  assert.match(config, /unix_listener \/var\/spool\/postfix\/private\/dovecot-lmtp/);
  assert.match(config, /^    mode = 0600$/m);
  assert.match(config, /^    user = postfix$/m);
  assert.match(config, /^    group = postfix$/m);
  assert.match(config, /^  postmaster_address = postmaster@example\.com$/m);
  assert.throws(
    () => renderDovecotMailConfig({ domains: ['example.com'], postmasterAddress: 'postmaster@other.example' }),
    (error) => error instanceof MailTemplateError && error.code === 'postmaster_domain_unmanaged',
  );
});

test('previews deterministic non-secret Dovecot config with explicit activation requirements', () => {
  const preview = previewDovecotVirtualMailConfig({ domains: ['example.com'], postmasterAddress: 'postmaster@example.com' });
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.artifacts.map((entry) => entry.path), [
    '/etc/dovecot/conf.d/10-auth.conf',
    '/etc/dovecot/conf.d/99-yunpanel-mail.conf',
  ]);
  assert.deepEqual(preview.validate, { file: '/usr/bin/doveconf', args: ['-n'] });
  assert.deepEqual(preview.requirements, ['dovecot_2_3', 'vmail_identity', 'postfix_identity', 'mail_tls_material']);
  assert.equal(preview.sideEffects, false);
  assert.equal(previewDovecotVirtualMailConfig({
    postmasterAddress: 'POSTMASTER@EXAMPLE.COM.', domains: ['EXAMPLE.COM.'],
  }).sha256, preview.sha256);
});

test('renders an explicit loopback-only Rspamd self-scan Milter worker', () => {
  const config = renderRspamdProxyConfig();
  assert.match(config, /^bind_socket = "127\.0\.0\.1:11332";$/m);
  assert.match(config, /^milter = yes;$/m);
  assert.match(config, /^upstream "local" \{$/m);
  assert.match(config, /^  self_scan = yes;$/m);
  assert.equal(config.includes('*:11332'), false);
  assert.equal(config.includes('0.0.0.0'), false);
});

test('previews strict Postfix Milter parameters and fixed config validators', () => {
  const preview = previewRspamdPostfixIntegration();
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.artifacts[0].path, '/etc/rspamd/local.d/worker-proxy.inc');
  assert.deepEqual(preview.postfixParameters, [
    { name: 'milter_default_action', value: 'tempfail' },
    { name: 'milter_protocol', value: '6' },
    { name: 'non_smtpd_milters', value: 'inet:127.0.0.1:11332' },
    { name: 'smtpd_milters', value: 'inet:127.0.0.1:11332' },
  ]);
  assert.deepEqual(preview.validate, [
    { file: '/usr/bin/rspamadm', args: ['configtest'] },
    { file: '/usr/sbin/postfix', args: ['check'] },
  ]);
  assert.deepEqual(preview.requirements, ['rspamd', 'postfix', 'loopback_11332_available']);
  assert.equal(preview.sideEffects, false);
  assert.equal(preview.artifacts[0].sideEffects, false);
});
