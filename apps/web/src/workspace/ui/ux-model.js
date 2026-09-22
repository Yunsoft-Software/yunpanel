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

const groups = [
  { id: 'daily', label: 'Günlük kullanım', items: [['/websites', 'Web siteleri', 'globe'], ['/dashboard', 'Genel bakış', 'dashboard']] },
  { id: 'resources', label: 'Kaynaklar', items: [['/databases', 'Veritabanları', 'database'], ['/mail', 'Mail', 'mail'], ['/docker', 'Docker', 'box']] },
  { id: 'system', label: 'Sistem', items: [['/servers', 'Sunucu', 'server'], ['/settings', 'Ayarlar', 'settings']] },
];
const readOnlyRoutes = new Set(['/dashboard', '/websites', '/servers']);
export function navigationGroups(canManage, isOwner = true) {
  if (!isOwner) {
    return [
      { id: 'daily', label: 'Çalışma alanı', items: [['/websites', 'Web siteleri', 'globe']] },
    ];
  }
  return groups.map((group) => ({ ...group, items: group.items.filter(([to]) => canManage || readOnlyRoutes.has(to)) })).filter((group) => group.items.length);
}
export function websiteCount(resource) {
  if (!['ready', 'stale'].includes(resource?.status) || !Array.isArray(resource.items)) return null;
  return new Set(resource.items.filter((item) => typeof item.id === 'string' && item.id).map((item) => item.id)).size;
}
export function commandEntries({ query = '', canManage = false, domains } = {}) {
  const term = String(query).trim().slice(0, 253);
  const normalized = term.toLocaleLowerCase('tr-TR');
  const matches = (value) => String(value ?? '').toLocaleLowerCase('tr-TR').includes(normalized);
  const entries = navigationGroups(canManage).flatMap((group) => group.items.map(([to, label, icon]) => ({ id: to, to, label, icon, detail: group.label }))).filter((entry) => matches(entry.label));
  if (['ready', 'stale'].includes(domains?.status) && Array.isArray(domains.items)) {
    const sites = domains.items.filter((item) => typeof item.id === 'string' && typeof item.primaryDomain === 'string' && (matches(item.primaryDomain) || item.aliases?.some(matches))).slice(0, 8);
    for (const domain of sites) entries.push({ id: `domain:${domain.id}`, to: `/websites/${encodeURIComponent(domain.id)}/overview`, label: domain.primaryDomain, icon: 'globe', detail: domains.status === 'stale' ? 'Alan adı · son alınan envanter' : 'Alan adı · site çalışma alanı' });
  }
  if (term) entries.push({ id: 'search-all', to: `/websites?q=${encodeURIComponent(term)}`, label: `“${term}” için tüm sonuçlar`, icon: 'search', detail: 'Web siteleri listesini aç' });
  return entries;
}

const siteGroups = [
  { id: 'overview', label: 'Genel bakış', icon: 'dashboard', keys: ['overview'] },
  { id: 'application', label: 'Uygulama', icon: 'code', keys: ['node', 'deploy'] },
  { id: 'domains', label: 'Alan adları', icon: 'globe', keys: ['domains', 'dns', 'ssl'] },
  { id: 'resources', label: 'Kaynaklar', icon: 'database', keys: ['resources', 'files'] },
  { id: 'operations', label: 'Operasyon', icon: 'terminal', keys: ['logs', 'terminal'] },
  { id: 'settings', label: 'Ayarlar', icon: 'settings', keys: ['settings'] },
];
export function groupSiteTabs(tabs) {
  const known = new Set(siteGroups.flatMap((group) => group.keys));
  return siteGroups.map((group) => ({ ...group, tabs: tabs.filter(([key]) => group.keys.includes(key) || (group.id === 'operations' && !known.has(key))) })).filter((group) => group.tabs.length);
}
