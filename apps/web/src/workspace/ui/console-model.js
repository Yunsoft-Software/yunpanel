// Presentation projections only. All authorization and handoff checks stay server-side.
export function usagePercent(used, total) {
  return Number.isFinite(used) && used >= 0 && Number.isFinite(total) && total > 0 && used <= total
    ? used / total * 100 : null;
}
export function readableItems(resource) {
  return ['ready', 'stale'].includes(resource?.status) && Array.isArray(resource.items) ? resource.items : [];
}
export function databaseAccessView(database, domains) {
  const ownership = database?.ownership;
  const websiteId = ownership?.websiteId;
  const domain = websiteId ? readableItems(domains).find((item) => item.websiteId === websiteId && typeof item.id === 'string' && item.id) : null;
  const siteHref = domain ? `/websites/${encodeURIComponent(domain.id)}/resources` : null;
  const canOpen = Boolean(websiteId && ownership?.credential?.id);
  return {
    canOpen,
    siteHref,
    siteLabel: domain?.primaryDomain || (websiteId ? 'Bağlı site' : 'Siteye bağlı değil'),
    label: canOpen ? 'phpMyAdmin’i aç' : websiteId ? 'Erişimi yapılandır' : 'Siteye bağla',
    detail: canOpen ? 'Yeni sekmede, site kullanıcısıyla açılır.' : websiteId
      ? 'Bu veritabanı için kullanıcı oluşturulmalı.'
      : 'Önce bir sitenin veritabanı kaynaklarına bağlayın.',
  };
}
export function filterConsoleDatabases(databases, { query = '', access = 'all', domains } = {}) {
  const term = String(query).trim().toLocaleLowerCase('tr-TR');
  return (Array.isArray(databases) ? databases : []).filter((database) => {
    const view = databaseAccessView(database, domains);
    if (access === 'ready' && !view.canOpen || access === 'attention' && view.canOpen) return false;
    return [database.name, database.ownership?.credential?.username, view.siteLabel]
      .some((value) => String(value ?? '').toLocaleLowerCase('tr-TR').includes(term));
  });
}
export function paginateConsoleItems(items, requestedPage = 1, pageSize = 15) {
  const size = Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100 ? pageSize : 15;
  const count = items.length;
  const pages = Math.max(1, Math.ceil(count / size));
  const requested = Number.parseInt(requestedPage, 10);
  const page = Math.min(pages, Math.max(1, Number.isFinite(requested) ? requested : 1));
  return { items: items.slice((page - 1) * size, page * size), count, pages, page };
}
