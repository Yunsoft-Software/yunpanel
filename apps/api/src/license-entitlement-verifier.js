import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { domainToASCII, URL } from 'node:url';

export const ENTITLEMENT_TOKEN_TYPE = 'YUNSOFT-ENTITLEMENT+JWT';
export const ENTITLEMENT_ISSUER = 'yunsoft-commerce';
export const YUNPANEL_PRODUCT_CODE = 'yunpanel_premium';
export const MAX_TOKEN_LENGTH = 32_768;
export const CLOCK_SKEW_TOLERANCE_SECONDS = 30;
export const RENEWAL_NOTICE_DAYS = 7;

export const FREE_BASELINE_CAPABILITIES = Object.freeze({
  singlePanelUser: true,
  singlePanelUserUnlimitedSites: true,
  webStackManagement: true,
  sslAndDnsManagement: true,
  backupsAndMonitoring: true,
  aiOperations: false,
  resellerAccounts: false,
  perSiteIsolatedUsers: false,
});

export const PREMIUM_CAPABILITIES = Object.freeze({
  singlePanelUser: true,
  singlePanelUserUnlimitedSites: true,
  webStackManagement: true,
  sslAndDnsManagement: true,
  backupsAndMonitoring: true,
  aiOperations: true,
  resellerAccounts: true,
  perSiteIsolatedUsers: true,
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KEY_ID_REGEX = /^[a-f0-9]{16}$/;
const PUBLIC_KEY_BLOCK_REGEX = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g;

export function isCanonicalBase64Url(segment) {
  if (typeof segment !== 'string' || segment.length === 0) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  return Buffer.from(segment, 'base64url').toString('base64url') === segment;
}

function decodeJsonSegment(segment) {
  if (!isCanonicalBase64Url(segment)) return null;
  try {
    const raw = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function computePublicKeyId(spkiDerBuffer) {
  return crypto.createHash('sha256').update(spkiDerBuffer).digest('hex').slice(0, 16);
}

export function parseTrustedPublicKeys({
  publicKeyPem = '',
  publicKeyFile = '',
  readFile = readFileSync,
} = {}) {
  const sources = [];
  if (typeof publicKeyPem === 'string' && publicKeyPem.trim().length > 0) {
    sources.push(publicKeyPem.replace(/\\n/g, '\n'));
  }
  if (typeof publicKeyFile === 'string' && publicKeyFile.trim().length > 0) {
    try {
      const content = readFile(publicKeyFile.trim(), 'utf8');
      if (typeof content === 'string' && content.trim().length > 0) {
        sources.push(content);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const failure = new Error(`Failed to read entitlement public key file: ${error.code ?? 'read_error'}`);
        failure.code = 'PUBLIC_KEY_READ_FAILED';
        throw failure;
      }
    }
  }

  const combined = sources.join('\n');
  if (/PRIVATE\s+KEY/i.test(combined)) {
    const failure = new Error('Private signing keys are strictly forbidden in YunPanel.');
    failure.code = 'PRIVATE_KEY_FORBIDDEN';
    throw failure;
  }

  const blocks = combined.match(PUBLIC_KEY_BLOCK_REGEX) ?? [];
  const trusted = new Map();
  for (const pem of blocks) {
    let publicKey;
    try {
      publicKey = crypto.createPublicKey(pem);
    } catch {
      const failure = new Error('Configured entitlement public key is not valid PEM.');
      failure.code = 'INVALID_PUBLIC_KEY_PEM';
      throw failure;
    }
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
      const failure = new Error('Configured entitlement public key must be an Ed25519 SPKI public key.');
      failure.code = 'UNSUPPORTED_PUBLIC_KEY_TYPE';
      throw failure;
    }
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
    const keyId = computePublicKeyId(spkiDer);
    trusted.set(keyId, Object.freeze({
      keyId,
      algorithm: 'Ed25519',
      publicKey,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
    }));
  }

  return trusted;
}

export function extractHostCandidate(rawInput) {
  if (typeof rawInput !== 'string') return '';
  let trimmed = rawInput.trim();
  if (!trimmed) return '';

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      trimmed = parsed.hostname;
    } catch {
      return '';
    }
  } else {
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx !== -1) trimmed = trimmed.slice(0, slashIdx);
    const queryIdx = trimmed.indexOf('?');
    if (queryIdx !== -1) trimmed = trimmed.slice(0, queryIdx);
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx !== -1) trimmed = trimmed.slice(0, hashIdx);
    if (trimmed.startsWith('[') && trimmed.includes(']')) {
      trimmed = trimmed.slice(1, trimmed.indexOf(']'));
    } else if ((trimmed.match(/:/g) || []).length === 1) {
      trimmed = trimmed.split(':')[0];
    }
  }

  return trimmed.trim().toLowerCase().replace(/\.+$/, '');
}

export function normalizeLicenseDomain(rawInput, options = {}) {
  const { allowLoopback = false } = options;
  const candidate = extractHostCandidate(rawInput);

  if (!candidate) {
    return Object.freeze({ ok: false, code: 'EMPTY_DOMAIN', normalizedDomain: null });
  }
  if (candidate.includes('*')) {
    return Object.freeze({ ok: false, code: 'WILDCARD_DOMAIN_FORBIDDEN', normalizedDomain: null });
  }
  if (LOOPBACK_HOSTS.has(candidate)) {
    if (allowLoopback) {
      return Object.freeze({ ok: true, normalizedDomain: candidate, isLoopback: true });
    }
    return Object.freeze({ ok: false, code: 'LOOPBACK_DOMAIN_FORBIDDEN', normalizedDomain: null });
  }
  if (IPV4_REGEX.test(candidate) || candidate.includes(':')) {
    return Object.freeze({ ok: false, code: 'IP_ADDRESS_DOMAIN_FORBIDDEN', normalizedDomain: null });
  }

  let ascii;
  try {
    ascii = domainToASCII(candidate).toLowerCase().replace(/\.+$/, '');
  } catch {
    return Object.freeze({ ok: false, code: 'INVALID_DOMAIN_SYNTAX', normalizedDomain: null });
  }

  if (!ascii || ascii.length > 253) {
    return Object.freeze({ ok: false, code: 'INVALID_DOMAIN_LENGTH', normalizedDomain: null });
  }

  let canonical = ascii;
  if (canonical.startsWith('www.') && canonical.split('.').length >= 3) {
    canonical = canonical.slice(4);
  }

  const labels = canonical.split('.');
  if (labels.length < 2) {
    return Object.freeze({ ok: false, code: 'SINGLE_LABEL_DOMAIN_FORBIDDEN', normalizedDomain: null });
  }

  for (const label of labels) {
    if (!label || label.length > 63 || !LABEL_REGEX.test(label)) {
      return Object.freeze({ ok: false, code: 'INVALID_DOMAIN_LABEL', normalizedDomain: null });
    }
  }

  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld) || tld.length < 2) {
    return Object.freeze({ ok: false, code: 'INVALID_DOMAIN_TLD', normalizedDomain: null });
  }

  return Object.freeze({
    ok: true,
    normalizedDomain: canonical,
    isLoopback: false,
  });
}

export function expandYunpanelAllowedHosts(normalizedDomain, options = {}) {
  const { includeWww = true, includeSameSiteApi = false } = options;
  if (!normalizedDomain) {
    return Object.freeze({ allowedHosts: Object.freeze([]), stagingHosts: Object.freeze([]) });
  }
  if (LOOPBACK_HOSTS.has(normalizedDomain)) {
    return Object.freeze({
      allowedHosts: Object.freeze([normalizedDomain]),
      stagingHosts: Object.freeze(['localhost', '127.0.0.1']),
    });
  }
  const hosts = new Set([normalizedDomain]);
  if (includeWww) hosts.add(`www.${normalizedDomain}`);
  if (includeSameSiteApi) hosts.add(`api.${normalizedDomain}`);
  const stagingHosts = [
    `staging.${normalizedDomain}`,
    `dev.${normalizedDomain}`,
    'localhost',
    '127.0.0.1',
  ];
  return Object.freeze({
    allowedHosts: Object.freeze(Array.from(hosts)),
    stagingHosts: Object.freeze(stagingHosts),
  });
}

export function isHostAllowedForYunpanelLicense(host, licenseRecord, options = {}) {
  const { allowStaging = false } = options;
  if (!host || !licenseRecord) return false;

  const cleanInput = extractHostCandidate(host);
  if (!cleanInput) return false;

  let asciiHost = cleanInput;
  if (!LOOPBACK_HOSTS.has(cleanInput) && !IPV4_REGEX.test(cleanInput) && !cleanInput.includes(':')) {
    try {
      asciiHost = domainToASCII(cleanInput).toLowerCase().replace(/\.+$/, '');
    } catch {
      return false;
    }
  }
  if (!asciiHost) return false;

  const baseDomain = licenseRecord.normalizedDomain || licenseRecord.domain;
  const fallback = expandYunpanelAllowedHosts(baseDomain, {
    includeWww: true,
    includeSameSiteApi: false,
  });
  const prodHosts = Array.isArray(licenseRecord.allowedHosts) && licenseRecord.allowedHosts.length > 0
    ? licenseRecord.allowedHosts.map((entry) => String(entry).trim().toLowerCase())
    : fallback.allowedHosts;

  if (prodHosts.includes(asciiHost)) return true;

  if (allowStaging) {
    const stageHosts = Array.isArray(licenseRecord.stagingHosts) && licenseRecord.stagingHosts.length > 0
      ? licenseRecord.stagingHosts.map((entry) => String(entry).trim().toLowerCase())
      : fallback.stagingHosts;
    if (stageHosts.includes(asciiHost)) return true;
  }

  return false;
}

export function classifyYunpanelProductCode(rawCode) {
  if (typeof rawCode !== 'string' || !rawCode.trim()) {
    return Object.freeze({ valid: false, reason: 'INVALID_PRODUCT_CODE', productCode: null });
  }
  const normalized = rawCode.trim().toLowerCase();
  if (normalized === 'yunpanel' || normalized === YUNPANEL_PRODUCT_CODE) {
    return Object.freeze({ valid: true, reason: null, productCode: YUNPANEL_PRODUCT_CODE });
  }
  if (normalized === 'yuncms' || normalized === 'yuncms_premium' || normalized.startsWith('yuncms')) {
    return Object.freeze({ valid: false, reason: 'PRODUCT_MISMATCH', productCode: null });
  }
  return Object.freeze({ valid: false, reason: 'INVALID_PRODUCT_CODE', productCode: null });
}

export function resolveBillingPeriodLabel(periodMonths) {
  if (periodMonths === 1) return 'monthly';
  if (periodMonths === 12) return 'yearly';
  if (Number.isSafeInteger(periodMonths) && periodMonths > 0) return 'custom_term';
  return null;
}

export function sanitizePremiumCapabilities(rawCapabilities) {
  if (!rawCapabilities || typeof rawCapabilities !== 'object' || Array.isArray(rawCapabilities)) {
    return PREMIUM_CAPABILITIES;
  }
  return Object.freeze({
    singlePanelUser: true,
    singlePanelUserUnlimitedSites: true,
    webStackManagement: true,
    sslAndDnsManagement: true,
    backupsAndMonitoring: true,
    aiOperations: rawCapabilities.aiOperations !== false,
    resellerAccounts: rawCapabilities.resellerAccounts !== false,
    perSiteIsolatedUsers: rawCapabilities.perSiteIsolatedUsers !== false,
  });
}

function rejectedVerification(reason, status = 'invalid', extra = {}) {
  return Object.freeze({
    valid: false,
    tier: 'free',
    status,
    reason,
    keyId: extra.keyId ?? null,
    claims: extra.claims ?? null,
    billingPeriod: extra.billingPeriod ?? null,
    periodMonths: extra.periodMonths ?? null,
    startsAt: extra.startsAt ?? null,
    expiresAt: extra.expiresAt ?? null,
    daysRemaining: 0,
    renewalRequired: status === 'expired',
    capabilities: FREE_BASELINE_CAPABILITIES,
  });
}

export function verifyYunpanelEntitlementToken(token, options = {}) {
  const {
    trustedKeys = new Map(),
    expectedDomain = null,
    expectedInstanceId = null,
    allowStaging = false,
    now = new Date(),
  } = options;

  if (!(trustedKeys instanceof Map) || trustedKeys.size === 0) {
    return rejectedVerification('PUBLIC_KEY_NOT_CONFIGURED', 'unverified');
  }

  if (typeof token !== 'string' || !token.trim() || token.length > MAX_TOKEN_LENGTH) {
    return rejectedVerification('MALFORMED_TOKEN');
  }

  const trimmed = token.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    return rejectedVerification('MALFORMED_TOKEN');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  if (
    !isCanonicalBase64Url(headerB64)
    || !isCanonicalBase64Url(payloadB64)
    || !isCanonicalBase64Url(signatureB64)
  ) {
    return rejectedVerification('MALFORMED_TOKEN');
  }

  const header = decodeJsonSegment(headerB64);
  const payload = decodeJsonSegment(payloadB64);
  if (!header || !payload) {
    return rejectedVerification('MALFORMED_TOKEN');
  }

  if (
    header.alg !== 'EdDSA'
    || header.crv !== 'Ed25519'
    || header.typ !== ENTITLEMENT_TOKEN_TYPE
    || typeof header.kid !== 'string'
    || !KEY_ID_REGEX.test(header.kid)
  ) {
    return rejectedVerification('UNSUPPORTED_TOKEN_HEADER');
  }

  const keyRecord = trustedKeys.get(header.kid);
  if (!keyRecord) {
    return rejectedVerification('KEY_ID_MISMATCH', 'invalid', { keyId: header.kid });
  }

  const signatureBuffer = Buffer.from(signatureB64, 'base64url');
  if (signatureBuffer.length !== 64) {
    return rejectedVerification('INVALID_SIGNATURE_LENGTH', 'invalid', { keyId: header.kid });
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(null, signingInput, keyRecord.publicKey, signatureBuffer);
  } catch {
    return rejectedVerification('INVALID_SIGNATURE', 'invalid', { keyId: header.kid });
  }
  if (!signatureOk) {
    return rejectedVerification('INVALID_SIGNATURE', 'invalid', { keyId: header.kid });
  }

  if (payload.iss !== ENTITLEMENT_ISSUER) {
    return rejectedVerification('INVALID_ISSUER', 'invalid', { keyId: header.kid });
  }

  if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
    return rejectedVerification('INVALID_SUBJECT', 'invalid', { keyId: header.kid });
  }

  const productCheck = classifyYunpanelProductCode(payload.productCode);
  if (!productCheck.valid) {
    return rejectedVerification(productCheck.reason, 'invalid', { keyId: header.kid });
  }

  if (payload.billingModel !== 'monthly_term') {
    return rejectedVerification('INVALID_BILLING_MODEL', 'invalid', { keyId: header.kid });
  }

  if (!Number.isSafeInteger(payload.periodMonths) || payload.periodMonths < 1 || payload.periodMonths > 120) {
    return rejectedVerification('INVALID_BILLING_PERIOD', 'invalid', { keyId: header.kid });
  }

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) {
    return rejectedVerification('INVALID_CLOCK');
  }
  const nowSeconds = Math.floor(nowMs / 1000);

  if (!Number.isSafeInteger(payload.iat) || payload.iat <= 0 || payload.iat > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) {
    return rejectedVerification('INVALID_IAT', 'invalid', { keyId: header.kid });
  }

  if (!Number.isSafeInteger(payload.nbf) || payload.nbf <= 0) {
    return rejectedVerification('INVALID_NBF', 'invalid', { keyId: header.kid });
  }
  if (payload.nbf > nowSeconds) {
    return rejectedVerification('TOKEN_NOT_YET_VALID', 'invalid', { keyId: header.kid });
  }

  if (payload.exp === null || payload.exp === undefined) {
    return rejectedVerification('MISSING_EXPIRATION_FOR_TERM_LICENSE', 'invalid', { keyId: header.kid });
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= 0 || payload.exp <= payload.iat) {
    return rejectedVerification('INVALID_EXPIRATION', 'invalid', { keyId: header.kid });
  }

  let resolvedExpiresAtMs = payload.exp * 1000;
  let resolvedExpiresAtIso = new Date(resolvedExpiresAtMs).toISOString();
  if (payload.expiresAt !== null && payload.expiresAt !== undefined) {
    if (typeof payload.expiresAt !== 'string') {
      return rejectedVerification('INVALID_EXPIRATION', 'invalid', { keyId: header.kid });
    }
    const parsedExpiresMs = Date.parse(payload.expiresAt);
    if (!Number.isFinite(parsedExpiresMs)) {
      return rejectedVerification('INVALID_EXPIRATION', 'invalid', { keyId: header.kid });
    }
    if (Math.abs(Math.floor(parsedExpiresMs / 1000) - payload.exp) > 2) {
      return rejectedVerification('INVALID_EXPIRATION', 'invalid', { keyId: header.kid });
    }
    resolvedExpiresAtMs = Math.min(resolvedExpiresAtMs, parsedExpiresMs);
    resolvedExpiresAtIso = new Date(parsedExpiresMs).toISOString();
  }

  const domainCheck = normalizeLicenseDomain(payload.domain, { allowLoopback: Boolean(allowStaging) });
  if (!domainCheck.ok) {
    return rejectedVerification('INVALID_TOKEN_DOMAIN', 'invalid', { keyId: header.kid });
  }

  if (expectedDomain !== null && expectedDomain !== undefined) {
    const allowed = isHostAllowedForYunpanelLicense(
      expectedDomain,
      {
        normalizedDomain: domainCheck.normalizedDomain,
        allowedHosts: payload.allowedHosts,
        stagingHosts: payload.stagingHosts,
      },
      { allowStaging: Boolean(allowStaging) },
    );
    if (!allowed) {
      return rejectedVerification('DOMAIN_MISMATCH', 'invalid', { keyId: header.kid });
    }
  }

  if (payload.activatedInstanceId !== null && payload.activatedInstanceId !== undefined) {
    if (typeof payload.activatedInstanceId !== 'string' || !payload.activatedInstanceId.trim()) {
      return rejectedVerification('INSTANCE_MISMATCH', 'invalid', { keyId: header.kid });
    }
    if (!expectedInstanceId || payload.activatedInstanceId.trim() !== String(expectedInstanceId).trim()) {
      return rejectedVerification('INSTANCE_MISMATCH', 'invalid', { keyId: header.kid });
    }
  }

  if (
    payload.entitlementVersion !== undefined
    && (!Number.isSafeInteger(payload.entitlementVersion) || payload.entitlementVersion < 1)
  ) {
    return rejectedVerification('INVALID_ENTITLEMENT_VERSION', 'invalid', { keyId: header.kid });
  }
  const resolvedEntitlementVersion = payload.entitlementVersion === undefined
    ? 1
    : payload.entitlementVersion;
  const resolvedLicenseId = typeof payload.licenseId === 'string' && payload.licenseId.trim()
    ? payload.licenseId.trim()
    : payload.sub.trim();

  const billingPeriod = resolveBillingPeriodLabel(payload.periodMonths);
  const startsAt = typeof payload.startsAt === 'string' && Number.isFinite(Date.parse(payload.startsAt))
    ? new Date(Date.parse(payload.startsAt)).toISOString()
    : new Date(payload.nbf * 1000).toISOString();

  const safeClaims = Object.freeze({
    iss: payload.iss,
    sub: payload.sub.trim(),
    licenseId: resolvedLicenseId,
    jti: typeof payload.jti === 'string' ? payload.jti : null,
    entitlementVersion: resolvedEntitlementVersion,
    productCode: productCheck.productCode,
    edition: typeof payload.edition === 'string' ? payload.edition : 'premium',
    billingModel: payload.billingModel,
    periodMonths: payload.periodMonths,
    billingPeriod,
    status: payload.status,
    domain: domainCheck.normalizedDomain,
    allowedHosts: Object.freeze(
      Array.isArray(payload.allowedHosts)
        ? payload.allowedHosts.filter((item) => typeof item === 'string')
        : expandYunpanelAllowedHosts(domainCheck.normalizedDomain).allowedHosts,
    ),
    activatedInstanceId: payload.activatedInstanceId ?? null,
    startsAt,
    expiresAt: resolvedExpiresAtIso,
    iat: payload.iat,
    nbf: payload.nbf,
    exp: payload.exp,
  });

  if (payload.status === 'refunded') {
    return rejectedVerification('LICENSE_REFUNDED', 'refunded', {
      keyId: header.kid,
      claims: safeClaims,
      billingPeriod,
      periodMonths: payload.periodMonths,
      startsAt,
      expiresAt: resolvedExpiresAtIso,
    });
  }
  if (payload.status === 'revoked') {
    return rejectedVerification('LICENSE_REVOKED', 'revoked', {
      keyId: header.kid,
      claims: safeClaims,
      billingPeriod,
      periodMonths: payload.periodMonths,
      startsAt,
      expiresAt: resolvedExpiresAtIso,
    });
  }
  if (payload.status === 'suspended') {
    return rejectedVerification('LICENSE_SUSPENDED', 'suspended', {
      keyId: header.kid,
      claims: safeClaims,
      billingPeriod,
      periodMonths: payload.periodMonths,
      startsAt,
      expiresAt: resolvedExpiresAtIso,
    });
  }
  if (payload.status === 'expired') {
    return rejectedVerification('LICENSE_EXPIRED', 'expired', {
      keyId: header.kid,
      claims: safeClaims,
      billingPeriod,
      periodMonths: payload.periodMonths,
      startsAt,
      expiresAt: resolvedExpiresAtIso,
    });
  }
  if (payload.status !== 'active') {
    return rejectedVerification('LICENSE_NOT_ACTIVE', String(payload.status || 'inactive'), {
      keyId: header.kid,
      claims: safeClaims,
      billingPeriod,
      periodMonths: payload.periodMonths,
      startsAt,
      expiresAt: resolvedExpiresAtIso,
    });
  }

  if (payload.exp <= nowSeconds || resolvedExpiresAtMs <= nowMs) {
    return rejectedVerification('LICENSE_EXPIRED', 'expired', {
      keyId: header.kid,
      claims: safeClaims,
      billingPeriod,
      periodMonths: payload.periodMonths,
      startsAt,
      expiresAt: resolvedExpiresAtIso,
    });
  }

  const remainingMs = Math.max(0, resolvedExpiresAtMs - nowMs);
  const daysRemaining = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));

  return Object.freeze({
    valid: true,
    tier: 'premium',
    status: 'active',
    reason: null,
    keyId: header.kid,
    claims: safeClaims,
    billingPeriod,
    periodMonths: payload.periodMonths,
    startsAt,
    expiresAt: resolvedExpiresAtIso,
    daysRemaining,
    renewalRequired: daysRemaining <= RENEWAL_NOTICE_DAYS,
    capabilities: sanitizePremiumCapabilities(payload.capabilities),
  });
}
