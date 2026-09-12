import { createHash } from 'node:crypto';
import {
  mailTemplatePolicy,
  normalizeMailboxAddress,
  previewManagedMailConfiguration,
  renderDovecotMailConfig,
  renderDovecotPasswdFile,
} from './mail.js';

const MIN_QUOTA_BYTES = 1024 * 1024;
const MAX_QUOTA_BYTES = 16 * 1024 * 1024 * 1024 * 1024;

export class MailQuotaTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailQuotaTemplateError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeQuotaBytes(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < MIN_QUOTA_BYTES || value > MAX_QUOTA_BYTES) {
    throw new MailQuotaTemplateError(
      'invalid_mailbox_quota_bytes',
      `Mailbox quota must be null or an integer between ${MIN_QUOTA_BYTES} and ${MAX_QUOTA_BYTES} bytes`,
    );
  }
  return value;
}

function normalizeQuotaAccounts(domains, accounts) {
  if (!Array.isArray(accounts)) {
    throw new MailQuotaTemplateError('invalid_mailbox_accounts', 'Mailbox accounts must be an array');
  }
  const normalized = accounts.map((account) => {
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      throw new MailQuotaTemplateError('invalid_mailbox_account', 'Mailbox account is invalid');
    }
    const keys = Object.keys(account).sort();
    const allowed = account.quotaBytes === undefined
      ? ['address', 'passwordHash']
      : ['address', 'passwordHash', 'quotaBytes'];
    if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
      throw new MailQuotaTemplateError(
        'invalid_mailbox_account',
        'Mailbox account must contain only address, passwordHash and optional quotaBytes',
      );
    }
    const address = normalizeMailboxAddress(account.address).address;
    return Object.freeze({
      address,
      passwordHash: account.passwordHash,
      quotaBytes: normalizeQuotaBytes(account.quotaBytes),
    });
  }).sort((left, right) => left.address.localeCompare(right.address));

  if (new Set(normalized.map((account) => account.address)).size !== normalized.length) {
    throw new MailQuotaTemplateError('duplicate_mailbox', 'Mailbox accounts must be unique after canonicalization');
  }

  const stripped = normalized.map((account) => ({ address: account.address, passwordHash: account.passwordHash }));
  // Reuse the existing managed-mail validator for domain scope and Argon2id policy.
  renderDovecotPasswdFile({ domains, accounts: stripped });
  return Object.freeze(normalized);
}

export function renderDovecotQuotaPasswdFile({ domains, accounts } = {}) {
  const normalized = normalizeQuotaAccounts(domains, accounts);
  if (normalized.length === 0) return '';
  const credentials = renderDovecotPasswdFile({
    domains,
    accounts: normalized.map((account) => ({ address: account.address, passwordHash: account.passwordHash })),
  }).trimEnd().split('\n');
  const passwordByAddress = new Map(credentials.map((line) => {
    const separator = line.indexOf(':');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return `${normalized.map((account) => {
    const password = passwordByAddress.get(account.address);
    const extra = account.quotaBytes === null ? '' : `userdb_quota_rule=*:bytes=${account.quotaBytes}`;
    return `${account.address}:${password}::::::${extra}`;
  }).join('\n')}\n`;
}

export function renderDovecotQuotaAuthConfig() {
  return `disable_plaintext_auth = yes\nauth_mechanisms = plain login\nauth_username_format = %Lu\n\npassdb {\n  driver = passwd-file\n  args = username_format=%u ${mailTemplatePolicy.dovecotPasswdFilePath}\n  result_failure = return-fail\n  result_internalfail = return-fail\n  result_success = return-ok\n}\n\nuserdb {\n  driver = passwd-file\n  args = username_format=%u ${mailTemplatePolicy.dovecotPasswdFilePath}\n  default_fields = uid=vmail gid=vmail home=/var/lib/yunpanel/mail/%d/%n mail=maildir:~/Maildir\n  result_failure = return-fail\n  result_internalfail = return-fail\n  result_success = return-ok\n}\n`;
}

export function renderDovecotQuotaMailConfig({ domains, postmasterAddress } = {}) {
  return `${renderDovecotMailConfig({ domains, postmasterAddress })}\nmail_plugins = $mail_plugins quota\n\nprotocol imap {\n  mail_plugins = $mail_plugins imap_quota\n}\n\nplugin {\n  quota = maildir:User quota\n}\n`;
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

function sensitivePasswdArtifact(content) {
  return Object.freeze({
    version: 1,
    path: mailTemplatePolicy.dovecotPasswdFilePath,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    entries: content === '' ? 0 : content.split('\n').length - 1,
    sensitive: true,
    contentIncluded: false,
    validate: Object.freeze({ file: '/usr/bin/doveconf', args: Object.freeze(['-n']) }),
    sideEffects: false,
  });
}

export function previewManagedMailQuotaConfiguration({
  domains,
  mailboxes = [],
  aliases = [],
  accounts = [],
  postmasterAddress,
} = {}) {
  const normalizedAccounts = normalizeQuotaAccounts(domains, accounts);
  const base = previewManagedMailConfiguration({
    domains,
    mailboxes,
    aliases,
    accounts: normalizedAccounts.map((account) => ({
      address: account.address,
      passwordHash: account.passwordHash,
    })),
    postmasterAddress,
  });
  const passwd = renderDovecotQuotaPasswdFile({ domains, accounts: normalizedAccounts });
  const auth = renderDovecotQuotaAuthConfig();
  const mail = renderDovecotQuotaMailConfig({ domains, postmasterAddress });
  const replacements = new Map([
    [mailTemplatePolicy.dovecotPasswdFilePath, sensitivePasswdArtifact(passwd)],
    [mailTemplatePolicy.dovecotAuthConfigPath, publicArtifact(mailTemplatePolicy.dovecotAuthConfigPath, auth)],
    [mailTemplatePolicy.dovecotMailConfigPath, publicArtifact(mailTemplatePolicy.dovecotMailConfigPath, mail)],
  ]);
  const artifacts = Object.freeze(base.artifacts.map((artifact) => replacements.get(artifact.path) ?? artifact));
  const quotaPolicies = Object.freeze(normalizedAccounts.map((account) => Object.freeze({
    address: account.address,
    quotaBytes: account.quotaBytes,
  })));
  const identity = {
    version: 1,
    baseSha256: base.sha256,
    quotaPolicies,
    artifactDigests: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
  };
  return Object.freeze({
    version: 1,
    sha256: sha256(JSON.stringify(identity)),
    counts: base.counts,
    artifacts,
    postfixParameters: base.postfixParameters,
    validate: base.validate,
    requirements: base.requirements,
    readyToApply: false,
    sideEffects: false,
  });
}

export const mailQuotaTemplatePolicy = Object.freeze({
  minQuotaBytes: MIN_QUOTA_BYTES,
  maxQuotaBytes: MAX_QUOTA_BYTES,
});
