import { createHash } from 'node:crypto';
import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const MAX_DKIM_DOMAINS = 1_000;
const SELECTOR_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const CONFIG_PATH = '/etc/rspamd/local.d/dkim_signing.conf';
const KEY_ROOT = '/etc/yunpanel/mail/dkim';

export class MailDkimTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDkimTemplateError';
    this.code = code;
  }
}

function canonicalDomain(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) {
      throw new MailDkimTemplateError('invalid_dkim_domain', error.message);
    }
    throw error;
  }
}

function selector(value) {
  if (typeof value !== 'string' || !SELECTOR_PATTERN.test(value)) {
    throw new MailDkimTemplateError(
      'invalid_dkim_selector',
      'DKIM selector must contain only lowercase letters, numbers and interior hyphens',
    );
  }
  return value;
}

function publicKey(value) {
  if (typeof value !== 'string' || value.length < 128 || value.length > 4096 || !PUBLIC_KEY_PATTERN.test(value)) {
    throw new MailDkimTemplateError('invalid_dkim_public_key', 'DKIM public key is invalid');
  }
  let decoded;
  try { decoded = Buffer.from(value, 'base64'); }
  catch { throw new MailDkimTemplateError('invalid_dkim_public_key', 'DKIM public key is invalid'); }
  if (decoded.length < 128 || decoded.length > 1024 || decoded.toString('base64') !== value) {
    throw new MailDkimTemplateError('invalid_dkim_public_key', 'DKIM public key is not canonical base64');
  }
  return value;
}

function keyPath(domain, dkimSelector) {
  return `${KEY_ROOT}/${domain}.${dkimSelector}.key`;
}

function normalizePolicies(values) {
  if (!Array.isArray(values) || values.length > MAX_DKIM_DOMAINS) {
    throw new MailDkimTemplateError(
      'invalid_dkim_policies',
      `Managed DKIM policies must contain at most ${MAX_DKIM_DOMAINS} entries`,
    );
  }
  const domains = new Set();
  const normalized = values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 3
      || !Object.hasOwn(value, 'domain') || !Object.hasOwn(value, 'selector') || !Object.hasOwn(value, 'publicKey')) {
      throw new MailDkimTemplateError(
        'invalid_dkim_policy',
        'DKIM policy must contain only domain, selector and publicKey',
      );
    }
    const domain = canonicalDomain(value.domain);
    if (domains.has(domain)) {
      throw new MailDkimTemplateError('duplicate_dkim_domain', 'Managed DKIM domains must be unique');
    }
    domains.add(domain);
    const dkimSelector = selector(value.selector);
    return Object.freeze({
      domain,
      selector: dkimSelector,
      publicKey: publicKey(value.publicKey),
      keyPath: keyPath(domain, dkimSelector),
    });
  });
  return Object.freeze(normalized.sort((left, right) => left.domain.localeCompare(right.domain)));
}

export function renderRspamdDkimSigningConfig(policies = []) {
  const normalized = normalizePolicies(policies);
  const lines = [
    'enabled = true;',
    'sign_authenticated = true;',
    'sign_local = true;',
    'sign_inbound = false;',
    'use_domain = "header";',
    'use_esld = false;',
    'try_fallback = false;',
    'check_pubkey = true;',
    'allow_pubkey_mismatch = false;',
    '',
    'domain {',
  ];
  for (const policy of normalized) {
    lines.push(
      `  ${policy.domain} {`,
      `    selector = "${policy.selector}";`,
      `    path = "${policy.keyPath}";`,
      '  }',
    );
  }
  lines.push('}', '');
  return `${lines.join('\n')}\n`;
}

export function managedDkimDnsRecord({ domain, selector: requestedSelector, publicKey: requestedPublicKey } = {}) {
  const normalized = normalizePolicies([{
    domain,
    selector: requestedSelector,
    publicKey: requestedPublicKey,
  }])[0];
  return Object.freeze({
    type: 'TXT',
    name: `${normalized.selector}._domainkey.${normalized.domain}`,
    value: `v=DKIM1; k=rsa; p=${normalized.publicKey}`,
  });
}

export function previewRspamdDkimSigningConfig(policies = []) {
  const normalized = normalizePolicies(policies);
  const content = renderRspamdDkimSigningConfig(normalized.map((policy) => ({
    domain: policy.domain,
    selector: policy.selector,
    publicKey: policy.publicKey,
  })));
  const artifact = Object.freeze({
    version: 1,
    path: CONFIG_PATH,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    content,
    sensitive: false,
    sideEffects: false,
  });
  const dnsRecords = Object.freeze(normalized.map((policy) => managedDkimDnsRecord(policy)));
  const identity = {
    version: 1,
    artifact: { path: artifact.path, sha256: artifact.sha256 },
    dnsRecords,
  };
  return Object.freeze({
    version: 1,
    sha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    artifact,
    dnsRecords,
    validate: Object.freeze({ file: '/usr/bin/rspamadm', args: Object.freeze(['configtest']) }),
    sideEffects: false,
  });
}

export const mailDkimTemplatePolicy = Object.freeze({
  maxDomains: MAX_DKIM_DOMAINS,
  selectorPattern: SELECTOR_PATTERN,
  configPath: CONFIG_PATH,
  keyRoot: KEY_ROOT,
  keyPath,
});
