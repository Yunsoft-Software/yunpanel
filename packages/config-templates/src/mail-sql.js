import { createHash } from 'node:crypto';
import {
  mailTemplatePolicy,
  normalizeMailboxAddress,
  renderPostfixVirtualAliasMap,
  renderPostfixVirtualDomainMap,
} from './mail.js';
import { renderDovecotQuotaPasswdFile } from './mail-quota.js';

const DB_PATH = '/var/lib/yunpanel/mail/virtual-mail.sqlite3';
const SEED_PATH = '/etc/yunpanel/mail/sql/virtual-mail.sql';
const DOVECOT_SQL_PATH = '/etc/dovecot/yunpanel-sql.conf.ext';
const POSTFIX_SQL_DIRECTORY = '/etc/postfix/yunpanel-sql';
const POSTFIX_DOMAIN_PATH = POSTFIX_SQL_DIRECTORY + '/virtual-domains.cf';
const POSTFIX_MAILBOX_PATH = POSTFIX_SQL_DIRECTORY + '/virtual-mailboxes.cf';
const POSTFIX_ALIAS_PATH = POSTFIX_SQL_DIRECTORY + '/virtual-aliases.cf';
const POSTFIX_SENDER_LOGIN_PATH = POSTFIX_SQL_DIRECTORY + '/sender-login.cf';

export class MailSqlTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailSqlTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sqlLiteral(value) {
  if (typeof value !== 'string' || /[\u0000\r\n]/.test(value)) {
    throw new MailSqlTemplateError('invalid_mail_sql_value', 'Managed mail SQL value is invalid');
  }
  return "'" + value.replaceAll("'", "''") + "'";
}

function canonicalDomains(domains) {
  const rendered = renderPostfixVirtualDomainMap(domains);
  return Object.freeze(rendered === '' ? [] : rendered.trimEnd().split('\n').map((line) => {
    const separator = line.indexOf(' ');
    if (separator < 1 || line.slice(separator + 1) !== 'OK') {
      throw new MailSqlTemplateError('invalid_mail_sql_domain_set', 'Managed mail domain set is invalid');
    }
    return line.slice(0, separator);
  }));
}

function canonicalAliases(domains, aliases) {
  const rendered = renderPostfixVirtualAliasMap({ domains, aliases });
  if (rendered === '') return Object.freeze([]);
  return Object.freeze(rendered.trimEnd().split('\n').map((line) => {
    const separator = line.indexOf(' ');
    if (separator < 1) {
      throw new MailSqlTemplateError('invalid_mail_sql_alias_set', 'Managed mail alias set is invalid');
    }
    return Object.freeze({
      source: line.slice(0, separator),
      destinations: line.slice(separator + 1),
    });
  }));
}

function canonicalAccounts(domains, accounts) {
  const rendered = renderDovecotQuotaPasswdFile({ domains, accounts });
  if (rendered === '') return Object.freeze([]);
  return Object.freeze(rendered.trimEnd().split('\n').map((line) => {
    const first = line.indexOf(':');
    const marker = '::::::';
    const markerIndex = line.indexOf(marker, first + 1);
    if (first < 1 || markerIndex < first + 2) {
      throw new MailSqlTemplateError('invalid_mail_sql_account_set', 'Managed mail account set is invalid');
    }
    const address = normalizeMailboxAddress(line.slice(0, first)).address;
    const password = line.slice(first + 1, markerIndex);
    const quotaField = line.slice(markerIndex + marker.length);
    let quotaBytes = null;
    if (quotaField !== '') {
      const match = quotaField.match(/^userdb_quota_rule=\*:bytes=(\d+)$/);
      if (!match) {
        throw new MailSqlTemplateError('invalid_mail_sql_quota', 'Managed mail SQL quota is invalid');
      }
      quotaBytes = Number.parseInt(match[1], 10);
      if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) {
        throw new MailSqlTemplateError('invalid_mail_sql_quota', 'Managed mail SQL quota is invalid');
      }
    }
    const separator = address.indexOf('@');
    return Object.freeze({
      address,
      localPart: address.slice(0, separator),
      domain: address.slice(separator + 1),
      password,
      quotaBytes,
    });
  }));
}

function assertCanonicalSet(domains, accounts, aliases) {
  const domainSet = new Set(domains);
  const mailboxSet = new Set(accounts.map((account) => account.address));
  if (mailboxSet.size !== accounts.length) {
    throw new MailSqlTemplateError('duplicate_mail_sql_mailbox', 'Managed mail SQL mailbox identities are duplicated');
  }
  if (accounts.some((account) => !domainSet.has(account.domain))) {
    throw new MailSqlTemplateError('mail_sql_mailbox_domain_unmanaged', 'Managed mail SQL mailbox is outside the managed domain set');
  }
  if (aliases.some((alias) => mailboxSet.has(alias.source))) {
    throw new MailSqlTemplateError('mail_sql_alias_mailbox_conflict', 'Managed mail SQL identity cannot be both mailbox and alias');
  }
}

export function renderManagedMailSqlSeed({
  domains = [],
  accounts = [],
  aliases = [],
} = {}) {
  const normalizedDomains = canonicalDomains(domains);
  const normalizedAccounts = canonicalAccounts(normalizedDomains, accounts);
  const normalizedAliases = canonicalAliases(normalizedDomains, aliases);
  assertCanonicalSet(normalizedDomains, normalizedAccounts, normalizedAliases);

  const lines = [
    'PRAGMA foreign_keys = ON;',
    'BEGIN IMMEDIATE;',
    'CREATE TABLE IF NOT EXISTS virtual_domains (',
    '  domain TEXT PRIMARY KEY NOT NULL,',
    '  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))',
    ');',
    'CREATE TABLE IF NOT EXISTS virtual_mailboxes (',
    '  address TEXT PRIMARY KEY NOT NULL,',
    '  domain TEXT NOT NULL REFERENCES virtual_domains(domain) ON DELETE CASCADE,',
    '  local_part TEXT NOT NULL,',
    '  password TEXT NOT NULL,',
    '  quota_bytes INTEGER NULL CHECK (quota_bytes IS NULL OR quota_bytes > 0),',
    '  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))',
    ');',
    'CREATE TABLE IF NOT EXISTS virtual_aliases (',
    '  source TEXT PRIMARY KEY NOT NULL,',
    '  domain TEXT NOT NULL REFERENCES virtual_domains(domain) ON DELETE CASCADE,',
    '  destinations TEXT NOT NULL,',
    '  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))',
    ');',
    'DELETE FROM virtual_aliases;',
    'DELETE FROM virtual_mailboxes;',
    'DELETE FROM virtual_domains;',
  ];

  for (const domain of normalizedDomains) {
    lines.push('INSERT INTO virtual_domains(domain, enabled) VALUES (' + sqlLiteral(domain) + ', 1);');
  }
  for (const account of normalizedAccounts) {
    lines.push(
      'INSERT INTO virtual_mailboxes(address, domain, local_part, password, quota_bytes, enabled) VALUES ('
      + [
        sqlLiteral(account.address),
        sqlLiteral(account.domain),
        sqlLiteral(account.localPart),
        sqlLiteral(account.password),
        account.quotaBytes === null ? 'NULL' : String(account.quotaBytes),
        '1',
      ].join(', ')
      + ');',
    );
  }
  for (const alias of normalizedAliases) {
    const domain = normalizeMailboxAddress(alias.source).domain;
    lines.push(
      'INSERT INTO virtual_aliases(source, domain, destinations, enabled) VALUES ('
      + [sqlLiteral(alias.source), sqlLiteral(domain), sqlLiteral(alias.destinations), '1'].join(', ')
      + ');',
    );
  }
  lines.push('COMMIT;', '');
  return lines.join('\n');
}

function publicArtifact(path, content) {
  return Object.freeze({
    version: 1,
    path,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    sensitive: false,
    content,
    sideEffects: false,
  });
}

function sensitiveArtifact(path, content) {
  return Object.freeze({
    version: 1,
    path,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    sensitive: true,
    contentIncluded: false,
    sideEffects: false,
  });
}

function renderPostfixSqlLookup(query) {
  return [
    'dbpath = ' + DB_PATH,
    'query = ' + query,
    '',
  ].join('\n');
}

export function renderPostfixSqlDomainLookup() {
  return renderPostfixSqlLookup("SELECT '1' FROM virtual_domains WHERE domain = '%s' AND enabled = 1");
}

export function renderPostfixSqlMailboxLookup() {
  return renderPostfixSqlLookup("SELECT '1' FROM virtual_mailboxes WHERE address = '%s' AND enabled = 1");
}

export function renderPostfixSqlAliasLookup() {
  return renderPostfixSqlLookup("SELECT destinations FROM virtual_aliases WHERE source = '%s' AND enabled = 1");
}

export function renderPostfixSqlSenderLoginLookup() {
  return renderPostfixSqlLookup("SELECT address FROM virtual_mailboxes WHERE address = '%s' AND enabled = 1");
}

export function renderDovecotSqlConfig() {
  return [
    'driver = sqlite',
    'connect = ' + DB_PATH,
    "password_query = SELECT password, CASE WHEN quota_bytes IS NULL THEN NULL ELSE '*:bytes=' || quota_bytes END AS userdb_quota_rule FROM virtual_mailboxes WHERE address = '%u' AND enabled = 1",
    '',
  ].join('\n');
}

export function renderDovecotSqlAuthConfig() {
  return [
    'disable_plaintext_auth = yes',
    'auth_mechanisms = plain login',
    'auth_username_format = %Lu',
    '',
    'passdb {',
    '  driver = sql',
    '  args = ' + DOVECOT_SQL_PATH,
    '  result_failure = return-fail',
    '  result_internalfail = return-fail',
    '  result_success = return-ok',
    '}',
    '',
    'userdb {',
    '  driver = static',
    '  args = uid=vmail gid=vmail home=/var/lib/yunpanel/mail/%d/%n mail=maildir:~/Maildir',
    '  result_failure = return-fail',
    '  result_internalfail = return-fail',
    '  result_success = return-ok',
    '}',
    '',
  ].join('\n');
}

export function previewManagedMailSqlConfiguration(input = {}) {
  const seed = renderManagedMailSqlSeed(input);
  const artifacts = Object.freeze([
    sensitiveArtifact(SEED_PATH, seed),
    publicArtifact(POSTFIX_DOMAIN_PATH, renderPostfixSqlDomainLookup()),
    publicArtifact(POSTFIX_MAILBOX_PATH, renderPostfixSqlMailboxLookup()),
    publicArtifact(POSTFIX_ALIAS_PATH, renderPostfixSqlAliasLookup()),
    publicArtifact(POSTFIX_SENDER_LOGIN_PATH, renderPostfixSqlSenderLoginLookup()),
    publicArtifact(DOVECOT_SQL_PATH, renderDovecotSqlConfig()),
    publicArtifact(mailTemplatePolicy.dovecotAuthConfigPath, renderDovecotSqlAuthConfig()),
  ]);
  const identity = {
    version: 1,
    databasePath: DB_PATH,
    artifactDigests: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
  };
  return Object.freeze({
    version: 1,
    sha256: sha256(JSON.stringify(identity)),
    databasePath: DB_PATH,
    artifacts,
    postfixLookups: Object.freeze({
      domains: 'proxy:sqlite:' + POSTFIX_DOMAIN_PATH,
      mailboxes: 'proxy:sqlite:' + POSTFIX_MAILBOX_PATH,
      aliases: 'proxy:sqlite:' + POSTFIX_ALIAS_PATH,
      senderLogin: 'proxy:sqlite:' + POSTFIX_SENDER_LOGIN_PATH,
    }),
    requirements: Object.freeze(['sqlite3', 'postfix_sqlite', 'dovecot_sqlite']),
    sideEffects: false,
  });
}

export const mailSqlTemplatePolicy = Object.freeze({
  databasePath: DB_PATH,
  seedPath: SEED_PATH,
  dovecotSqlPath: DOVECOT_SQL_PATH,
  postfixSqlDirectory: POSTFIX_SQL_DIRECTORY,
  postfixDomainPath: POSTFIX_DOMAIN_PATH,
  postfixMailboxPath: POSTFIX_MAILBOX_PATH,
  postfixAliasPath: POSTFIX_ALIAS_PATH,
  postfixSenderLoginPath: POSTFIX_SENDER_LOGIN_PATH,
  databaseMode: 0o640,
  seedMode: 0o600,
  publicConfigMode: 0o640,
});

export const mailSqlTemplateInternals = Object.freeze({
  sqlLiteral,
  canonicalDomains,
  canonicalAliases,
  canonicalAccounts,
  assertCanonicalSet,
});
