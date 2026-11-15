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

export function formatBillingPeriodLabel(license) {
  if (!license) return '—';
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
