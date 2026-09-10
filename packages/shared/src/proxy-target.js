import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export class ProxyTargetValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProxyTargetValidationError';
    this.code = code;
  }
}

export function normalizeProxyHost(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 253
    || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new ProxyTargetValidationError('invalid_proxy_host', 'Proxy host must be an IP address or DNS hostname without a URL scheme or path');
  }
  const trimmed = value.trim();
  const bracketed = trimmed.startsWith('[') && trimmed.endsWith(']');
  if ((trimmed.includes('[') || trimmed.includes(']')) && !bracketed) {
    throw new ProxyTargetValidationError('invalid_proxy_host', 'Proxy host must be an IP address or DNS hostname without a URL scheme or path');
  }
  const input = bracketed ? trimmed.slice(1, -1) : trimmed;
  const ipVersion = isIP(input);
  if (ipVersion === 4) return input;
  if (ipVersion === 6) return new URL(`http://[${input}]/`).hostname.slice(1, -1);
  if (/[/:?#@[\]]/.test(input)) {
    throw new ProxyTargetValidationError('invalid_proxy_host', 'Proxy host must be an IP address or DNS hostname without a URL scheme or path');
  }
  const ascii = domainToASCII(input).toLowerCase().replace(/\.$/, '');
  if (!ascii || ascii.length > 253
    || ascii.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new ProxyTargetValidationError('invalid_proxy_host', 'Proxy host must be an IP address or DNS hostname without a URL scheme or path');
  }
  return ascii;
}

export function formatProxyHostForUrl(value) {
  const host = normalizeProxyHost(value);
  return isIP(host) === 6 ? `[${host}]` : host;
}
