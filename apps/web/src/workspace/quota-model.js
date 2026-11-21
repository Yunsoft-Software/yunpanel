import { formatDate, siteHref } from './site-model.js';

const WEBSITES_ENFORCEMENT_NOTE = 'Yeni site tahsisinde uygulanır';
const DATABASES_ENFORCEMENT_NOTE = 'Yeni veritabanı oluşturma, bağlama ve WordPress kurulumlarında uygulanır';
const DISK_ENFORCEMENT_NOTE = 'Dosya Yöneticisi yazmalarında uygulanır';
const TRAFFIC_ENFORCEMENT_NOTE = 'Aylık trafik sınırında uygulanır; ay başında açılır';

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function formatQuotaAmount(value, unit = 'count') {
  if (!isFiniteNonNegative(value)) return null;
  const normalized = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  if (unit === 'mb') return `${normalized} MB`;
  return String(normalized);
}

/**
 * Only formats a dedicated usage measurement timestamp (`usage.measuredAt`).
 * Never falls back to account profile `updatedAt` timestamps.
 */
export function formatQuotaMeasurementTime(usage = null) {
  const candidate = usage?.measuredAt ?? null;
  if (candidate === null || candidate === undefined || candidate === '') {
    return 'Henüz ölçülmedi';
  }
  const timestamp = typeof candidate === 'number' ? candidate : Date.parse(candidate);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 'Henüz ölçülmedi';
  }
  const formatted = formatDate(timestamp);
  return formatted && formatted !== '—' ? `Son ölçüm: ${formatted}` : 'Henüz ölçülmedi';
}

export function describeQuotaMetric({
  key,
  label,
  usage = null,
  limit = null,
  unit = 'count',
  enforced = false,
  enforcementNote = null,
  reservedCount = 0,
  includesReservations = false,
} = {}) {
  const measured = isFiniteNonNegative(usage);
  const hasLimit = isFiniteNonNegative(limit);
  const isEnforced = Boolean(enforced);
  const limitText = hasLimit ? formatQuotaAmount(limit, unit) : 'Sınırsız';
  const normalizedReserved = Number.isSafeInteger(reservedCount) && reservedCount > 0 ? reservedCount : 0;
  const reservationNotice = normalizedReserved > 0
    ? `${normalizedReserved} bekleyen tahsis dahil`
    : (includesReservations ? 'Bekleyen site tahsisleri dahil' : null);

  if (!measured) {
    if (isEnforced) {
      return Object.freeze({
        key,
        label,
        measured: false,
        enforced: true,
        hasLimit,
        isFull: false,
        isNear: false,
        remaining: null,
        reservedCount: 0,
        includesReservations: false,
        status: 'pending',
        badgeState: 'unknown',
        badgeLabel: 'Doğrulanıyor',
        usageText: 'Ölçüm bekleniyor',
        limitText,
        summaryText: hasLimit ? `Ölçüm bekleniyor · Sınır: ${limitText}` : 'Ölçüm bekleniyor · Sınır: Sınırsız',
        detailText: hasLimit
          ? (enforcementNote
            ? `Tanımlı sınır: ${limitText} · ${enforcementNote}`
            : `Tanımlı sınır: ${limitText} · Sunucu kota kullanımı doğrulanıyor`)
          : 'Sınır: Sınırsız · Sunucu kota kullanımı doğrulanıyor',
      });
    }
    return Object.freeze({
      key,
      label,
      measured: false,
      enforced: false,
      hasLimit,
      isFull: false,
      isNear: false,
      remaining: null,
      reservedCount: 0,
      includesReservations: false,
      status: 'unmeasured',
      badgeState: 'unknown',
      badgeLabel: 'Ölçülmüyor',
      usageText: 'Ölçülmüyor',
      limitText,
      summaryText: hasLimit ? `Ölçülmüyor · Tanımlı sınır: ${limitText}` : 'Ölçülmüyor · Sınır: Sınırsız',
      detailText: hasLimit
        ? `Tanımlı sınır: ${limitText} · Yalnız kayıtlı sınır (henüz otomatik ölçülmüyor ve uygulanmıyor)`
        : 'Sınır: Sınırsız · Henüz otomatik ölçülmüyor ve uygulanmıyor',
    });
  }

  const usageText = formatQuotaAmount(usage, unit);

  if (!hasLimit) {
    const unlimitedDetail = isEnforced
      ? (reservationNotice ? `${reservationNotice} · Üst sınır tanımlı değil` : 'Üst sınır tanımlı değil')
      : 'Sınır: Sınırsız · Yalnız kayıtlı hedef (otomatik kota engeli yok)';
    return Object.freeze({
      key,
      label,
      measured: true,
      enforced: isEnforced,
      hasLimit: false,
      isFull: false,
      isNear: false,
      remaining: null,
      reservedCount: normalizedReserved,
      includesReservations: Boolean(includesReservations || normalizedReserved > 0),
      status: 'unlimited',
      badgeState: 'active',
      badgeLabel: 'Sınırsız',
      usageText,
      limitText: 'Sınırsız',
      summaryText: `${usageText} / Sınırsız`,
      detailText: unlimitedDetail,
    });
  }

  const remaining = Math.max(0, Math.round((limit - usage) * 100) / 100);
  const isFull = usage >= limit;
  const isNear = !isFull && limit > 0 && (usage / limit) >= 0.8;
  const status = isFull ? 'full' : isNear ? 'near_limit' : 'ok';
  const badgeState = isFull || isNear ? 'warning' : 'active';
  const badgeLabel = isFull ? 'Kota doldu' : isNear ? 'Sınıra yakın' : 'Uygun';
  const enforcedReason = enforcementNote ?? 'Yeni oluşturmada uygulanır';
  const detailParts = [];
  if (isEnforced) {
    if (reservationNotice) detailParts.push(reservationNotice);
    detailParts.push(isFull ? `Kota doldu · ${enforcedReason}` : `${formatQuotaAmount(remaining, unit)} boş · ${enforcedReason}`);
  } else {
    detailParts.push(isFull
      ? 'Tanımlı sınıra ulaşıldı · Yalnız kayıtlı sınır (otomatik kota engeli yok)'
      : 'Ölçülen kullanım · Yalnız kayıtlı sınır (otomatik kota engeli yok)');
  }

  return Object.freeze({
    key,
    label,
    measured: true,
    enforced: isEnforced,
    hasLimit: true,
    isFull,
    isNear,
    remaining,
    reservedCount: normalizedReserved,
    includesReservations: Boolean(includesReservations || normalizedReserved > 0),
    status,
    badgeState,
    badgeLabel,
    usageText,
    limitText,
    summaryText: `${usageText} / ${limitText}`,
    detailText: detailParts.join(' · '),
  });
}

export function describeCustomerManagementContext(hostingProfile) {
  if (hostingProfile?.resellerId) {
    return Object.freeze({
      kind: 'reseller_managed',
      label: 'Bayi yönetimli müşteri',
      detail: 'Kota değişikliği, yeni site tahsisi ve hesap desteği için bayinizle iletişime geçin.',
    });
  }
  return Object.freeze({
    kind: 'direct_managed',
    label: 'Doğrudan yönetilen müşteri',
    detail: 'Kota değişikliği, yeni site tahsisi ve hesap desteği için sunucu yöneticinizle iletişime geçin.',
  });
}

/**
 * Builds the customer quota view strictly from authoritative backend account/profile data.
 * Never fabricates website utilization or remaining capacity from visible `websites.items.length`,
 * because backend `maxWebsites` enforcement counts both attached websites and `reserved` allocations.
 */
export function buildCustomerQuotaSnapshot({ hostingProfile = null, account = null } = {}) {
  const usage = account?.usage ?? hostingProfile?.usage ?? null;
  const quotas = account?.quotas ?? hostingProfile?.quotas ?? null;
  const quotaEnforcement = account?.quotaEnforcement ?? hostingProfile?.quotaEnforcement ?? null;
  const effectiveProfile = account ?? hostingProfile ?? null;

  const authoritativeWebsites = isFiniteNonNegative(usage?.websites) ? usage.websites : null;
  const attachedWebsiteCount = Array.isArray(account?.websiteIds) ? account.websiteIds.length : null;
  const reservedWebsites = authoritativeWebsites !== null
    && attachedWebsiteCount !== null
    && authoritativeWebsites > attachedWebsiteCount
    ? authoritativeWebsites - attachedWebsiteCount
    : 0;

  const websitesMetric = describeQuotaMetric({
    key: 'websites',
    label: 'Web Siteleri',
    usage: authoritativeWebsites,
    limit: quotas?.maxWebsites ?? null,
    unit: 'count',
    enforced: true,
    reservedCount: reservedWebsites,
    includesReservations: reservedWebsites > 0,
    enforcementNote: WEBSITES_ENFORCEMENT_NOTE,
  });
  const databasesMetric = describeQuotaMetric({
    key: 'databases',
    label: 'Veritabanları',
    usage: usage?.databases ?? null,
    limit: quotas?.maxDatabases ?? null,
    unit: 'count',
    enforced: quotaEnforcement ? Boolean(quotaEnforcement.databases) : false,
    enforcementNote: DATABASES_ENFORCEMENT_NOTE,
  });
  const diskMetric = describeQuotaMetric({
    key: 'diskMb',
    label: 'Disk Alanı',
    usage: usage?.diskMb ?? null,
    limit: quotas?.maxDiskMb ?? null,
    unit: 'mb',
    enforced: Boolean(quotaEnforcement?.disk),
    enforcementNote: DISK_ENFORCEMENT_NOTE,
  });
  const trafficMetric = describeQuotaMetric({
    key: 'trafficMb',
    label: 'Aylık Trafik',
    usage: usage?.trafficMb ?? null,
    limit: quotas?.maxTrafficMb ?? null,
    unit: 'mb',
    enforced: Boolean(quotaEnforcement?.traffic),
    enforcementNote: TRAFFIC_ENFORCEMENT_NOTE,
  });

  const orderedMetrics = [websitesMetric, databasesMetric, diskMetric, trafficMetric];
  const enforced = Object.freeze(orderedMetrics.filter((metric) => metric.enforced));
  const unmeasured = Object.freeze(orderedMetrics.filter((metric) => !metric.enforced));

  return Object.freeze({
    enforced,
    unmeasured,
    all: Object.freeze([websitesMetric, diskMetric, trafficMetric, databasesMetric]),
    websites: websitesMetric,
    disk: diskMetric,
    traffic: trafficMetric,
    databases: databasesMetric,
    quotaEnforcement: quotaEnforcement ? Object.freeze({
      websites: Boolean(quotaEnforcement.websites),
      databases: Boolean(quotaEnforcement.databases),
      disk: Boolean(quotaEnforcement.disk),
      traffic: Boolean(quotaEnforcement.traffic),
    }) : null,
    reservedWebsites,
    usageAuthoritative: authoritativeWebsites !== null,
    isWebsiteQuotaFull: websitesMetric.isFull,
    measurementLabel: formatQuotaMeasurementTime(usage),
    managementContext: describeCustomerManagementContext(effectiveProfile),
  });
}

export function buildResellerAccountQuotaMetrics(account) {
  if (!account || typeof account !== 'object') return null;

  if (account.kind === 'reseller') {
    const customers = describeQuotaMetric({
      key: 'customers',
      label: 'Müşteriler',
      usage: account.usage?.customers ?? null,
      limit: account.limits?.maxCustomers ?? null,
      unit: 'count',
      enforced: true,
      enforcementNote: 'Yeni müşteri oluşturmada uygulanır',
    });
    const websites = describeQuotaMetric({
      key: 'websites',
      label: 'Web Siteleri',
      usage: account.usage?.websites ?? null,
      limit: account.limits?.maxWebsites ?? null,
      unit: 'count',
      enforced: true,
      includesReservations: account.usageScope === 'registered_and_reserved_ownership',
      enforcementNote: 'Yeni site tahsisinde uygulanır',
    });
    return Object.freeze({
      kind: 'reseller',
      customers,
      websites,
      measurementLabel: formatQuotaMeasurementTime(account.usage),
    });
  }

  const quotaEnforcement = account?.quotaEnforcement ?? null;
  const authoritativeWebsites = isFiniteNonNegative(account.usage?.websites) ? account.usage.websites : null;
  const attachedWebsiteCount = Array.isArray(account.websiteIds) ? account.websiteIds.length : null;
  const reservedWebsites = authoritativeWebsites !== null
    && attachedWebsiteCount !== null
    && authoritativeWebsites > attachedWebsiteCount
    ? authoritativeWebsites - attachedWebsiteCount
    : 0;

  const websites = describeQuotaMetric({
    key: 'websites',
    label: 'Web Siteleri',
    usage: authoritativeWebsites,
    limit: account.quotas?.maxWebsites ?? null,
    unit: 'count',
    enforced: true,
    reservedCount: reservedWebsites,
    includesReservations: reservedWebsites > 0,
    enforcementNote: WEBSITES_ENFORCEMENT_NOTE,
  });
  const databases = describeQuotaMetric({
    key: 'databases',
    label: 'Veritabanı',
    usage: account.usage?.databases ?? null,
    limit: account.quotas?.maxDatabases ?? null,
    unit: 'count',
    enforced: quotaEnforcement ? Boolean(quotaEnforcement.databases) : false,
    enforcementNote: DATABASES_ENFORCEMENT_NOTE,
  });
  const disk = describeQuotaMetric({
    key: 'diskMb',
    label: 'Disk',
    usage: account.usage?.diskMb ?? null,
    limit: account.quotas?.maxDiskMb ?? null,
    unit: 'mb',
    enforced: Boolean(quotaEnforcement?.disk),
    enforcementNote: DISK_ENFORCEMENT_NOTE,
  });
  const traffic = describeQuotaMetric({
    key: 'trafficMb',
    label: 'Trafik',
    usage: account.usage?.trafficMb ?? null,
    limit: account.quotas?.maxTrafficMb ?? null,
    unit: 'mb',
    enforced: Boolean(quotaEnforcement?.traffic),
    enforcementNote: TRAFFIC_ENFORCEMENT_NOTE,
  });

  return Object.freeze({
    kind: 'customer',
    websites,
    disk,
    traffic,
    databases,
    quotaEnforcement: quotaEnforcement ? Object.freeze({
      websites: Boolean(quotaEnforcement.websites),
      databases: Boolean(quotaEnforcement.databases),
      disk: Boolean(quotaEnforcement.disk),
      traffic: Boolean(quotaEnforcement.traffic),
    }) : null,
    reservedWebsites,
    measurementLabel: formatQuotaMeasurementTime(account.usage),
  });
}

function runtimeDisplayLabel(runtimeType, targetType) {
  const kind = String(runtimeType || targetType || '').toLowerCase();
  if (kind === 'php' || kind === 'wordpress') return 'PHP';
  if (kind === 'node' || kind === 'passenger') return 'Node.js';
  if (kind === 'python') return 'Python';
  if (kind === 'docker' || kind === 'compose') return 'Docker';
  if (kind === 'redirect') return 'Yönlendirme';
  if (kind === 'proxy') return 'Uygulama';
  return 'Statik site';
}

function siteStatusDisplay(state) {
  switch (state) {
    case 'active':
      return { state: 'active', label: 'Aktif' };
    case 'staged':
      return { state: 'staged', label: 'Hazırlandı' };
    case 'error':
      return { state: 'error', label: 'Hata' };
    case 'suspended':
      return { state: 'off', label: 'Askıda' };
    default:
      return { state: 'draft', label: 'Taslak' };
  }
}

export function buildCustomerSiteQuotaBreakdown(websites = [], domains = []) {
  const domainList = Array.isArray(domains) ? domains : [];
  const websiteList = Array.isArray(websites) ? websites : [];

  if (websiteList.length > 0) {
    return Object.freeze(websiteList.map((site) => {
      const boundDomain = domainList.find((domain) => domain.websiteId === site.id && !domain.parentDomainId)
        ?? domainList.find((domain) => domain.websiteId === site.id)
        ?? null;
      const statusMeta = siteStatusDisplay(boundDomain?.state ?? boundDomain?.status ?? site.state ?? site.status);
      return Object.freeze({
        id: site.id,
        domainId: boundDomain?.id ?? null,
        name: boundDomain?.primaryDomain ?? site.name ?? site.id,
        runtimeLabel: runtimeDisplayLabel(site.runtimeType, boundDomain?.targetType),
        statusState: statusMeta.state,
        statusLabel: statusMeta.label,
        href: boundDomain ? siteHref(boundDomain.id, 'overview') : '/websites',
      });
    }));
  }

  return Object.freeze(domainList
    .filter((domain) => !domain.parentDomainId)
    .map((domain) => {
      const statusMeta = siteStatusDisplay(domain.state ?? domain.status);
      return Object.freeze({
        id: domain.websiteId ?? domain.id,
        domainId: domain.id,
        name: domain.primaryDomain,
        runtimeLabel: runtimeDisplayLabel(null, domain.targetType),
        statusState: statusMeta.state,
        statusLabel: statusMeta.label,
        href: siteHref(domain.id, 'overview'),
      });
    }));
}
