import { createHash } from 'node:crypto';
import {
  mailTemplatePolicy,
  previewDovecotPasswdFile,
  previewPostfixVirtualMaps,
  previewRspamdPostfixIntegration,
  renderDovecotAuthConfig,
} from './mail.js';

function configArtifact(path, content) {
  return Object.freeze({
    version: 1,
    path,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    content,
    sensitive: false,
    sideEffects: false,
  });
}

export function renderDovecotEmptyManagedSetConfig() {
  return 'protocols = imap\nmail_home = /var/lib/yunpanel/mail/%d/%n\nmail_location = maildir:~/Maildir\n';
}

export function previewManagedMailEmptyConfiguration() {
  const postfix = previewPostfixVirtualMaps({ domains: [], mailboxes: [], aliases: [] });
  const dovecotPasswd = previewDovecotPasswdFile({ domains: [], accounts: [] });
  const dovecotArtifacts = Object.freeze([
    configArtifact(mailTemplatePolicy.dovecotAuthConfigPath, renderDovecotAuthConfig()),
    configArtifact(mailTemplatePolicy.dovecotMailConfigPath, renderDovecotEmptyManagedSetConfig()),
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
  const validate = Object.freeze([
    Object.freeze({ file: '/usr/sbin/postfix', args: Object.freeze(['check']) }),
    Object.freeze({ file: '/usr/bin/doveconf', args: Object.freeze(['-n']) }),
    Object.freeze({ file: '/usr/bin/rspamadm', args: Object.freeze(['configtest']) }),
  ]);
  const requirements = Object.freeze([
    'postfix', 'dovecot_2_3', 'rspamd', 'vmail_identity', 'postfix_identity',
    'mail_tls_material', 'loopback_11332_available', 'managed_domains_excluded_from_mydestination',
    'postfix_relay_policy_verified',
  ]);
  const identity = {
    version: 1,
    emptyManagedSet: true,
    artifactDigests: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    postfixParameters,
  };
  return Object.freeze({
    version: 1,
    sha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    counts: Object.freeze({ domains: 0, mailboxes: 0, aliases: 0 }),
    artifacts,
    postfixParameters,
    validate,
    requirements,
    readyToApply: false,
    sideEffects: false,
  });
}
