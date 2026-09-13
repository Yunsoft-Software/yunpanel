import path from 'node:path';
import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';
import { MailTemplateError, normalizeMailboxAddress } from './mail.js';

const MAIL_DATA_ROOT = '/var/lib/yunpanel/mail';

export class MailDataTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDataTemplateError';
    this.code = code;
  }
}

function canonicalDomain(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) {
      throw new MailDataTemplateError('invalid_mail_data_domain', 'Mail data domain is invalid');
    }
    throw error;
  }
}

export function mailDomainDataPath(value) {
  const domain = canonicalDomain(value);
  return path.posix.join(MAIL_DATA_ROOT, domain);
}

export function mailboxDataPath(value) {
  let mailbox;
  try { mailbox = normalizeMailboxAddress(value); }
  catch (error) {
    if (error instanceof MailTemplateError) {
      throw new MailDataTemplateError('invalid_mail_data_mailbox', 'Mail data mailbox address is invalid');
    }
    throw error;
  }
  const localPart = mailbox.address.slice(0, mailbox.address.indexOf('@'));
  return path.posix.join(MAIL_DATA_ROOT, mailbox.domain, localPart);
}

export const mailDataTemplatePolicy = Object.freeze({
  root: MAIL_DATA_ROOT,
});

export const mailDataTemplateInternals = Object.freeze({
  canonicalDomain,
});
