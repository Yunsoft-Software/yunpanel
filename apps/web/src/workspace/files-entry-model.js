// Presentation/entry resolution only. The API remains the authorization boundary.
const SUPPORTED_RUNTIMES = new Set(['static', 'node', 'php', 'python']);
const hasId = (value) => typeof value === 'string' && value.length > 0;

export function filesTargets(websites, domains) {
  if (!Array.isArray(websites) || !Array.isArray(domains)) return [];
  const counts = new Map();
  for (const site of websites) {
    if (hasId(site?.id)) counts.set(site.id, (counts.get(site.id) ?? 0) + 1);
  }
  const domainCounts = new Map();
  for (const domain of domains) {
    if (hasId(domain?.id)) domainCounts.set(domain.id, (domainCounts.get(domain.id) ?? 0) + 1);
  }
  return websites.filter((site) => hasId(site?.id) && counts.get(site.id) === 1).map((site) => {
    const bound = domains.filter((domain) => hasId(site.serverId) && hasId(domain?.id)
      && domainCounts.get(domain.id) === 1 && domain.websiteId === site.id && domain.serverId === site.serverId);
    // Explicit relationships only: do not guess parents or identities from hostnames.
    const domain = bound.find((item) => !item.parentDomainId) ?? bound[0] ?? null;
    const reason = !domain ? 'unbound' : !SUPPORTED_RUNTIMES.has(site.runtimeType) ? 'unsupported' : null;
    return {
      websiteId: site.id,
      domainId: domain?.id ?? null,
      label: hasId(domain?.primaryDomain) ? domain.primaryDomain : hasId(site.name) ? site.name : site.id,
      runtimeType: site.runtimeType,
      reason,
      href: reason ? null : `/websites/${encodeURIComponent(domain.id)}/files`,
    };
  }).sort((a, b) => a.label.localeCompare(b.label, 'tr'));
}

export function resolveFilesEntry({ websites, domains, requestedSiteId = null, canManage = false }) {
  if (!canManage) return { state: 'forbidden', targets: [], target: null };
  // Stale or forbidden inventories never grant a new file-manager handoff.
  if (websites?.status !== 'ready' || domains?.status !== 'ready') {
    return { state: 'unavailable', targets: [], target: null };
  }
  const targets = filesTargets(websites.items, domains.items);
  if (requestedSiteId !== null) {
    const target = targets.find((item) => item.websiteId === requestedSiteId);
    if (!target) return { state: 'not_found', targets, target: null };
    return { state: target.reason ?? 'ready', targets, target };
  }
  if (targets.length === 0) return { state: 'empty', targets, target: null };
  if (targets.length === 1) {
    const target = targets[0];
    return { state: target.reason ?? 'ready', targets, target };
  }
  return { state: 'choose', targets, target: null };
}
