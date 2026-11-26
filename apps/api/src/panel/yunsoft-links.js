import { URL } from 'node:url';
import { assertNoDot44Host } from './production-exit-gate.js';

export const DEFAULT_YUNSOFT_PREMIUM_OFFER_URL = 'https://yunsoft.com/kampanya/premium-3-ay';
export const DEFAULT_YUNSOFT_DOCS_URL = 'https://yunsoft.com/docs/yunpanel';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_URL_LENGTH = 512;

export function parseStrictYunsoftPublicUrl(rawUrl, { development = false } = {}) {
  if (typeof rawUrl !== 'string') {
    return Object.freeze({ ok: false, url: null, reason: 'EMPTY_URL' });
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    return Object.freeze({ ok: false, url: null, reason: 'INVALID_URL_SYNTAX' });
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return Object.freeze({ ok: false, url: null, reason: 'INVALID_URL_SYNTAX' });
  }

  if (parsed.username || parsed.password) {
    return Object.freeze({ ok: false, url: null, reason: 'CREDENTIALS_FORBIDDEN' });
  }

  // Never allow query strings or hash fragments so private panel data (email, domain, instanceId)
  // cannot be appended or leaked via referral links.
  if (parsed.search || parsed.hash || trimmed.includes('?') || trimmed.includes('#')) {
    return Object.freeze({ ok: false, url: null, reason: 'QUERY_OR_HASH_FORBIDDEN' });
  }

  try {
    assertNoDot44Host(parsed.href, 'yunsoftPublicUrl');
    assertNoDot44Host(parsed.hostname, 'yunsoftPublicUrl.host');
  } catch {
    return Object.freeze({ ok: false, url: null, reason: 'FORBIDDEN_HOST_DOT44' });
  }

  const hostLower = parsed.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(hostLower);
  const allowHttpLoopback = Boolean(development && isLoopback);
  if (parsed.protocol !== 'https:' && !(allowHttpLoopback && parsed.protocol === 'http:')) {
    return Object.freeze({ ok: false, url: null, reason: 'INSECURE_URL_PROTOCOL' });
  }

  // Reject '@' or encoded '@' in pathname as defense-in-depth against email leakage in path segments.
  if (parsed.pathname.includes('@') || /%40/i.test(parsed.pathname)) {
    return Object.freeze({ ok: false, url: null, reason: 'PII_IN_PATH_FORBIDDEN' });
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
  const canonical = normalizedPath === '/' ? parsed.origin : `${parsed.origin}${normalizedPath}`;
  return Object.freeze({ ok: true, url: canonical, reason: null });
}

export function resolveYunsoftPublicUrl(rawUrl, { fallbackUrl, development = false } = {}) {
  const checked = parseStrictYunsoftPublicUrl(rawUrl, { development });
  if (checked.ok) {
    return checked.url;
  }
  const fallbackChecked = parseStrictYunsoftPublicUrl(fallbackUrl, { development });
  return fallbackChecked.ok ? fallbackChecked.url : null;
}

export function defaultPremiumOfferUrl({ env = process.env, development = false } = {}) {
  return resolveYunsoftPublicUrl(env?.YUNPANEL_PREMIUM_OFFER_URL, {
    fallbackUrl: DEFAULT_YUNSOFT_PREMIUM_OFFER_URL,
    development,
  });
}

export function defaultDocsUrl({ env = process.env, development = false } = {}) {
  return resolveYunsoftPublicUrl(env?.YUNPANEL_DOCS_URL, {
    fallbackUrl: DEFAULT_YUNSOFT_DOCS_URL,
    development,
  });
}

export function buildSetupOfferMetadata({
  offerUrl = undefined,
  docsUrl = undefined,
  env = process.env,
  development = false,
} = {}) {
  const resolvedOfferUrl = resolveYunsoftPublicUrl(
    offerUrl !== undefined ? offerUrl : env?.YUNPANEL_PREMIUM_OFFER_URL,
    { fallbackUrl: DEFAULT_YUNSOFT_PREMIUM_OFFER_URL, development },
  );
  const resolvedDocsUrl = resolveYunsoftPublicUrl(
    docsUrl !== undefined ? docsUrl : env?.YUNPANEL_DOCS_URL,
    { fallbackUrl: DEFAULT_YUNSOFT_DOCS_URL, development },
  );
  return Object.freeze({
    enabled: Boolean(resolvedOfferUrl),
    durationMonths: 3,
    creditCardRequired: false,
    managedBy: 'yunsoft-website',
    products: Object.freeze(['yunpanel', 'yuncms']),
    offerUrl: resolvedOfferUrl,
    docsUrl: resolvedDocsUrl,
  });
}
