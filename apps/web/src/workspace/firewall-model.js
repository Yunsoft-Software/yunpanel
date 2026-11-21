export const MAIL_PORTS = Object.freeze([25, 143, 465, 587, 993]);
export const DNS_PORTS = Object.freeze([53]);
export const WEB_PORTS = Object.freeze([80, 443]);
export const SYSTEM_PORTS = Object.freeze([22]);

export function createResourceState(state = 'loading', data = null, error = null) {
  return { state, data, error };
}

const VERIFIED_FIREWALL_STATUSES = Object.freeze(['active', 'degraded', 'inactive']);

export function isFirewallStatusVerified(statusData) {
  return Boolean(
    statusData
    && typeof statusData === 'object'
    && !Array.isArray(statusData)
    && typeof statusData.status === 'string'
    && VERIFIED_FIREWALL_STATUSES.includes(statusData.status),
  );
}

const FIREWALL_ERROR_MESSAGES = Object.freeze({
  decisions_list_failed: 'CrowdSec engelleme listesi alınamadı.',
  decisions_parse_error: 'CrowdSec engelleme yanıtı doğrulanamadı.',
  add_decision_failed: 'CrowdSec IP engelleme kuralı eklenemedi.',
  delete_decision_failed: 'CrowdSec IP engelleme kuralı kaldırılamadı.',
  ruleset_snapshot_failed: 'Güvenlik duvarı anlık görüntüsü alınamadı.',
  candidate_syntax_error: 'Güvenlik duvarı kural doğrulaması başarısız oldu.',
  apply_failed: 'Güvenlik duvarı kuralları uygulanamadı.',
  rollback_failed: 'Güvenlik duvarı geri alma işlemi tamamlanamadı.',
  service_operation_failed: 'Güvenlik duvarı servis işlemi tamamlanamadı.',
  service_verification_failed: 'Güvenlik duvarı servis doğrulaması başarısız oldu.',
  nft_binary_missing: 'Güvenlik duvarı servisi (nftables) sunucuda bulunamadı.',
  nft_inspect_failed: 'Güvenlik duvarı kuralları okunamadı.',
  nft_apply_failed: 'Güvenlik duvarı kuralları uygulanamadı.',
  unauthorized: 'Oturumunuzun doğrulanması gerekiyor.',
  forbidden: 'Bu güvenlik duvarı işlemi için yetkiniz bulunmuyor.',
  unauthorized_test_target: 'Port erişilebilirlik testi bu hedef için izinli değil.',
  http_401: 'Oturumunuzun doğrulanması gerekiyor.',
  http_403: 'Bu güvenlik duvarı işlemi için yetkiniz bulunmuyor.',
  http_404: 'Güvenlik duvarı servisi bu uç noktada bulunamadı.',
  http_502: 'Güvenlik duvarı servisine şu anda ulaşılamıyor.',
  http_503: 'Güvenlik duvarı servisine şu anda ulaşılamıyor.',
  http_504: 'Güvenlik duvarı servisi zamanında yanıt vermedi.',
});

const UNSAFE_ERROR_TEXT_PATTERN = /(?:\/(?:etc|usr|var|tmp|bin|sbin|run|home|root|private|Users|opt)\/|\bENOENT\b|\bEACCES\b|\bEPERM\b|Command failed:|spawn\s|^Request failed with HTTP \d+$|Failed to (?:fetch|list decisions))/i;

export function formatFirewallError(error, fallback = 'Güvenlik duvarı verileri alınamadı.') {
  if (!error) return fallback;
  const code = typeof error === 'object' ? error.code : null;
  if (typeof code === 'string' && Object.hasOwn(FIREWALL_ERROR_MESSAGES, code)) {
    return FIREWALL_ERROR_MESSAGES[code];
  }
  const status = typeof error === 'object' ? error.status : null;
  if (Number.isInteger(status) && Object.hasOwn(FIREWALL_ERROR_MESSAGES, `http_${status}`)) {
    return FIREWALL_ERROR_MESSAGES[`http_${status}`];
  }
  const rawMessage = typeof error === 'string' ? error : error?.message;
  if (typeof rawMessage === 'string' && rawMessage.trim().length > 0) {
    const trimmed = rawMessage.trim();
    if (UNSAFE_ERROR_TEXT_PATTERN.test(trimmed)) {
      return fallback;
    }
    return trimmed;
  }
  return fallback;
}

export const formatFirewallErrorMessage = formatFirewallError;

export function normalizeServiceProfilesPayload(payload) {
  const candidate = payload?.serviceProfiles ?? payload;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  if (
    typeof candidate.localMail !== 'boolean'
    || typeof candidate.authoritativeDns !== 'boolean'
  ) {
    return null;
  }
  return {
    system: candidate.system !== false,
    web: candidate.web !== false,
    localMail: candidate.localMail,
    authoritativeDns: candidate.authoritativeDns,
  };
}

export function normalizeBansPayload(payload) {
  if (!Array.isArray(payload)) return null;
  return payload;
}

export function formatFirewallOverallStatus(statusData) {
  if (!statusData || typeof statusData !== 'object') {
    return { label: 'Durum alınamadı', badgeState: 'error' };
  }
  switch (statusData.status) {
    case 'active':
      return { label: 'Aktif (nftables)', badgeState: 'active' };
    case 'degraded':
      return { label: 'Kısmi aktif', badgeState: 'warning' };
    case 'inactive':
      return { label: 'Pasif', badgeState: 'stale' };
    case 'error':
      return { label: 'Hata', badgeState: 'error' };
    default:
      return { label: 'Bilinmiyor', badgeState: 'unknown' };
  }
}

export function formatDockerCoexistenceStatus(statusData) {
  const docker = statusData?.docker;
  if (!docker || typeof docker !== 'object') {
    return {
      label: 'Bilinmiyor',
      badgeState: 'unknown',
      detail: 'Docker ağ kuralları doğrulanamadı',
    };
  }
  if (docker.tablesProtected === true) {
    return {
      label: 'Korunuyor',
      badgeState: 'active',
      detail: 'Docker bridge ve NAT zincirleri korunur',
    };
  }
  if (docker.dockerDetected === false) {
    return {
      label: 'Docker algılanmadı',
      badgeState: 'unknown',
      detail: 'Sunucuda etkin Docker ağı bulunamadı',
    };
  }
  return {
    label: 'Kontrol gerekli',
    badgeState: 'warning',
    detail: 'Docker köprü ve NAT zincirleri doğrulanamadı',
  };
}

export function formatPortReachability(port) {
  if (!port) {
    return {
      label: 'Bilinmiyor',
      badgeState: 'unknown',
      description: 'Port durumu belirlenemedi',
    };
  }

  if (port.isListening) {
    if (port.isLoopback) {
      return {
        label: 'Yalnız Yerel',
        badgeState: 'stale',
        description: 'Yalnız yerel/loopback dinliyor (dış erişime kapalı)',
      };
    }
    if (!port.isFirewallAllowed) {
      return {
        label: 'Firewall Engelli',
        badgeState: 'error',
        description: 'Dinliyor ancak firewall tarafından engellenmiş',
      };
    }
    return {
      label: 'Dışarıdan Erişilebilir',
      badgeState: 'ready',
      description: 'Dinliyor ve firewall izinli (dışarıdan erişilebilir)',
    };
  }

  if (port.isFirewallAllowed) {
    return {
      label: 'Firewall İzinli',
      badgeState: 'stale',
      description: 'Firewall izinli ancak dinleyen servis yok',
    };
  }

  return {
    label: 'Pasif',
    badgeState: 'unknown',
    description: 'Dinlemiyor ve firewall izni yok',
  };
}

export function formatServiceProfileLabel(profile) {
  switch (profile) {
    case 'system':
      return 'Sistem / SSH';
    case 'web':
      return 'Web (HTTP/HTTPS)';
    case 'mail':
      return 'E-Posta';
    case 'dns':
      return 'DNS (53)';
    case 'custom':
    default:
      return 'Özel Kural';
  }
}

export function formatProviderFirewallNotice(providerFirewall) {
  return {
    status: providerFirewall?.status ?? 'unknown',
    isUnknown: (providerFirewall?.status ?? 'unknown') === 'unknown',
    advisory: providerFirewall?.advisory ?? providerFirewall?.note ?? 'Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor (AWS Güvenlik Grubu, Hetzner Cloud Firewall, GCP Firewall vb. dış ağ kuralları ayrıca kontrol edilmelidir)',
  };
}

export function isSpecialPortLocked(portNum, profile) {
  return portNum === 22 || profile === 'system';
}

export function checkPortProfileAllowed(portNum, serviceProfiles = {}) {
  const p = Number(portNum);
  if (MAIL_PORTS.includes(p) && !serviceProfiles.localMail) {
    return {
      allowed: false,
      reason: 'Yerel E-Posta profili kapalı olduğu için e-posta portları açılamaz.',
    };
  }
  if (DNS_PORTS.includes(p) && !serviceProfiles.authoritativeDns) {
    return {
      allowed: false,
      reason: 'Yetkili DNS profili kapalı olduğu için DNS portu açılamaz.',
    };
  }
  return { allowed: true };
}
