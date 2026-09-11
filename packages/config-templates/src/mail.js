import { createHash } from 'node:crypto';
import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const MAX_MANAGED_DOMAINS = 1_000;
const MAX_MAILBOXES = 10_000;
const MAX_ALIASES = 10_000;
const MAX_ALIAS_DESTINATIONS = 20;
const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const ARGON2ID_PATTERN = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const POSTFIX_VIRTUAL_DOMAIN_MAP_PATH = '/etc/yunpanel/mail/postfix/virtual-domains';
const POSTFIX_VIRTUAL_MAILBOX_MAP_PATH = '/etc/yunpanel/mail/postfix/virtual-mailboxes';
const POSTFIX_VIRTUAL_ALIAS_MAP_PATH = '/etc/yunpanel/mail/postfix/virtual-aliases';
const DOVECOT_PASSWD_FILE_PATH = '/etc/yunpanel/mail/dovecot/users';
const DOVECOT_AUTH_CONFIG_PATH = '/etc/dovecot/conf.d/10-auth.conf';
const DOVECOT_MAIL_CONFIG_PATH = '/etc/dovecot/conf.d/99-yunpanel-mail.conf';

export class MailTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailTemplateError';
    this.code = code;
  }
}

function normalizeManagedDomains(domains) {
  if (!Array.isArray(domains)) {
    throw new MailTemplateError('invalid_mail_domains', 'Managed mail domains must be an array');
  }
  if (domains.length > MAX_MANAGED_DOMAINS) {
    throw new MailTemplateError('too_many_mail_domains', `At most ${MAX_MANAGED_DOMAINS} managed mail domains are supported`);
  }

  const normalized = [];
  const seen = new Set();
  for (const value of domains) {
    let domain;
    try { domain = normalizeDomainSet(value, []).primary; }
    catch (error) {
      if (error instanceof DomainValidationError) {
        throw new MailTemplateError('invalid_mail_domain', error.message);
      }
      throw error;
    }
    if (seen.has(domain)) {
      throw new MailTemplateError('duplicate_mail_domain', 'Managed mail domains must be unique after canonicalization');
    }
    seen.add(domain);
    normalized.push(domain);
  }
  return normalized.sort();
}

function normalizeAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || value.trim() !== value) {
    throw new MailTemplateError('invalid_mailbox_address', 'Mailbox address must be a bounded canonical address');
  }
  const separator = value.indexOf('@');
  if (separator < 1 || separator !== value.lastIndexOf('@')) {
    throw new MailTemplateError('invalid_mailbox_address', 'Mailbox address must contain one local part and domain');
  }
  const local = value.slice(0, separator).toLowerCase();
  if (!LOCAL_PART_PATTERN.test(local) || local.includes('..')) {
    throw new MailTemplateError('invalid_mailbox_address', 'Mailbox local part contains unsupported characters');
  }
  let domain;
  try { domain = normalizeDomainSet(value.slice(separator + 1), []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) {
      throw new MailTemplateError('invalid_mailbox_address', error.message);
    }
    throw error;
  }
  const address = `${local}@${domain}`;
  if (address.length > 254) {
    throw new MailTemplateError('invalid_mailbox_address', 'Canonical mailbox address exceeds 254 characters');
  }
  return Object.freeze({ address, domain });
}

function normalizeMailboxes(domains, mailboxes) {
  if (!Array.isArray(mailboxes)) {
    throw new MailTemplateError('invalid_mailboxes', 'Managed mailboxes must be an array');
  }
  if (mailboxes.length > MAX_MAILBOXES) {
    throw new MailTemplateError('too_many_mailboxes', `At most ${MAX_MAILBOXES} managed mailboxes are supported`);
  }
  const managedDomains = new Set(domains);
  const addresses = [];
  const seen = new Set();
  for (const value of mailboxes) {
    const mailbox = normalizeAddress(value);
    if (!managedDomains.has(mailbox.domain)) {
      throw new MailTemplateError('mailbox_domain_unmanaged', 'Mailbox address must belong to an explicitly managed mail domain');
    }
    if (seen.has(mailbox.address)) {
      throw new MailTemplateError('duplicate_mailbox', 'Managed mailbox addresses must be unique after canonicalization');
    }
    seen.add(mailbox.address);
    addresses.push(mailbox.address);
  }
  return addresses.sort();
}

function normalizeAliases(domains, aliases) {
  if (!Array.isArray(aliases)) {
    throw new MailTemplateError('invalid_mail_aliases', 'Managed mail aliases must be an array');
  }
  if (aliases.length > MAX_ALIASES) {
    throw new MailTemplateError('too_many_mail_aliases', `At most ${MAX_ALIASES} managed mail aliases are supported`);
  }
  const managedDomains = new Set(domains);
  const normalized = [];
  const sources = new Set();
  for (const value of aliases) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'source') || !Object.hasOwn(value, 'destinations')) {
      throw new MailTemplateError('invalid_mail_alias', 'Mail alias must contain only source and destinations');
    }
    const source = normalizeAddress(value.source);
    if (!managedDomains.has(source.domain)) {
      throw new MailTemplateError('mail_alias_domain_unmanaged', 'Mail alias source must belong to an explicitly managed mail domain');
    }
    if (sources.has(source.address)) {
      throw new MailTemplateError('duplicate_mail_alias', 'Mail alias sources must be unique after canonicalization');
    }
    if (!Array.isArray(value.destinations) || value.destinations.length < 1
      || value.destinations.length > MAX_ALIAS_DESTINATIONS) {
      throw new MailTemplateError('invalid_mail_alias_destinations', `Mail alias must contain 1 to ${MAX_ALIAS_DESTINATIONS} destinations`);
    }
    const destinations = [];
    const seenDestinations = new Set();
    for (const destination of value.destinations) {
      const address = normalizeAddress(destination).address;
      if (!seenDestinations.has(address)) {
        seenDestinations.add(address);
        destinations.push(address);
      }
    }
    sources.add(source.address);
    normalized.push(Object.freeze({ source: source.address, destinations: Object.freeze(destinations.sort()) }));
  }
  const bySource = normalized.sort((left, right) => left.source < right.source ? -1 : left.source > right.source ? 1 : 0);
  const destinationsBySource = new Map(bySource.map((entry) => [entry.source, entry.destinations]));
  const visiting = new Set();
  const visited = new Set();
  function visit(source) {
    if (visiting.has(source)) {
      throw new MailTemplateError('mail_alias_cycle', 'Mail aliases must not contain forwarding cycles');
    }
    if (visited.has(source)) return;
    visiting.add(source);
    for (const destination of destinationsBySource.get(source) ?? []) {
      if (destinationsBySource.has(destination)) visit(destination);
    }
    visiting.delete(source);
    visited.add(source);
  }
  for (const source of destinationsBySource.keys()) visit(source);
  return bySource;
}

function decodeCanonicalBase64(value, minimumBytes, maximumBytes) {
  if (value.length % 4 === 1) return null;
  const decoded = Buffer.from(`${value}${'='.repeat((4 - value.length % 4) % 4)}`, 'base64');
  if (decoded.length < minimumBytes || decoded.length > maximumBytes
    || decoded.toString('base64').replace(/=+$/, '') !== value) return null;
  return decoded;
}

function normalizeArgon2idHash(value) {
  if (typeof value !== 'string' || value.length > 512) {
    throw new MailTemplateError('invalid_mailbox_password_hash', 'Mailbox password hash must be a bounded Argon2id PHC string');
  }
  const match = value.match(ARGON2ID_PATTERN);
  if (!match) {
    throw new MailTemplateError('invalid_mailbox_password_hash', 'Mailbox password hash must use canonical Argon2id PHC encoding');
  }
  const memory = Number.parseInt(match[1], 10);
  const passes = Number.parseInt(match[2], 10);
  const parallelism = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(memory) || memory < 65_536 || memory > 262_144
    || !Number.isSafeInteger(passes) || passes < 3 || passes > 10
    || !Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 4
    || !decodeCanonicalBase64(match[4], 16, 64) || !decodeCanonicalBase64(match[5], 32, 64)) {
    throw new MailTemplateError('invalid_mailbox_password_hash', 'Mailbox Argon2id parameters or encoded values are outside policy');
  }
  return value;
}

function normalizeMailboxAccounts(domains, accounts) {
  if (!Array.isArray(accounts)) {
    throw new MailTemplateError('invalid_mailbox_accounts', 'Mailbox accounts must be an array');
  }
  if (accounts.length > MAX_MAILBOXES) {
    throw new MailTemplateError('too_many_mailboxes', `At most ${MAX_MAILBOXES} managed mailbox accounts are supported`);
  }
  const managedDomains = new Set(domains);
  const normalized = [];
  const addresses = new Set();
  for (const value of accounts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'address') || !Object.hasOwn(value, 'passwordHash')) {
      throw new MailTemplateError('invalid_mailbox_account', 'Mailbox account must contain only address and passwordHash');
    }
    const mailbox = normalizeAddress(value.address);
    if (!managedDomains.has(mailbox.domain)) {
      throw new MailTemplateError('mailbox_domain_unmanaged', 'Mailbox account must belong to an explicitly managed mail domain');
    }
    if (addresses.has(mailbox.address)) {
      throw new MailTemplateError('duplicate_mailbox', 'Mailbox accounts must be unique after canonicalization');
    }
    addresses.add(mailbox.address);
    normalized.push(Object.freeze({ address: mailbox.address, passwordHash: normalizeArgon2idHash(value.passwordHash) }));
  }
  return normalized.sort((left, right) => left.address < right.address ? -1 : left.address > right.address ? 1 : 0);
}

function artifact(path, content) {
  return Object.freeze({
    version: 1,
    path,
    lookup: `hash:${path}`,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    entries: content === '' ? 0 : content.split('\n').length - 1,
    content,
    compile: Object.freeze({ file: '/usr/sbin/postmap', args: Object.freeze([`hash:${path}`]) }),
    validate: Object.freeze({ file: '/usr/sbin/postfix', args: Object.freeze(['check']) }),
    sideEffects: false,
  });
}

export function renderPostfixVirtualDomainMap(domains) {
  const normalized = normalizeManagedDomains(domains);
  return normalized.length === 0 ? '' : `${normalized.map((domain) => `${domain} OK`).join('\n')}\n`;
}

export function previewPostfixVirtualDomainMap(domains) {
  const content = renderPostfixVirtualDomainMap(domains);
  return artifact(POSTFIX_VIRTUAL_DOMAIN_MAP_PATH, content);
}

export function renderPostfixVirtualMailboxMap({ domains, mailboxes } = {}) {
  const normalizedDomains = normalizeManagedDomains(domains);
  const normalizedMailboxes = normalizeMailboxes(normalizedDomains, mailboxes);
  return normalizedMailboxes.length === 0 ? '' : `${normalizedMailboxes.map((address) => `${address} 1`).join('\n')}\n`;
}

export function renderPostfixVirtualAliasMap({ domains, aliases } = {}) {
  const normalizedDomains = normalizeManagedDomains(domains);
  const normalizedAliases = normalizeAliases(normalizedDomains, aliases);
  return normalizedAliases.length === 0 ? ''
    : `${normalizedAliases.map((entry) => `${entry.source} ${entry.destinations.join(', ')}`).join('\n')}\n`;
}

export function previewPostfixVirtualMaps({ domains, mailboxes = [], aliases = [] } = {}) {
  const normalizedDomains = normalizeManagedDomains(domains);
  const normalizedMailboxes = normalizeMailboxes(normalizedDomains, mailboxes);
  const normalizedAliases = normalizeAliases(normalizedDomains, aliases);
  const mailboxSet = new Set(normalizedMailboxes);
  if (normalizedAliases.some((entry) => mailboxSet.has(entry.source))) {
    throw new MailTemplateError('mail_alias_mailbox_conflict', 'A mail address cannot be both a mailbox and an alias source');
  }
  const contents = [
    [POSTFIX_VIRTUAL_DOMAIN_MAP_PATH, normalizedDomains.length === 0 ? '' : `${normalizedDomains.map((domain) => `${domain} OK`).join('\n')}\n`],
    [POSTFIX_VIRTUAL_MAILBOX_MAP_PATH, normalizedMailboxes.length === 0 ? '' : `${normalizedMailboxes.map((address) => `${address} 1`).join('\n')}\n`],
    [POSTFIX_VIRTUAL_ALIAS_MAP_PATH, normalizedAliases.length === 0 ? ''
      : `${normalizedAliases.map((entry) => `${entry.source} ${entry.destinations.join(', ')}`).join('\n')}\n`],
  ];
  const artifacts = Object.freeze(contents.map(([path, content]) => artifact(path, content)));
  const digestInput = artifacts.map((entry) => ({ path: entry.path, sha256: entry.sha256 }));
  return Object.freeze({
    version: 1,
    sha256: createHash('sha256').update(JSON.stringify(digestInput)).digest('hex'),
    artifacts,
    sideEffects: false,
  });
}

export function renderDovecotPasswdFile({ domains, accounts } = {}) {
  const normalizedDomains = normalizeManagedDomains(domains);
  const normalizedAccounts = normalizeMailboxAccounts(normalizedDomains, accounts);
  return normalizedAccounts.length === 0 ? ''
    : `${normalizedAccounts.map((account) => `${account.address}:{ARGON2ID}${account.passwordHash}`).join('\n')}\n`;
}

export function previewDovecotPasswdFile(input = {}) {
  const content = renderDovecotPasswdFile(input);
  return Object.freeze({
    version: 1,
    path: DOVECOT_PASSWD_FILE_PATH,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    entries: content === '' ? 0 : content.split('\n').length - 1,
    sensitive: true,
    contentIncluded: false,
    validate: Object.freeze({ file: '/usr/bin/doveconf', args: Object.freeze(['-n']) }),
    sideEffects: false,
  });
}

export function renderDovecotAuthConfig() {
  return `disable_plaintext_auth = yes\nauth_mechanisms = plain login\nauth_username_format = %Lu\n\npassdb {\n  driver = passwd-file\n  args = username_format=%u ${DOVECOT_PASSWD_FILE_PATH}\n  result_failure = return-fail\n  result_internalfail = return-fail\n  result_success = return-ok\n}\n\nuserdb {\n  driver = static\n  args = uid=vmail gid=vmail home=/var/lib/yunpanel/mail/%d/%n\n  result_failure = return-fail\n  result_internalfail = return-fail\n  result_success = return-ok\n}\n`;
}

export function renderDovecotMailConfig({ domains, postmasterAddress } = {}) {
  const normalizedDomains = normalizeManagedDomains(domains);
  const postmaster = normalizeAddress(postmasterAddress);
  if (!normalizedDomains.includes(postmaster.domain)) {
    throw new MailTemplateError('postmaster_domain_unmanaged', 'Dovecot postmaster address must belong to a managed mail domain');
  }
  return `protocols = imap lmtp\nmail_home = /var/lib/yunpanel/mail/%d/%n\nmail_location = maildir:~/Maildir\n\nservice lmtp {\n  unix_listener /var/spool/postfix/private/dovecot-lmtp {\n    mode = 0600\n    user = postfix\n    group = postfix\n  }\n}\n\nprotocol lmtp {\n  auth_username_format = %Lu\n  postmaster_address = ${postmaster.address}\n}\n`;
}

export function previewDovecotVirtualMailConfig(input = {}) {
  const rendered = [
    [DOVECOT_AUTH_CONFIG_PATH, renderDovecotAuthConfig()],
    [DOVECOT_MAIL_CONFIG_PATH, renderDovecotMailConfig(input)],
  ];
  const artifacts = Object.freeze(rendered.map(([path, content]) => Object.freeze({
    version: 1,
    path,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    content,
    sensitive: false,
    sideEffects: false,
  })));
  return Object.freeze({
    version: 1,
    sha256: createHash('sha256').update(JSON.stringify(
      artifacts.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    )).digest('hex'),
    artifacts,
    validate: Object.freeze({ file: '/usr/bin/doveconf', args: Object.freeze(['-n']) }),
    requirements: Object.freeze(['dovecot_2_3', 'vmail_identity', 'postfix_identity', 'mail_tls_material']),
    sideEffects: false,
  });
}

export const mailTemplatePolicy = Object.freeze({
  maxManagedDomains: MAX_MANAGED_DOMAINS,
  maxMailboxes: MAX_MAILBOXES,
  maxAliases: MAX_ALIASES,
  maxAliasDestinations: MAX_ALIAS_DESTINATIONS,
  postfixVirtualDomainMapPath: POSTFIX_VIRTUAL_DOMAIN_MAP_PATH,
  postfixVirtualMailboxMapPath: POSTFIX_VIRTUAL_MAILBOX_MAP_PATH,
  postfixVirtualAliasMapPath: POSTFIX_VIRTUAL_ALIAS_MAP_PATH,
  dovecotPasswdFilePath: DOVECOT_PASSWD_FILE_PATH,
  dovecotAuthConfigPath: DOVECOT_AUTH_CONFIG_PATH,
  dovecotMailConfigPath: DOVECOT_MAIL_CONFIG_PATH,
});
