// Entry resolution only; never authorizes a resource or calls a mutation.
const TOOLS = new Set([
  'mail', 'databases', 'statistics', 'analytics',
  'backup', 'backups', 'cron', 'scheduled-tasks',
  'logs', 'php', 'access', 'ssl',
]);
const hasId = (value) => typeof value === 'string' && value.length > 0;
const uniqueIds = (items) => {
  const counts = new Map();
  for (const item of items) if (hasId(item?.id)) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return items.filter((item) => hasId(item?.id) && counts.get(item.id) === 1);
};
function toolDestinationTab(tool) {
  if (['statistics', 'analytics'].includes(tool)) return 'analytics';
  if (['scheduled-tasks', 'cron'].includes(tool)) return 'cron';
  if (['backups', 'backup'].includes(tool)) return 'backup';
  if (['wp', 'wordpress', 'php'].includes(tool)) return 'php';
  if (['sftp', 'ssh', 'access'].includes(tool)) return 'access';
  if (['certs', 'certificate', 'certificates', 'ssl'].includes(tool)) return 'ssl';
  return tool;
}
export function resolveSiteToolEntry({ tool, websites, domains, canManage = false, requestedSiteId = null } = {}) {
  const result = (state, targets = [], target = null) => ({ state, targets, target });
  if (!TOOLS.has(tool)) return result('unsupported');
  if (!canManage) return result('forbidden');
  if (websites?.status !== 'ready' || domains?.status !== 'ready'
    || !Array.isArray(websites.items) || !Array.isArray(domains.items)) return result('unavailable');
  const sites = uniqueIds(websites.items);
  const domainItems = uniqueIds(domains.items);
  let selected = sites;
  if (requestedSiteId !== null) {
    const siteMatches = sites.filter((site) => site.id === requestedSiteId);
    if (siteMatches.length > 0) {
      selected = siteMatches;
    } else {
      const domainMatch = domainItems.find((d) => d.id === requestedSiteId || d.primaryDomain?.toLowerCase() === requestedSiteId.toLowerCase());
      if (domainMatch && hasId(domainMatch.websiteId)) {
        selected = sites.filter((site) => site.id === domainMatch.websiteId);
      } else {
        return result('not_found');
      }
    }
  }
  const destTab = toolDestinationTab(tool);
  // Mail is domain-scoped: do not silently select a parent when a Website has
  // multiple domains. Each verified domain has an explicit destination.
  const targets = selected.flatMap((site) => {
    const bound = domainItems.filter((domain) => hasId(site.serverId) && domain.websiteId === site.id && domain.serverId === site.serverId);
    if (!bound.length) return [{ id: `site:${site.id}`, websiteId: site.id, domainId: null, label: hasId(site.name) ? site.name : site.id, href: null }];
    return bound.map((domain) => ({ id: `domain:${domain.id}`, websiteId: site.id, domainId: domain.id,
      label: hasId(domain.primaryDomain) ? domain.primaryDomain : hasId(site.name) ? site.name : site.id,
      href: `/websites/${encodeURIComponent(domain.id)}/${destTab}` }));
  }).sort((a, b) => a.label.localeCompare(b.label, 'tr'));
  if (!targets.length) return result('empty');
  if (targets.length === 1) return result(targets[0].href ? 'ready' : 'unbound', targets, targets[0]);
  return result('choose', targets);
}
