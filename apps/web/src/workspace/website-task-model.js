import { siteHref } from './site-model.js';

const hasId = (value) => typeof value === 'string' && value.length > 0;
const ready = (resource) => resource?.status === 'ready' && Array.isArray(resource.items);
const sameServer = (left, right) => hasId(left?.serverId) && left.serverId === right?.serverId;
const runtimeLabels = { node: 'Node.js', php: 'PHP-FPM', python: 'Python', docker: 'Docker', static: 'Statik site' };
const primaryTools = [
  ['files', 'Dosya Yöneticisi', 'folder'], ['databases', 'Veritabanları', 'database'],
  ['ssl', 'SSL/TLS Sertifikaları', 'shield'], ['dns', 'DNS', 'globe'],
  ['mail', 'Posta', 'mail'], ['logs', 'Günlükler', 'file'],
];

// Duplicate identities are ambiguous, not "first record wins". Index once per
// collection update rather than scanning every collection for every visible card.
function index(resource) {
  const records = new Map();
  if (ready(resource)) {
    for (const item of resource.items) {
      if (!hasId(item?.id)) continue;
      records.set(item.id, records.has(item.id) ? null : item);
    }
  }
  return records;
}

/** Navigation presentation only. The destination and API still enforce access. */
export function createWebsiteTaskResolver({ domains, websites, applications, canManage = false, isOwner = false } = {}) {
  const domainIndex = index(domains);
  const websiteIndex = index(websites);
  const applicationIndex = index(applications);
  return function resolve(domainId) {
    const domain = domainIndex.get(domainId);
    const domainProblem = !canManage ? 'Bu hesabın site yönetimi yetkisi yok.'
      : !ready(domains) ? 'Alan adı listesi güncel değil. Listeyi yenileyin.'
        : !domain || !hasId(domain.serverId) ? 'Alan adı kimliği doğrulanamadı. Listeyi yenileyin.' : null;
    const candidate = domain && websiteIndex.get(domain.websiteId);
    const website = !domainProblem && candidate && sameServer(domain, candidate) ? candidate : null;
    const bindingProblem = domainProblem
      ?? (!ready(websites) ? 'Site bağlantısı güncel değil. Listeyi yenileyin.'
        : !website ? 'Alan adı ile site bağlantısı doğrulanamadı.' : null);
    const applicationCandidate = website && applicationIndex.get(website.applicationId);
    const application = !bindingProblem && applicationCandidate && sameServer(website, applicationCandidate) ? applicationCandidate : null;
    const applicationProblem = bindingProblem
      ?? (!ready(applications) ? 'Uygulama bilgisi güncel değil. Listeyi yenileyin.'
        : !application ? 'Bu siteye bağlı uygulama doğrulanamadı.' : null);
    function tool([key, label, icon], reason = domainProblem) {
      return { key, label, icon, href: reason ? null : siteHref(domain.id, key), reason };
    }
    const tools = primaryTools.map((entry) => tool(entry, ['databases', 'mail'].includes(entry[0]) ? bindingProblem : domainProblem));
    // Files stays visible even for an unbound/unsupported Website. The existing
    // SiteFilesPanel provides its verified setup/unsupported/error explanation.
    const secondaryTools = [tool(['hosting', 'Barındırma ve DNS', 'settings'])];
    if (application || !website || hasId(website.applicationId)) {
      secondaryTools.push(tool(['node', application?.type === 'node' ? 'Node.js' : 'Uygulama', 'code'], applicationProblem));
      secondaryTools.push(tool(['deploy', 'Git / Yayınlama', 'git'], applicationProblem));
    }
    return {
      domainReady: !domainProblem,
      runtimeLabel: website ? (runtimeLabels[website.runtimeType] ?? 'Tür bilgisi alınamadı') : 'Tür bilgisi doğrulanamadı',
      applicationName: typeof application?.name === 'string' ? application.name : null,
      bindingProblem,
      tools,
      secondaryTools,
      createSubdomainHref: isOwner && !domainProblem ? `/websites/new?parent=${encodeURIComponent(domain.id)}` : null,
    };
  };
}

// URL state, not a second list store. Unknown query parameters are preserved.
export function siteListFilterParams(current, name, value) {
  const next = new URLSearchParams(current);
  if (!['q', 'type', 'status', 'sort', 'page'].includes(name)) return next;
  if (value && value !== 'all') next.set(name, value); else next.delete(name);
  if (name !== 'page') next.delete('page');
  return next;
}
export function clearSiteListFilters(current) {
  const next = new URLSearchParams(current);
  for (const name of ['q', 'type', 'status', 'sort', 'page']) next.delete(name);
  return next;
}
