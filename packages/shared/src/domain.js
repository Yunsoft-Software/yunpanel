import { domainToASCII } from 'node:url';

export class DomainValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainValidationError';
    this.code = code;
  }
}

export function normalizeDomainName(value) {
  if (typeof value !== 'string') return '';
  const input = value.trim().replace(/[\u3002\uff0e\uff61]/g, '.').replace(/\.$/, '');
  if (!input) return '';
  if (input.includes('*')) return input.toLowerCase();
  if (/[\u0000-\u001f\u007f]/.test(input)) return '';
  try {
    return domainToASCII(input.normalize('NFC')).toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function validateDomainName(value) {
  const domain = normalizeDomainName(value);

  if (!domain || domain.length > 253) {
    return { ok: false, code: 'invalid_domain_length', message: 'Domain must contain 1 to 253 characters' };
  }

  if (domain.includes('*')) {
    return { ok: false, code: 'wildcard_not_supported', message: 'Wildcard domains are not supported in V1' };
  }

  const labels = domain.split('.');
  if (labels.length < 2) {
    return { ok: false, code: 'fqdn_required', message: 'A fully qualified domain name is required' };
  }

  for (const label of labels) {
    if (label.length < 1 || label.length > 63) {
      return { ok: false, code: 'invalid_domain_label', message: 'Each domain label must contain 1 to 63 characters' };
    }

    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      return { ok: false, code: 'invalid_domain_label', message: 'Domain labels may only contain letters, numbers and interior hyphens' };
    }
  }

  return { ok: true, value: domain };
}

export function assertDomainName(value) {
  const result = validateDomainName(value);
  if (!result.ok) throw new DomainValidationError(result.code, result.message);
  return result.value;
}

export function normalizeDomainSet(primaryDomain, aliases = []) {
  const primary = assertDomainName(primaryDomain);
  if (!Array.isArray(aliases)) {
    throw new DomainValidationError('invalid_aliases', 'Domain aliases must be an array');
  }

  const normalizedAliases = [];
  const seen = new Set([primary]);
  for (const alias of aliases) {
    const normalized = assertDomainName(alias);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    normalizedAliases.push(normalized);
  }

  if (normalizedAliases.length > 20) {
    throw new DomainValidationError('too_many_aliases', 'A domain may have at most 20 aliases in V1');
  }

  return { primary, aliases: normalizedAliases };
}
