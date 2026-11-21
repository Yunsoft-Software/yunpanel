import { certificateState, siteHref } from './site-model.js';
import { readableItems, usagePercent } from './ui/console-model.js';

function primaryWebsiteDomains(domains = []) {
  if (!Array.isArray(domains)) return [];
  return domains.filter((domain) => domain && typeof domain.id === 'string' && typeof domain.primaryDomain === 'string');
}

function domainState(domain) {
  return domain?.state ?? domain?.status ?? 'draft';
}

export function buildOwnerNextActions({
  domains = null,
  websites = null,
  certificates = null,
  servers = null,
  jobs = null,
} = {}) {
  const items = [];
  const domainList = primaryWebsiteDomains(readableItems(domains));
  const certReadable = ['ready', 'stale'].includes(certificates?.status);
  const certList = certReadable ? readableItems(certificates) : [];
  const server = readableItems(servers)[0] ?? null;
  const jobList = readableItems(jobs);

  const disk = server?.inventory?.filesystem;
  const diskUsage = usagePercent(disk?.usedBytes, disk?.totalBytes);
  if (server?.connectivity === 'error') {
    items.push(Object.freeze({
      id: 'owner-server-connectivity',
      severity: 'danger',
      title: 'Sunucu bağlantısı doğrulanamıyor',
      detail: 'Yerel sunucu servis ve sağlık durumunu kontrol edin.',
      to: '/servers',
      cta: 'Sunucuyu incele',
    }));
  } else if (diskUsage !== null && diskUsage >= 85) {
    items.push(Object.freeze({
      id: 'owner-disk-pressure',
      severity: diskUsage >= 90 ? 'danger' : 'warning',
      title: `Disk doluluğu yüksek (%${Math.round(diskUsage)})`,
      detail: 'Yeni dağıtımlar ve yedekler etkilenmeden boş alanı kontrol edin.',
      to: '/servers',
      cta: 'Sunucuyu incele',
    }));
  }

  const failedJobs = jobList.filter((job) => job.status === 'failed');
  const activeJobs = jobList.filter((job) => ['queued', 'running'].includes(job.status));
  if (failedJobs.length > 0) {
    items.push(Object.freeze({
      id: 'owner-failed-jobs',
      severity: 'warning',
      title: `${failedJobs.length} başarısız işlem incelenmeli`,
      detail: 'Son dağıtım, SSL veya servis hatalarını işlem geçmişinden kontrol edin.',
      to: '/jobs?status=failed',
      cta: 'Hataları incele',
    }));
  } else if (activeJobs.length > 0) {
    items.push(Object.freeze({
      id: 'owner-active-jobs',
      severity: 'info',
      title: `${activeJobs.length} işlem devam ediyor`,
      detail: 'Çalışan ve sıradaki işlemlerin ilerleyişini buradan takip edebilirsiniz.',
      to: '/jobs',
      cta: 'İşlemleri izle',
    }));
  }

  const errorDomains = domainList.filter((domain) => domainState(domain) === 'error');
  const draftDomains = domainList.filter((domain) => domainState(domain) === 'draft' || domainState(domain) === 'staged');
  if (errorDomains.length > 0) {
    const first = errorDomains[0];
    items.push(Object.freeze({
      id: 'owner-error-sites',
      severity: 'danger',
      title: `${errorDomains.length} sitede hata durumu var`,
      detail: `${first.primaryDomain} kaydının durumunu ve günlüklerini kontrol edin.`,
      to: siteHref(first.id, 'overview'),
      cta: 'Siteyi incele',
    }));
  } else if (draftDomains.length > 0) {
    const first = draftDomains[0];
    items.push(Object.freeze({
      id: 'owner-draft-sites',
      severity: 'warning',
      title: `${draftDomains.length} site henüz yayında değil`,
      detail: `${first.primaryDomain} kurulumunu tamamlayın veya etkinleştirin.`,
      to: siteHref(first.id, 'overview'),
      cta: 'Kurulumu incele',
    }));
  }

  if (certReadable && domainList.length > 0) {
    const sslAttention = domainList
      .map((domain) => ({ domain, ssl: certificateState(domain, certList) }))
      .filter(({ ssl }) => ['expired', 'error', 'warning', 'pending', 'off'].includes(ssl.state));
    if (sslAttention.length > 0) {
      const urgent = sslAttention.find(({ ssl }) => ['expired', 'error', 'warning'].includes(ssl.state));
      const target = urgent ?? sslAttention[0];
      const isUrgent = Boolean(urgent);
      items.push(Object.freeze({
        id: 'owner-ssl-dns',
        severity: isUrgent ? 'warning' : 'info',
        title: isUrgent
          ? `${sslAttention.length} sitede SSL sertifika uyarısı var`
          : `DNS veya SSL bekleyen ${sslAttention.length} site var`,
        detail: `${target.domain.primaryDomain} için ${isUrgent ? 'sertifika durumunu yenileyin' : 'DNS ve HTTPS ayarlarını tamamlayın'}.`,
        to: siteHref(target.domain.id, isUrgent ? 'ssl' : (domainState(target.domain) === 'draft' ? 'dns' : 'ssl')),
        cta: isUrgent ? 'SSL’i incele' : 'DNS ve SSL’i aç',
      }));
    }
  }

  if (domains?.status === 'ready' && domainList.length === 0 && (websites?.items?.length ?? 0) === 0) {
    items.push(Object.freeze({
      id: 'owner-first-site',
      severity: 'info',
      title: 'İlk web sitenizi oluşturun',
      detail: 'Alan adı, uygulama türü ve HTTPS tercihini belirleyerek ilk yayını başlatın.',
      to: '/websites/new',
      cta: 'Web sitesi ekle',
    }));
  }

  const quickEntries = Object.freeze([
    Object.freeze({ label: 'Sunucu sağlığı ve genel bakış', to: '/dashboard', icon: 'dashboard' }),
    Object.freeze({ label: 'Güvenlik duvarı', to: '/firewall', icon: 'shield' }),
    Object.freeze({ label: 'İşlem geçmişi', to: '/jobs', icon: 'jobs' }),
  ]);

  return Object.freeze({
    items: Object.freeze(items),
    quickEntries,
    allClear: items.length === 0,
  });
}

export function buildResellerNextActions({
  reseller = null,
  customers = null,
  domains = null,
} = {}) {
  const items = [];

  if (Array.isArray(customers)) {
    if (customers.length === 0) {
      items.push(Object.freeze({
        id: 'reseller-add-first-customer',
        severity: 'info',
        title: '1. İlk müşterinizi ekleyin',
        detail: 'Müşteri hesabı oluşturduktan sonra web sitesi ve kaynak kotası tahsis edebilirsiniz.',
        actionType: 'create_customer',
        cta: 'Müşteri ekle',
      }));
    } else {
      const suspended = customers.filter((account) => !account.active);
      const quotaFull = customers.filter(
        (account) => account.active
          && account.quotas?.maxWebsites !== null
          && account.quotas?.maxWebsites !== undefined
          && typeof account.usage?.websites === 'number'
          && account.usage.websites >= account.quotas.maxWebsites,
      );
      const firstActive = customers.find((account) => account.active && !quotaFull.includes(account)) ?? null;
      const totalSites = reseller?.usage?.websites ?? customers.reduce((sum, account) => sum + (account.usage?.websites ?? 0), 0);

      if (totalSites === 0 && firstActive) {
        items.push(Object.freeze({
          id: 'reseller-allocate-first-site',
          severity: 'info',
          title: '2. Müşterinize ilk web sitesini tahsis edin',
          detail: `${firstActive.username} hesabına alan adı bağlayarak yayını başlatın.`,
          actionType: 'allocate_site',
          targetAccountId: firstActive.id,
          cta: 'Site tahsis et',
        }));
      }
      if (suspended.length > 0) {
        items.push(Object.freeze({
          id: 'reseller-suspended-customers',
          severity: 'warning',
          title: `${suspended.length} müşteri hesabı askıda`,
          detail: 'Askıdaki müşterilerin panel girişi ve yeni site tahsisi kapalıdır; mevcut sitelerinin yayını ayrı yönetilir.',
          actionType: 'focus_list',
          cta: null,
        }));
      }
      if (quotaFull.length > 0) {
        const firstFull = quotaFull[0];
        items.push(Object.freeze({
          id: 'reseller-quota-full',
          severity: 'warning',
          title: `${quotaFull.length} müşterinin web sitesi kotası doldu`,
          detail: `${firstFull.username} için yeni site tahsis etmeden önce web sitesi kotasını yükseltin.`,
          actionType: 'edit_quotas',
          targetAccountId: firstFull.id,
          cta: 'Kota tahsis et',
        }));
      }
    }
  } else {
    const domainList = primaryWebsiteDomains(readableItems(domains));
    if (domains?.status === 'ready' && domainList.length === 0) {
      items.push(Object.freeze({
        id: 'reseller-sites-empty',
        severity: 'info',
        title: 'Müşterilerinize ilk web sitesini tahsis edin',
        detail: 'Müşterilerim ekranından yeni müşteri ekleyip alan adı bağlayabilirsiniz.',
        to: '/customers',
        cta: 'Müşterilerime git',
      }));
    } else if (domainList.some((domain) => domainState(domain) !== 'active')) {
      const first = domainList.find((domain) => domainState(domain) !== 'active');
      items.push(Object.freeze({
        id: 'reseller-site-pending',
        severity: 'warning',
        title: 'Henüz yayında olmayan müşteri sitesi var',
        detail: `${first.primaryDomain} kurulum ve yayın durumunu kontrol edin.`,
        to: siteHref(first.id, 'overview'),
        cta: 'Siteyi incele',
      }));
    }
  }

  return Object.freeze({
    items: Object.freeze(items),
    allClear: items.length === 0,
  });
}

export function buildCustomerNextActions({
  domains = [],
  certificates = null,
} = {}) {
  const domainList = primaryWebsiteDomains(Array.isArray(domains) ? domains : readableItems(domains));
  const certList = Array.isArray(certificates)
    ? certificates
    : (['ready', 'stale'].includes(certificates?.status) ? readableItems(certificates) : null);

  const items = [];
  const primaryDomain = domainList[0] ?? null;

  const unready = domainList.filter((domain) => domainState(domain) !== 'active');
  if (unready.length > 0) {
    const first = unready[0];
    items.push(Object.freeze({
      id: 'customer-site-unready',
      severity: domainState(first) === 'error' ? 'danger' : 'warning',
      title: `${unready.length} site henüz tamamlanmadı`,
      detail: `${first.primaryDomain} kurulumunu tamamlayın veya durumunu kontrol edin.`,
      to: siteHref(first.id, 'overview'),
      cta: 'Durumu kontrol et',
    }));
  }

  if (certList !== null && domainList.length > 0) {
    const sslMissing = domainList
      .map((domain) => ({ domain, ssl: certificateState(domain, certList) }))
      .filter(({ ssl }) => ['off', 'pending', 'expired', 'error', 'warning'].includes(ssl.state));
    if (sslMissing.length > 0) {
      const first = sslMissing[0];
      items.push(Object.freeze({
        id: 'customer-ssl-setup',
        severity: ['expired', 'error'].includes(first.ssl.state) ? 'danger' : 'warning',
        title: first.ssl.state === 'off' || first.ssl.state === 'pending'
          ? 'HTTPS sertifikası oluşturun'
          : 'SSL sertifikanızı kontrol edin',
        detail: `${first.domain.primaryDomain} güvenli HTTPS bağlantısı için sertifika ayarı bekliyor.`,
        to: siteHref(first.domain.id, 'ssl'),
        cta: 'SSL ayarlarını aç',
      }));
    }
  }

  const dnsPending = domainList.filter(
    (domain) => domainState(domain) === 'draft' || domainState(domain) === 'staged' || domain.dnsStatus === 'pending' || domain.dnsVerified === false,
  );
  if (dnsPending.length > 0) {
    const first = dnsPending[0];
    items.push(Object.freeze({
      id: 'customer-dns-check',
      severity: 'info',
      title: 'Gerekli DNS kayıtlarını kontrol edin',
      detail: `${first.primaryDomain} alan adının bu sunucuya yönlendiğini DNS ekranından doğrulayın.`,
      to: siteHref(first.id, 'dns'),
      cta: 'DNS kayıtlarını aç',
    }));
  }

  const quickLinks = primaryDomain
    ? Object.freeze([
      Object.freeze({ label: 'E-posta hesapları', to: siteHref(primaryDomain.id, 'mail'), icon: 'mail' }),
      Object.freeze({ label: 'Yedekleme ve geri yükleme', to: siteHref(primaryDomain.id, 'backup'), icon: 'archive' }),
    ])
    : Object.freeze([]);

  return Object.freeze({
    items: Object.freeze(items),
    quickLinks,
    allClear: domainList.length > 0 && items.length === 0,
    summaryText: domainList.length > 0 && items.length === 0 ? 'Siteleriniz yayında' : null,
  });
}
