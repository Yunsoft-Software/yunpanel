// Presentation only. Never infer Website identity from a hostname or Domain ID.
export const PREFERENCE_KEY = 'yunpanel.ui.preferences.v1';
export const DEFAULT_PREFERENCES = Object.freeze({ theme: 'dark', density: 'comfortable' });
const themes = new Set(['system', 'light', 'dark']);
const densities = new Set(['comfortable', 'compact']);
export function normalizePreferences(value) {
  return { theme: themes.has(value?.theme) ? value.theme : 'dark', density: densities.has(value?.density) ? value.density : 'comfortable' };
}
export function readPreferences(storage) {
  try { return normalizePreferences(JSON.parse(storage.getItem(PREFERENCE_KEY))); }
  catch { return { ...DEFAULT_PREFERENCES }; }
}
export function writePreferences(storage, value) {
  try { storage.setItem(PREFERENCE_KEY, JSON.stringify(normalizePreferences(value))); return true; }
  catch { return false; }
}
export const resolveTheme = (theme, darkSystem = false) => themes.has(theme) && theme !== 'system' ? theme : darkSystem ? 'dark' : 'light';

// Plesk task order; these links do not grant API permissions.
export function navigationGroups(canManage, isOwner = true, isReseller = false, isCustomer = false) {
  const items = isReseller && !isOwner
    ? [['/customers', 'Müşterilerim', 'user'], ['/websites', 'Sitelerim', 'globe']]
    : [['/websites', 'Web Siteleri', 'globe']];
  if (canManage) {
    items.push(
      ['/mail', 'Posta', 'mail'],
      ['/files', 'Dosyalar', 'folder'],
      ['/databases', 'Veritabanları', 'database'],
      ['/statistics', 'İstatistikler', 'dashboard'],
    );
    if (isOwner) items.push(['/customers', 'Müşteriler', 'user'], ['/resellers', 'Bayiler', 'user'], ['/tools-settings', 'Araçlar ve Ayarlar', 'settings']);
  } else if (isOwner) items.push(['/dashboard', 'Genel bakış', 'dashboard']);
  const label = isReseller && !isOwner ? 'Bayi Menüsü' : isCustomer && !isOwner ? 'Müşteri Menüsü' : 'Panel';
  return [{ id: 'panel', label, title: label, items }];
}

export function navigationItemRequiredCapability(to, isOwner = false) {
  if (!isOwner) return null;
  if (to === '/customers') return 'perSiteIsolatedUsers';
  if (to === '/resellers') return 'resellerAccounts';
  return null;
}

// Only working surfaces belong in this directory. No placeholder backup/statistics catalog.
export const TOOLS_SETTINGS_GROUPS = Object.freeze([
  { id: 'server', label: 'Sunucu ve hizmetler', items: [
    ['/servers', 'Sunucu ve servis yönetimi', 'server'],
    ['/firewall', 'Güvenlik duvarı ve port yönetimi', 'shield'],
    ['/dashboard', 'Sunucu genel bakışı', 'dashboard'],
    ['/settings?section=dns', 'Sunucu DNS ve SSL ayarları', 'globe'],
    ['/settings?section=updates', 'YunPanel güncellemeleri', 'refresh'],
    ['/docker', 'Docker ve Stack Yönetimi', 'box'],
  ] },
  { id: 'panel', label: 'Panel ve erişim', items: [
    ['/settings/users', 'Kullanıcılar, bayiler ve müşteriler', 'user'],
    ['/settings?section=account', 'Hesap ve erişim ayarları', 'shield'],
    ['/settings?section=license', 'Lisans yönetimi', 'shield'],
    ['/settings?section=ai', 'AI sağlayıcıları', 'code'],
    ['/settings?section=api', 'API anahtarları', 'code'],
  ] },
  { id: 'diagnostics', label: 'Tanılama ve kayıtlar', items: [
    ['/jobs', 'İşlem geçmişi', 'jobs'], ['/audit', 'Denetim kayıtları', 'shield'],
    ['/logs', 'Sistem ve site günlükleri', 'file'],
    ['/servers#server-diagnostics', 'Sunucu tanılama', 'server'],
    ['/applications', 'Uygulama envanteri', 'code'], ['/domains', 'Gelişmiş alan adı araçları', 'globe'],
  ] },
].map((group) => Object.freeze({ ...group, items: Object.freeze(group.items.map((item) => Object.freeze(item))) })));

export function navigationItemActive(to, pathname) {
  if (typeof pathname !== 'string' || typeof to !== 'string') return false;
  if (pathname === to) return true;
  const currentPath = pathname.split('?')[0].split('#')[0];
  if (to === '/settings/users' || to === '/users') {
    return currentPath === '/users' || currentPath.startsWith('/users/')
      || currentPath === '/settings/users' || currentPath.startsWith('/settings/users/');
  }
  if (to === '/statistics') {
    return currentPath === '/statistics' || currentPath.startsWith('/statistics/')
      || currentPath === '/stats' || currentPath.startsWith('/stats/')
      || currentPath === '/analytics' || currentPath.startsWith('/analytics/');
  }
  if (to === '/files') {
    return currentPath === '/files' || currentPath.startsWith('/files/')
      || currentPath === '/file-manager' || currentPath.startsWith('/file-manager/')
      || currentPath === '/file' || currentPath.startsWith('/file/');
  }
  if (to === '/mail') {
    return currentPath === '/mail' || currentPath.startsWith('/mail/')
      || currentPath === '/email' || currentPath.startsWith('/email/')
      || currentPath === '/mailboxes' || currentPath.startsWith('/mailboxes/')
      || currentPath === '/mailbox' || currentPath.startsWith('/mailbox/');
  }
  if (to === '/databases') {
    return currentPath === '/databases' || currentPath.startsWith('/databases/')
      || currentPath === '/database' || currentPath.startsWith('/database/')
      || currentPath === '/db' || currentPath.startsWith('/db/');
  }
  if (to === '/tools-settings') {
    return (['/tools-settings', '/servers', '/firewall', '/dashboard', '/applications', '/domains', '/jobs', '/audit', '/logs'].some((path) => currentPath === path || currentPath.startsWith(`${path}/`))
      || (currentPath === '/settings' || (currentPath.startsWith('/settings/') && currentPath !== '/settings/users' && !currentPath.startsWith('/settings/users/'))))
      && currentPath !== '/users' && !currentPath.startsWith('/users/');
  }
  if (to.includes('?') || to.includes('#')) {
    return pathname === to || pathname.startsWith(`${to}&`) || pathname.startsWith(`${to}#`);
  }
  return currentPath === to || currentPath.startsWith(`${to}/`);
}

export function websiteCount(resource) {
  if (!['ready', 'stale'].includes(resource?.status) || !Array.isArray(resource.items)) return null;
  return new Set(resource.items.filter((item) => typeof item.id === 'string' && item.id).map((item) => item.id)).size;
}
const DAILY_SITE_TASKS = Object.freeze([
  Object.freeze({
    tab: 'backup',
    label: 'Yedekleme ve Geri Yükleme',
    icon: 'archive',
    globalRoute: '/backup',
    globalLabel: 'Yedekleme ve Geri Yükleme',
    keywords: ['yedek', 'yedekleme', 'backup', 'backups', 'geri yükleme', 'geri yukleme', 'restore'],
  }),
  Object.freeze({
    tab: 'files',
    label: 'Dosya Yöneticisi',
    icon: 'folder',
    globalRoute: '/files',
    globalLabel: 'Dosyalar',
    keywords: ['dosya', 'dosyalar', 'file', 'files', 'klasör', 'klasor'],
  }),
  Object.freeze({
    tab: 'ssl',
    label: 'SSL/TLS Sertifikaları',
    icon: 'shield',
    globalRoute: '/ssl',
    globalLabel: 'SSL/TLS Sertifikaları',
    keywords: ['ssl', 'tls', 'sertifika', 'https', 'certificate'],
  }),
  Object.freeze({
    tab: 'mail',
    label: 'E-posta',
    icon: 'mail',
    globalRoute: '/mail',
    globalLabel: 'Posta',
    keywords: ['posta', 'e-posta', 'eposta', 'mail', 'mailbox', 'email'],
  }),
  Object.freeze({
    tab: 'terminal',
    label: 'Terminal',
    icon: 'terminal',
    globalRoute: null,
    globalLabel: null,
    keywords: ['terminal', 'konsol', 'ssh', 'shell'],
  }),
  Object.freeze({
    tab: 'databases',
    label: 'Veritabanları',
    icon: 'database',
    globalRoute: '/databases',
    globalLabel: 'Veritabanları',
    keywords: ['veritabanı', 'veritabani', 'database', 'databases', 'db', 'sql', 'mariadb', 'mysql'],
  }),
  Object.freeze({
    tab: 'dns',
    label: 'DNS',
    icon: 'globe',
    globalRoute: null,
    globalLabel: null,
    keywords: ['dns', 'nameserver'],
  }),
  Object.freeze({
    tab: 'logs',
    label: 'Günlükler',
    icon: 'file',
    globalRoute: null,
    globalLabel: null,
    keywords: ['günlük', 'gunluk', 'log', 'logs'],
  }),
  Object.freeze({
    tab: 'cron',
    label: 'Zamanlanmış Görevler',
    icon: 'clock',
    globalRoute: '/cron',
    globalLabel: 'Zamanlanmış Görevler',
    keywords: ['cron', 'zamanlanmış', 'zamanlanmis', 'görev', 'gorev'],
  }),
  Object.freeze({
    tab: 'resources',
    label: 'Site Kaynakları',
    icon: 'box',
    globalRoute: null,
    globalLabel: null,
    keywords: ['kaynak', 'kaynaklar', 'disk', 'kota', 'tüketim', 'tuketim'],
  }),
]);

function normalizeSearchText(value) {
  return String(value ?? '').toLocaleLowerCase('tr-TR').trim();
}

function tokenMatchesKeyword(token, keyword) {
  if (!token || token.length < 2 || token.includes('.')) return false;
  if (token === keyword) return true;
  if (keyword.startsWith(token)) return true;
  if (keyword.length >= 4 && token.startsWith(keyword)) return true;
  return false;
}

function tokenMatchesTask(token, task) {
  if (!token || token.length < 2 || token.includes('.')) return false;
  if (task.keywords.some((kw) => tokenMatchesKeyword(token, kw))) return true;
  if (token.length < 3) return false;
  const labelWords = normalizeSearchText(task.label).split(/[\s/]+/).filter((word) => word.length >= 3);
  return labelWords.some((word) => word.startsWith(token));
}

export function commandEntries({ query = '', canManage = false, isOwner = false, isReseller = false, isCustomer = false, domains } = {}) {
  const term = String(query).trim().slice(0, 253);
  const normalized = normalizeSearchText(term);
  const tokens = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  const matches = (value) => normalizeSearchText(value).includes(normalized);
  const sources = navigationGroups(canManage, isOwner, isReseller, isCustomer);
  if (canManage && isOwner) sources.push(...TOOLS_SETTINGS_GROUPS);
  const seen = new Set();
  const entries = sources.flatMap((group) => group.items.map(([to, label, icon]) => ({
    id: to,
    to,
    label,
    title: label,
    icon,
    detail: (to === '/websites' && isReseller && !isOwner) ? 'Sitelerim listesini aç' : group.label,
  })))
    .filter((entry) => { if (seen.has(entry.id) || !matches(entry.label)) return false; seen.add(entry.id); return true; });

  const loadedDomains = ['ready', 'stale'].includes(domains?.status) && Array.isArray(domains.items)
    ? domains.items.filter((item) => typeof item?.id === 'string' && item.id && typeof item?.primaryDomain === 'string' && item.primaryDomain)
    : [];

  if (canManage && normalized) {
    const matchedTasks = DAILY_SITE_TASKS.filter((task) => tokens.some((token) => tokenMatchesTask(token, task)));

    if (matchedTasks.length > 0) {
      for (const task of matchedTasks) {
        if (task.globalRoute && !seen.has(task.globalRoute)) {
          seen.add(task.globalRoute);
          entries.push({
            id: task.globalRoute,
            to: task.globalRoute,
            label: task.globalLabel,
            title: task.globalLabel,
            icon: task.icon,
            detail: 'Site araçları',
          });
        }
      }

      const domainTokens = tokens.filter((token) => !matchedTasks.some((task) => tokenMatchesTask(token, task)));
      const candidateDomains = domainTokens.length > 0
        ? loadedDomains.filter((domain) => domainTokens.every(
          (tok) => normalizeSearchText(domain.primaryDomain).includes(tok)
            || domain.aliases?.some((alias) => normalizeSearchText(alias).includes(tok)),
        ))
        : loadedDomains;

      let addedSiteTasks = 0;
      for (const task of matchedTasks) {
        for (const domain of candidateDomains.slice(0, 6)) {
          if (addedSiteTasks >= 8) break;
          const target = `/websites/${encodeURIComponent(domain.id)}/${task.tab}`;
          if (seen.has(target)) continue;
          seen.add(target);
          addedSiteTasks += 1;
          entries.push({
            id: `domain-task:${domain.id}:${task.tab}`,
            to: target,
            label: `${domain.primaryDomain} · ${task.label}`,
            title: `${domain.primaryDomain} · ${task.label}`,
            icon: task.icon,
            detail: domains.status === 'stale' ? 'Site aracı · son alınan envanter' : 'Doğrudan site aracını aç',
          });
        }
        if (addedSiteTasks >= 8) break;
      }
    }
  }

  if (loadedDomains.length > 0) {
    const sites = loadedDomains.filter((item) => matches(item.primaryDomain) || item.aliases?.some(matches)).slice(0, 8);
    for (const domain of sites) {
      const target = `/websites/${encodeURIComponent(domain.id)}/overview`;
      if (seen.has(target)) continue;
      seen.add(target);
      entries.push({
        id: `domain:${domain.id}`,
        to: target,
        label: domain.primaryDomain,
        title: domain.primaryDomain,
        icon: 'globe',
        detail: domains.status === 'stale' ? 'Alan adı · son alınan envanter' : 'Alan adı · site çalışma alanı',
      });
    }
  }
  if (term) entries.push({ id: 'search-all', to: `/websites?q=${encodeURIComponent(term)}`, label: `“${term}” için tüm sonuçlar`, title: `“${term}” için tüm sonuçlar`, icon: 'search', detail: isReseller && !isOwner ? 'Sitelerim listesini aç' : 'Web siteleri listesini aç' });
  return entries;
}
export const tabKey = (tab) => (Array.isArray(tab) ? tab[0] : (tab?.id ?? tab?.key ?? tab));

const siteGroups = [
  { id: 'dashboard', label: 'Site', icon: 'dashboard', keys: ['overview', 'files', 'databases', 'resources', 'ssl', 'node', 'php', 'wordpress', 'deploy', 'logs', 'analytics', 'backup'] },
  { id: 'hosting', label: 'Barındırma ve DNS', icon: 'globe', keys: ['hosting', 'dns', 'settings', 'domains', 'access', 'terminal', 'cron'] },
  { id: 'mail', label: 'Posta', icon: 'mail', keys: ['mail'] },
];
export function groupSiteTabs(tabs = []) {
  if (!Array.isArray(tabs)) return [];
  const known = new Set(siteGroups.flatMap((group) => group.keys));
  const groups = siteGroups.map((group) => ({
    ...group,
    tabs: group.keys.map((key) => tabs.find((tab) => tabKey(tab) === key)).filter(Boolean),
  })).filter((group) => group.tabs.length);
  const extra = tabs.filter((tab) => !known.has(tabKey(tab)));
  if (extra.length) groups.push({ id: 'extensions', label: 'Ek Araçlar', icon: 'box', keys: extra.map((tab) => tabKey(tab)), tabs: extra });
  return groups;
}
