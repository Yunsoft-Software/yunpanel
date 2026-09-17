const SOA_DEFAULTS = Object.freeze({ refresh: '3600', retry: '900', expire: '1209600', minimum: '300', ttl: '300' });

export function dnsIdentityDraft(identity = null) {
  const settings = identity?.settings ?? null;
  return {
    publicIpv4: settings?.publicIpv4 ?? '',
    publicIpv6: settings?.publicIpv6 ?? '',
    ns1: {
      hostname: settings?.ns1?.hostname ?? '', ipv4: settings?.ns1?.ipv4 ?? '', ipv6: settings?.ns1?.ipv6 ?? '', local: settings?.ns1?.local ?? true,
    },
    ns2: {
      hostname: settings?.ns2?.hostname ?? '', ipv4: settings?.ns2?.ipv4 ?? '', ipv6: settings?.ns2?.ipv6 ?? '', local: settings?.ns2?.local ?? true,
    },
    soa: {
      rname: settings?.soa?.rname ?? '',
      refresh: String(settings?.soa?.refresh ?? SOA_DEFAULTS.refresh),
      retry: String(settings?.soa?.retry ?? SOA_DEFAULTS.retry),
      expire: String(settings?.soa?.expire ?? SOA_DEFAULTS.expire),
      minimum: String(settings?.soa?.minimum ?? SOA_DEFAULTS.minimum),
      ttl: String(settings?.soa?.ttl ?? SOA_DEFAULTS.ttl),
    },
    dnssecDefault: settings?.dnssecDefault ?? false,
    secondaryDns: Array.isArray(settings?.secondaryDns) ? settings.secondaryDns.join('\n') : '',
  };
}

function integer(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} geçerli bir tam sayı olmalı.`);
  return parsed;
}

function nameserver(value, label, mustBeLocal = false) {
  if (!value || typeof value !== 'object') throw new Error(`${label} ayarları eksik.`);
  if (!String(value.hostname ?? '').trim()) throw new Error(`${label} hostname gerekli.`);
  if (!String(value.ipv4 ?? '').trim()) throw new Error(`${label} IPv4 gerekli.`);
  if (mustBeLocal && value.local !== true) throw new Error('ns1 yerel authoritative servis tarafından sunulmalı.');
  return Object.freeze({
    hostname: String(value.hostname).trim().toLowerCase(),
    ipv4: String(value.ipv4).trim(),
    ipv6: String(value.ipv6 ?? '').trim() || null,
    local: value.local === true,
  });
}

export function dnsIdentitySettings(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('DNS identity formu geçersiz.');
  if (!String(draft.publicIpv4 ?? '').trim()) throw new Error('Public IPv4 gerekli.');
  if (!String(draft.soa?.rname ?? '').trim()) throw new Error('SOA responsible mailbox hostname gerekli.');
  const secondaryDns = String(draft.secondaryDns ?? '').split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean);
  if (new Set(secondaryDns).size !== secondaryDns.length) throw new Error('Secondary DNS adresleri tekrar etmemeli.');
  return Object.freeze({
    publicIpv4: String(draft.publicIpv4).trim(),
    publicIpv6: String(draft.publicIpv6 ?? '').trim() || null,
    ns1: nameserver(draft.ns1, 'ns1', true),
    ns2: nameserver(draft.ns2, 'ns2'),
    soa: Object.freeze({
      rname: String(draft.soa.rname).trim().toLowerCase(),
      refresh: integer(draft.soa.refresh, 'SOA refresh'),
      retry: integer(draft.soa.retry, 'SOA retry'),
      expire: integer(draft.soa.expire, 'SOA expire'),
      minimum: integer(draft.soa.minimum, 'SOA minimum'),
      ttl: integer(draft.soa.ttl, 'SOA TTL'),
    }),
    dnssecDefault: draft.dnssecDefault === true,
    secondaryDns: Object.freeze(secondaryDns),
  });
}

export function delegationPresentation(status) {
  const value = {
    ready: ['active', 'Delegation hazır'],
    pending_glue: ['warning', 'Glue kaydı bekleniyor'],
    pending_delegation: ['pending', 'NS delegation bekleniyor'],
    pending_nameserver_address: ['warning', 'Nameserver adresi uyuşmuyor'],
    unverifiable: ['warning', 'Delegation doğrulanamıyor'],
  }[status];
  return value ? Object.freeze({ state: value[0], label: value[1] }) : Object.freeze({ state: 'unknown', label: status || 'Bilinmiyor' });
}

export function authoritativePresentation(state) {
  if (!state) return Object.freeze({ state: 'unknown', label: 'Durum alınamadı' });
  if (state.localReady ?? state.ready) return Object.freeze({ state: 'active', label: 'Local authoritative hazır' });
  if (!state.configured) return Object.freeze({ state: 'off', label: 'PowerDNS yapılandırılmamış' });
  return Object.freeze({ state: 'warning', label: state.reason ?? 'Local health hazır değil' });
}

export function publicReachabilityPresentation(state) {
  const status = state?.publicReachability?.status;
  const value = {
    ready: ['active', 'Public UDP/TCP 53 hazır'],
    unreachable: ['error', 'Public DNS portu erişilemiyor'],
    unverified: ['pending', 'Public erişim doğrulanmadı'],
    unverifiable: ['warning', 'Public erişim doğrulanamıyor'],
    blocked: ['off', 'Public kontrol bekliyor'],
  }[status];
  return value ? Object.freeze({ state: value[0], label: value[1] }) : Object.freeze({ state: 'unknown', label: status || 'Public durum yok' });
}

export function authoritativeOperationPresentation(operation) {
  const value = {
    applying: ['warning', 'Recovery incelemesi gerekli'],
    succeeded: ['succeeded', 'Uygulama tamamlandı'],
    failed: ['failed', 'Uygulama başarısız'],
  }[operation?.status];
  return value
    ? Object.freeze({ state: value[0], label: value[1] })
    : Object.freeze({ state: 'unknown', label: operation?.status ?? 'Operation yok' });
}

export const networkDnsModelInternals = Object.freeze({ SOA_DEFAULTS, integer, nameserver });
