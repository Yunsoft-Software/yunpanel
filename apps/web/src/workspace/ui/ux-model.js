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
export function navigationGroups(canManage, isOwner = true) {
  const items = [['/websites', 'Web Siteleri ve Alan Adları', 'globe']];
  if (canManage) {
    items.push(['/mail', 'Posta', 'mail'], ['/files', 'Dosyalar', 'folder'], ['/databases', 'Veritabanları', 'database']);
    if (isOwner) items.push(['/tools-settings', 'Araçlar ve Ayarlar', 'settings'], ['/settings/users', 'Kullanıcılar', 'user']);
  } else if (isOwner) items.push(['/dashboard', 'Genel bakış', 'dashboard']);
  return [{ id: 'panel', label: 'Panel', items }];
}

// Only working surfaces belong in this directory. No placeholder backup/statistics catalog.
export const TOOLS_SETTINGS_GROUPS = Object.freeze([
  { id: 'server', label: 'Sunucu ve hizmetler', items: [
    ['/servers', 'Sunucu ve servis yönetimi', 'server'],
    ['/dashboard', 'Sunucu genel bakışı', 'dashboard'],
    ['/settings?section=dns', 'Sunucu DNS ve SSL ayarları', 'globe'],
    ['/settings?section=updates', 'YunPanel güncellemeleri', 'refresh'],
    ['/docker', 'Docker projeleri', 'box'],
  ] },
  { id: 'panel', label: 'Panel ve erişim', items: [
    ['/settings/users', 'Kullanıcılar, bayiler ve müşteriler', 'user'],
    ['/settings?section=account', 'Hesap ve erişim ayarları', 'shield'],
    ['/settings?section=ai', 'AI sağlayıcıları', 'code'],
  ] },
  { id: 'diagnostics', label: 'Tanılama ve kayıtlar', items: [
    ['/jobs', 'İşlem geçmişi', 'jobs'], ['/audit', 'Denetim kayıtları', 'shield'],
    ['/servers#server-diagnostics', 'Sunucu tanılama', 'server'],
    ['/applications', 'Uygulama envanteri', 'code'], ['/domains', 'Gelişmiş alan adı araçları', 'globe'],
  ] },
].map((group) => Object.freeze({ ...group, items: Object.freeze(group.items.map((item) => Object.freeze(item))) })));

export function navigationItemActive(to, pathname) {
  if (typeof pathname !== 'string') return false;
  if (to === '/tools-settings') {
    return ['/tools-settings', '/servers', '/dashboard', '/docker', '/applications', '/domains', '/jobs', '/audit'].some((path) => pathname === path || pathname.startsWith(`${path}/`))
      || (pathname === '/settings' || (pathname.startsWith('/settings/') && pathname !== '/settings/users' && !pathname.startsWith('/settings/users/')));
  }
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function websiteCount(resource) {
  if (!['ready', 'stale'].includes(resource?.status) || !Array.isArray(resource.items)) return null;
  return new Set(resource.items.filter((item) => typeof item.id === 'string' && item.id).map((item) => item.id)).size;
}
export function commandEntries({ query = '', canManage = false, isOwner = false, domains } = {}) {
  const term = String(query).trim().slice(0, 253);
  const normalized = term.toLocaleLowerCase('tr-TR');
  const matches = (value) => String(value ?? '').toLocaleLowerCase('tr-TR').includes(normalized);
  const sources = navigationGroups(canManage, isOwner);
  if (canManage && isOwner) sources.push(...TOOLS_SETTINGS_GROUPS);
  const seen = new Set();
  const entries = sources.flatMap((group) => group.items.map(([to, label, icon]) => ({ id: to, to, label, icon, detail: group.label })))
    .filter((entry) => { if (seen.has(entry.id) || !matches(entry.label)) return false; seen.add(entry.id); return true; });
  if (['ready', 'stale'].includes(domains?.status) && Array.isArray(domains.items)) {
    const sites = domains.items.filter((item) => typeof item.id === 'string' && typeof item.primaryDomain === 'string' && (matches(item.primaryDomain) || item.aliases?.some(matches))).slice(0, 8);
    for (const domain of sites) entries.push({ id: `domain:${domain.id}`, to: `/websites/${encodeURIComponent(domain.id)}/overview`, label: domain.primaryDomain, icon: 'globe', detail: domains.status === 'stale' ? 'Alan adı · son alınan envanter' : 'Alan adı · site çalışma alanı' });
  }
  if (term) entries.push({ id: 'search-all', to: `/websites?q=${encodeURIComponent(term)}`, label: `“${term}” için tüm sonuçlar`, icon: 'search', detail: 'Web siteleri listesini aç' });
  return entries;
}

const siteGroups = [
  { id: 'dashboard', label: 'Genel Bakış', icon: 'dashboard', keys: ['overview', 'files', 'databases', 'ssl', 'node', 'deploy', 'logs'] },
  { id: 'hosting', label: 'Barındırma ve DNS', icon: 'globe', keys: ['hosting', 'dns', 'settings', 'domains', 'terminal', 'cron', 'backup'] },
  { id: 'mail', label: 'Posta', icon: 'mail', keys: ['mail'] },
];
export function groupSiteTabs(tabs) {
  const known = new Set(siteGroups.flatMap((group) => group.keys));
  // Legacy resources remains addressable, but it is the existing database surface,
  // not a fourth user-facing workspace or a duplicate tool button.
  known.add('resources');
  const groups = siteGroups.map((group) => ({ ...group, tabs: group.keys.map((key) => tabs.find(([tab]) => tab === key)).filter(Boolean) })).filter((group) => group.tabs.length);
  const extra = tabs.filter(([key]) => !known.has(key));
  if (extra.length) groups.push({ id: 'extensions', label: 'Ek site araçları', icon: 'box', keys: extra.map(([key]) => key), tabs: extra });
  return groups;
}
