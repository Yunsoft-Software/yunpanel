import { createHash } from 'node:crypto';
import {
  mailTemplatePolicy,
  previewDovecotPasswdFile,
  previewPostfixVirtualMaps,
  previewRspamdPostfixIntegration,
  renderDovecotAuthConfig,
} from './mail.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function publicArtifact(path, content) {
  return Object.freeze({
    version: 1,
    path,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    content,
    sensitive: false,
    sideEffects: false,
  });
}

export function renderEmptyManagedDovecotMailConfig() {
  return 'protocols = imap\nmail_home = /var/lib/yunpanel/mail/%d/%n\nmail_location = maildir:~/Maildir\n';
}

export function previewEmptyManagedMailConfiguration() {
  const postfix = previewPostfixVirtualMaps({ domains: [], mailboxes: [], aliases: [] });
  const dovecotPasswd = previewDovecotPasswdFile({ domains: [], accounts: [] });
  const dovecotArtifacts = Object.freeze([
    publicArtifact(mailTemplatePolicy.dovecotAuthConfigPath, renderDovecotAuthConfig()),
    publicArtifact(mailTemplatePolicy.dovecotMailConfigPath, renderEmptyManagedDovecotMailConfig()),
  ]);
  const rspamd = previewRspamdPostfixIntegration();
  const postfixParameters = Object.freeze([
    ...rspamd.postfixParameters,
    Object.freeze({ name: 'virtual_alias_maps', value: `hash:${mailTemplatePolicy.postfixVirtualAliasMapPath}` }),
    Object.freeze({ name: 'virtual_mailbox_domains', value: `hash:${mailTemplatePolicy.postfixVirtualDomainMapPath}` }),
    Object.freeze({ name: 'virtual_mailbox_maps', value: `hash:${mailTemplatePolicy.postfixVirtualMailboxMapPath}` }),
    Object.freeze({ name: 'virtual_transport', value: 'lmtp:unix:private/dovecot-lmtp' }),
  ].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const artifacts = Object.freeze([
    ...postfix.artifacts,
    dovecotPasswd,
    ...dovecotArtifacts,
    ...rspamd.artifacts,
  ]);
  const artifactDigests = artifacts.map((entry) => ({ path: entry.path, sha256: entry.sha256 }));
  const identity = {
    version: 1,
    domains: [],
    mailboxes: [],
    aliases: [],
    postmasterAddress: null,
    artifactDigests,
    postfixParameters,
  };
  return Object.freeze({
    version: 1,
    sha256: sha256(JSON.stringify(identity)),
    counts: Object.freeze({ domains: 0, mailboxes: 0, aliases: 0 }),
    artifacts,
    postfixParameters,
    validate: Object.freeze([
      Object.freeze({ file: '/usr/sbin/postfix', args: Object.freeze(['check']) }),
      Object.freeze({ file: '/usr/bin/doveconf', args: Object.freeze(['-n']) }),
      Object.freeze({ file: '/usr/bin/rspamadm', args: Object.freeze(['configtest']) }),
    ]),
    requirements: Object.freeze([
      'postfix', 'dovecot_2_3', 'rspamd', 'vmail_identity', 'postfix_identity',
      'mail_tls_material', 'loopback_11332_available', 'managed_domains_excluded_from_mydestination',
      'postfix_relay_policy_verified',
    ]),
    readyToApply: false,
    sideEffects: false,
  });
}
