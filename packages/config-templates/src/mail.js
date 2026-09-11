import { createHash } from 'node:crypto';
import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const MAX_MANAGED_DOMAINS = 1_000;
const POSTFIX_VIRTUAL_DOMAIN_MAP_PATH = '/etc/yunpanel/mail/postfix/virtual-domains';

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

export function renderPostfixVirtualDomainMap(domains) {
  const normalized = normalizeManagedDomains(domains);
  return normalized.length === 0 ? '' : `${normalized.map((domain) => `${domain} OK`).join('\n')}\n`;
}

export function previewPostfixVirtualDomainMap(domains) {
  const content = renderPostfixVirtualDomainMap(domains);
  return Object.freeze({
    version: 1,
    path: POSTFIX_VIRTUAL_DOMAIN_MAP_PATH,
    lookup: `hash:${POSTFIX_VIRTUAL_DOMAIN_MAP_PATH}`,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    entries: content === '' ? 0 : content.split('\n').length - 1,
    content,
    compile: Object.freeze({ file: '/usr/sbin/postmap', args: Object.freeze([`hash:${POSTFIX_VIRTUAL_DOMAIN_MAP_PATH}`]) }),
    validate: Object.freeze({ file: '/usr/sbin/postfix', args: Object.freeze(['check']) }),
    sideEffects: false,
  });
}

export const mailTemplatePolicy = Object.freeze({
  maxManagedDomains: MAX_MANAGED_DOMAINS,
  postfixVirtualDomainMapPath: POSTFIX_VIRTUAL_DOMAIN_MAP_PATH,
});
