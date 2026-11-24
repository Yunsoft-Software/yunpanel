import { panelRequest } from '../api.js';

export async function getLicenseStatus(options = {}) {
  const result = await panelRequest('/license', { signal: options.signal });
  return result?.data ?? result;
}

export async function activateLicense({ licenseKey = '', token = '', domain = '' } = {}, options = {}) {
  const body = {};
  if (typeof licenseKey === 'string' && licenseKey.trim()) {
    body.licenseKey = licenseKey.trim();
  }
  if (typeof token === 'string' && token.trim()) {
    body.token = token.trim();
  }
  if (typeof domain === 'string' && domain.trim()) {
    body.domain = domain.trim();
  }
  const result = await panelRequest('/license/activate', {
    method: 'POST',
    body,
    signal: options.signal,
  });
  return result?.data ?? result;
}

export async function refreshLicense({ licenseKey = '', token = '', domain = '' } = {}, options = {}) {
  const body = {};
  if (typeof licenseKey === 'string' && licenseKey.trim()) {
    body.licenseKey = licenseKey.trim();
  }
  if (typeof token === 'string' && token.trim()) {
    body.token = token.trim();
  }
  if (typeof domain === 'string' && domain.trim()) {
    body.domain = domain.trim();
  }
  const result = await panelRequest('/license/refresh', {
    method: 'POST',
    body,
    signal: options.signal,
  });
  return result?.data ?? result;
}

export async function deactivateLicense({ notifyRemote = true } = {}, options = {}) {
  const result = await panelRequest('/license/deactivate', {
    method: 'POST',
    body: {
      confirmation: 'deactivate-license',
      notifyRemote: notifyRemote !== false,
    },
    signal: options.signal,
  });
  return result?.data ?? result;
}

export function formatLicenseStatusLabel(license) {
  if (!license) return 'Bilinmiyor';
  if (license.valid && license.tier === 'premium') {
    return license.renewalRequired ? 'Yenileme yaklaştı' : 'Aktif';
  }
  switch (license.status) {
    case 'free':
      return 'Ücretsiz sürüm';
    case 'expired':
      return 'Süresi doldu';
    case 'revoked':
      return 'İptal edildi';
    case 'refunded':
      return 'İade edildi';
    case 'suspended':
      return 'Askıya alındı';
    case 'unverified':
      return 'Doğrulama anahtarı eksik';
    case 'invalid':
      return 'Geçersiz lisans';
    default:
      return 'Ücretsiz sürüm';
  }
}

export function resolveLicenseBadgeState(license) {
  if (!license) return 'unknown';
  if (license.valid && license.tier === 'premium') {
    return license.renewalRequired ? 'warning' : 'active';
  }
  if (['expired', 'revoked', 'refunded', 'suspended', 'invalid'].includes(license.status)) {
    return 'expired';
  }
  if (license.status === 'unverified') {
    return 'warning';
  }
  return 'unknown';
}

export const DEFAULT_PREMIUM_OFFER_URL = 'https://yunsoft.com/kampanya/premium-3-ay';
export const DEFAULT_DOCS_URL = 'https://yunsoft.com/docs/yunpanel';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isBrowserLoopbackHost() {
  if (typeof window === 'undefined' || !window.location?.hostname) return false;
  return LOOPBACK_HOSTS.has(window.location.hostname.toLowerCase());
}

export function sanitizeExternalYunsoftUrl(rawUrl, {
  fallbackUrl = null,
  allowLoopbackHttp = isBrowserLoopbackHost(),
} = {}) {
  const validate = (candidate) => {
    if (typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > 512 || /[\u0000-\u001f\u007f\s?#]/.test(trimmed)) return null;
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const hostLower = parsed.hostname.toLowerCase();
    if (/\.44$/.test(hostLower)) return null;
    const loopbackHttp = Boolean(allowLoopbackHttp && LOOPBACK_HOSTS.has(hostLower) && parsed.protocol === 'http:');
    if (parsed.protocol !== 'https:' && !loopbackHttp) return null;
    if (parsed.pathname.includes('@') || /%40/i.test(parsed.pathname)) return null;
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
    return normalizedPath === '/' ? parsed.origin : `${parsed.origin}${normalizedPath}`;
  };

  return validate(rawUrl) ?? (fallbackUrl ? validate(fallbackUrl) : null);
}

export function formatBillingPeriodLabel(license) {
  if (!license) return '—';
  if (license.isPermanent || license.grantKind === 'permanent' || license.billingPeriod === 'permanent') {
    return 'Kalıcı';
  }
  if (
    (license.isPromotional || license.grantKind === 'promotional' || license.billingPeriod === 'promotional')
    && Number.isSafeInteger(license.periodMonths)
    && license.periodMonths > 0
  ) {
    return `Kampanya · ${license.periodMonths} ay`;
  }
  if (license.periodMonths === 1 || license.billingPeriod === 'monthly') {
    return 'Aylık · 1 ay';
  }
  if (license.periodMonths === 12 || license.billingPeriod === 'yearly') {
    return 'Yıllık · 12 ay';
  }
  if (Number.isSafeInteger(license.periodMonths) && license.periodMonths > 0) {
    return `${license.periodMonths} ay`;
  }
  return '—';
}

export function formatLicenseError(error) {
  if (!error) return null;
  const code = error?.code ?? '';
  switch (code) {
    case 'premium_license_required':
      return 'Bu işlem için aktif bir YunPanel Premium lisansı gerekiyor.';
    case 'paid_or_permanent_entitlement_protected':
      return 'Aktif ücretli veya kalıcı lisansınız korunuyor; kampanya hakkı mevcut lisansın üzerine yazılmaz.';
    case 'license_public_key_not_configured':
      return 'Sunucuda lisans doğrulama açık anahtarı tanımlı değil.';
    case 'panel_domain_unconfigured':
      return 'Lisans etkinleştirmeden önce sunucu genel adresini geçerli bir alan adı olarak yapılandırın.';
    case 'license_product_mismatch':
      return 'Girilen lisans başka bir Yunsoft ürününe ait olduğu için YunPanel üzerinde kullanılamaz.';
    case 'license_domain_mismatch':
      return 'Lisans alan adı bu panelin adresiyle eşleşmiyor.';
    case 'license_instance_mismatch':
      return 'Bu lisans jetonu farklı bir YunPanel kurulumuna bağlı.';
    case 'license_expired':
      return 'Lisans süresi sona ermiş. Güncel lisans anahtarınızı veya yenilenmiş jetonunuzu girin.';
    case 'license_inactive':
      return 'Bu lisans aktif durumda değil.';
    case 'license_not_yet_valid':
      return 'Lisans başlangıç zamanı henüz gelmedi. Sunucu saatini kontrol edin.';
    case 'stale_license_token':
      return 'Bu lisans jetonu mevcut sürümden daha eski. Güncel lisans jetonunuzu girin.';
    case 'invalid_license_token':
      return 'Lisans imzası veya sözleşme bilgileri doğrulanamadı.';
    case 'invalid_license_key':
      return 'Geçerli bir lisans anahtarı girin.';
    case 'missing_license_credentials':
      return 'Lisans anahtarı veya imzalı lisans jetonu girin.';
    case 'license_refresh_credentials_required':
      return 'Yenilemek için kayıtlı lisans anahtarı veya yeni imzalı lisans jetonu gerekli.';
    case 'license_exchange_unreachable':
      return 'Yunsoft lisans servisine ulaşılamadı. Mevcut doğrulanmış lisansınız korunmaya devam ediyor.';
    default:
      return typeof error === 'string' ? error : (error?.message || 'Lisans işlemi tamamlanamadı.');
  }
}

const ALLOWED_RETURN_ROUTES = new Set([
  '/resellers',
  '/customers',
  '/users',
  '/settings/users',
  '/websites/new',
  '/websites',
  '/settings',
]);

const ALLOWED_LICENSE_FEATURES = new Set([
  'reseller',
  'customer',
  'site_user',
  'site_owner',
  'hosting_profile',
]);

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ALLOWED_SETTINGS_SECTIONS = new Set([
  'account',
  'dns',
  'ai',
  'api',
  'notifications',
  'updates',
]);
const FORBIDDEN_PARAM_NAME = /(?:pass|password|secret|token|key|auth|cookie|session|credential|username|user|email|login|totp|mfa)/i;

export function isLicenseLoaded(licenseState) {
  return Boolean(
    licenseState
    && typeof licenseState === 'object'
    && licenseState.status === 'ready'
    && licenseState.data
    && typeof licenseState.data === 'object'
    && licenseState.data.capabilities
    && typeof licenseState.data.capabilities === 'object',
  );
}

export function hasLicenseCapability(licenseState, capability) {
  if (!isLicenseLoaded(licenseState) || typeof capability !== 'string' || !capability) {
    return null;
  }
  return licenseState.data.capabilities[capability] === true;
}

export function isPremiumRequired(licenseState, capability) {
  return hasLicenseCapability(licenseState, capability) === false;
}

export function resolveLicenseGateState(licenseState, capability) {
  if (typeof capability !== 'string' || !capability) {
    return 'error';
  }
  if (!licenseState || typeof licenseState !== 'object') {
    return 'loading';
  }
  const { status } = licenseState;
  if (status === undefined || status === null || status === 'loading' || status === 'idle' || status === 'refreshing') {
    return 'loading';
  }
  if (status === 'ready') {
    const capabilities = licenseState.data?.capabilities;
    if (!capabilities || typeof capabilities !== 'object' || typeof capabilities[capability] !== 'boolean') {
      return 'error';
    }
    return capabilities[capability] === true ? 'allowed' : 'premium_required';
  }
  return 'error';
}

export function sanitizeLicenseReturnTo(value) {
  if (typeof value !== 'string' || !value || value.length > 256) return null;
  if (/[\u0000-\u001f\u007f\\\s#]/.test(value)) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) return null;

  const queryIndex = value.indexOf('?');
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : value.slice(queryIndex + 1);

  if (!ALLOWED_RETURN_ROUTES.has(pathname)) return null;
  if (!rawQuery) return pathname;
  if (rawQuery.includes('?')) return null;

  const parsed = new URLSearchParams(rawQuery);
  const seenKeys = new Set();
  const safeParams = new URLSearchParams();

  for (const [key, paramValue] of parsed.entries()) {
    if (!key || seenKeys.has(key) || FORBIDDEN_PARAM_NAME.test(key)) return null;
    seenKeys.add(key);

    if (key === 'action') {
      if (paramValue !== 'create' || !['/resellers', '/customers', '/users', '/settings/users'].includes(pathname)) {
        return null;
      }
      safeParams.set('action', 'create');
    } else if (key === 'customer') {
      if (!['/websites/new', '/websites'].includes(pathname) || !SAFE_ID_PATTERN.test(paramValue)) {
        return null;
      }
      safeParams.set('customer', paramValue);
    } else if (key === 'parent') {
      if (pathname !== '/websites/new' || !SAFE_ID_PATTERN.test(paramValue)) {
        return null;
      }
      safeParams.set('parent', paramValue);
    } else if (key === 'mode') {
      if (pathname !== '/websites/new' || !['domain', 'subdomain'].includes(paramValue)) {
        return null;
      }
      safeParams.set('mode', paramValue);
    } else if (key === 'section') {
      if (pathname !== '/settings' || !ALLOWED_SETTINGS_SECTIONS.has(paramValue)) {
        return null;
      }
      safeParams.set('section', paramValue);
    } else {
      return null;
    }
  }

  const serialized = safeParams.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

export function buildLicenseSettingsPath({ returnTo = null, feature = null } = {}) {
  const params = new URLSearchParams();
  params.set('section', 'license');
  const safeReturn = sanitizeLicenseReturnTo(returnTo);
  if (safeReturn) {
    params.set('returnTo', safeReturn);
  }
  if (typeof feature === 'string' && ALLOWED_LICENSE_FEATURES.has(feature)) {
    params.set('feature', feature);
  }
  return `/settings?${params.toString()}`;
}

export function describeLicenseReturnTarget(returnTo, feature = null) {
  const safeReturn = sanitizeLicenseReturnTo(returnTo);
  if (!safeReturn) return null;
  const pathname = safeReturn.split('?')[0];

  if (pathname === '/resellers' || feature === 'reseller') {
    return Object.freeze({
      returnTo: safeReturn,
      buttonLabel: 'Bayi eklemeye dön',
      pendingTitle: 'Bayi yönetimi için YunPanel Premium gerekiyor',
      readyTitle: 'Premium etkinleştirildi; bayi eklemeye dönebilirsiniz',
    });
  }
  if (pathname === '/customers' || feature === 'customer') {
    return Object.freeze({
      returnTo: safeReturn,
      buttonLabel: 'Müşteri eklemeye dön',
      pendingTitle: 'Müşteri hesapları için YunPanel Premium gerekiyor',
      readyTitle: 'Premium etkinleştirildi; müşteri eklemeye dönebilirsiniz',
    });
  }
  if (pathname === '/users' || pathname === '/settings/users' || feature === 'site_user' || feature === 'hosting_profile') {
    return Object.freeze({
      returnTo: safeReturn,
      buttonLabel: 'Kullanıcılara dön',
      pendingTitle: 'Ek panel kullanıcıları için YunPanel Premium gerekiyor',
      readyTitle: 'Premium etkinleştirildi; kullanıcılara dönebilirsiniz',
    });
  }
  if (pathname === '/websites/new' || feature === 'site_owner') {
    return Object.freeze({
      returnTo: safeReturn,
      buttonLabel: 'Yeni site oluşturmaya dön',
      pendingTitle: 'Müşteri veya ayrı site yöneticisi atamak için YunPanel Premium gerekiyor',
      readyTitle: 'Premium etkinleştirildi; yeni site oluşturmaya dönebilirsiniz',
    });
  }
  return Object.freeze({
    returnTo: safeReturn,
    buttonLabel: 'Önceki işe dön',
    pendingTitle: 'Bu özellik için YunPanel Premium gerekiyor',
    readyTitle: 'Premium etkinleştirildi; önceki işinize dönebilirsiniz',
  });
}
