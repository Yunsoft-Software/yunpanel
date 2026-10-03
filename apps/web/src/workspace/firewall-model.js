export const MAIL_PORTS = Object.freeze([25, 143, 465, 587, 993]);
export const DNS_PORTS = Object.freeze([53]);
export const WEB_PORTS = Object.freeze([80, 443]);
export const SYSTEM_PORTS = Object.freeze([22]);

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
      return 'E-Posta (Mail)';
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
      reason: 'Local-mail profili kapalı olduğu için e-posta portları açılamaz.',
    };
  }
  if (DNS_PORTS.includes(p) && !serviceProfiles.authoritativeDns) {
    return {
      allowed: false,
      reason: 'Authoritative-DNS profili kapalı olduğu için DNS portu açılamaz.',
    };
  }
  return { allowed: true };
}
