// Presentation only. Never infer Website identity from a hostname or Domain ID.
export const PREFERENCE_KEY = 'yunpanel.ui.preferences.v1';
export const DEFAULT_PREFERENCES = Object.freeze({ theme: 'system', density: 'comfortable' });
const themes = new Set(['system', 'light', 'dark']);
const densities = new Set(['comfortable', 'compact']);
export function normalizePreferences(value) {
  return { theme: themes.has(value?.theme) ? value.theme : 'system', density: densities.has(value?.density) ? value.density : 'comfortable' };
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
    : [['/websites', 'Web Siteleri ve Alan Adları', 'globe']];
  if (canManage) {
    items.push(
      ['/mail', 'Posta', 'mail'],
      ['/files', 'Dosyalar', 'folder'],
      ['/databases', 'Veritabanları', 'database'],
      ['/statistics', 'İstatistikler', 'dashboard'],
    );
    if (isOwner) items.push(['/tools-settings', 'Araçlar ve Ayarlar', 'settings'], ['/settings/users', 'Kullanıcılar', 'user']);
  } else if (isOwner) items.push(['/dashboard', 'Genel bakış', 'dashboard']);
  const label = isReseller && !isOwner ? 'Bayi Menüsü' : isCustomer && !isOwner ? 'Müşteri Menüsü' : 'Panel';
  return [{ id: 'panel', label, title: label, items }];
}

// Only working surfaces belong in this directory. No placeholder backup/statistics catalog.
export const TOOLS_SETTINGS_GROUPS = Object.freeze([
  { id: 'server', label: 'Sunucu ve hizmetler', items: [
    ['/servers', 'Sunucu ve servis yönetimi', 'server'],
    ['/firewall', 'Güvenlik duvarı ve port yönetimi', 'shield'],
    ['/dashboard', 'Sunucu genel bakışı', 'dashboard'],
    ['/settings?section=dns', 'Sunucu DNS ve SSL ayarları', 'globe'],
    ['/settings?section=updates', 'YunPanel güncellemeleri', 'refresh'],
    ['/docker', 'Docker projeleri (Ürün uzantısı)', 'box'],
  ] },
  { id: 'panel', label: 'Panel ve erişim', items: [
    ['/settings/users', 'Kullanıcılar, bayiler ve müşteriler', 'user'],
    ['/settings?section=account', 'Hesap ve erişim ayarları', 'shield'],
    ['/settings?section=ai', 'AI sağlayıcıları (Ürün uzantısı)', 'code'],
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
    return (['/tools-settings', '/servers', '/firewall', '/dashboard', '/docker', '/applications', '/domains', '/jobs', '/audit', '/logs'].some((path) => currentPath === path || currentPath.startsWith(`${path}/`))
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
export function commandEntries({ query = '', canManage = false, isOwner = false, isReseller = false, isCustomer = false, domains } = {}) {
  const term = String(query).trim().slice(0, 253);
  const normalized = term.toLocaleLowerCase('tr-TR');
  const matches = (value) => String(value ?? '').toLocaleLowerCase('tr-TR').includes(normalized);
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
  if (['ready', 'stale'].includes(domains?.status) && Array.isArray(domains.items)) {
    const sites = domains.items.filter((item) => typeof item.id === 'string' && typeof item.primaryDomain === 'string' && (matches(item.primaryDomain) || item.aliases?.some(matches))).slice(0, 8);
    for (const domain of sites) entries.push({ id: `domain:${domain.id}`, to: `/websites/${encodeURIComponent(domain.id)}/overview`, label: domain.primaryDomain, title: domain.primaryDomain, icon: 'globe', detail: domains.status === 'stale' ? 'Alan adı · son alınan envanter' : 'Alan adı · site çalışma alanı' });
  }
  if (term) entries.push({ id: 'search-all', to: `/websites?q=${encodeURIComponent(term)}`, label: `“${term}” için tüm sonuçlar`, title: `“${term}” için tüm sonuçlar`, icon: 'search', detail: isReseller && !isOwner ? 'Sitelerim listesini aç' : 'Web siteleri listesini aç' });
  return entries;
}
export const tabKey = (tab) => (Array.isArray(tab) ? tab[0] : (tab?.id ?? tab?.key ?? tab));

const siteGroups = [
  { id: 'dashboard', label: 'Genel Bakış', icon: 'dashboard', keys: ['overview', 'files', 'databases', 'ssl', 'node', 'php', 'deploy', 'logs', 'analytics'] },
  { id: 'hosting', label: 'Barındırma ve DNS', icon: 'globe', keys: ['hosting', 'dns', 'settings', 'domains', 'access', 'terminal', 'cron', 'backup'] },
  { id: 'mail', label: 'Posta', icon: 'mail', keys: ['mail'] },
];
export function groupSiteTabs(tabs = []) {
  if (!Array.isArray(tabs)) return [];
  const known = new Set(siteGroups.flatMap((group) => group.keys));
  // Legacy resources remains addressable, but it is the existing database surface,
  // not a fourth user-facing workspace or a duplicate tool button.
  known.add('resources');
  const groups = siteGroups.map((group) => ({
    ...group,
    tabs: group.keys.map((key) => tabs.find((tab) => tabKey(tab) === key)).filter(Boolean),
  })).filter((group) => group.tabs.length);
  const extra = tabs.filter((tab) => !known.has(tabKey(tab)));
  if (extra.length) groups.push({ id: 'extensions', label: 'Ürün uzantıları', icon: 'box', keys: extra.map((tab) => tabKey(tab)), tabs: extra });
  return groups;
}
