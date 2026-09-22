// Presentation only: never grants filesystem permissions or replaces API checks.
const SUPPORTED_RUNTIMES = new Set(['static', 'node', 'php', 'python']);
const hasId = (value) => typeof value === 'string' && value.length > 0;
const result = (state, website = null) => ({ state, website });

export function resolveSiteFilesAccess({ domainId, domains, websites, canManage = false } = {}) {
  if (!canManage) return result('forbidden');
  // Old inventories must not mount a fresh file manager after a permission change.
  if (domains?.status !== 'ready' || websites?.status !== 'ready') return result('unavailable');
  if (!Array.isArray(domains.items) || !Array.isArray(websites.items)) return result('unavailable');
  if (!hasId(domainId)) return result('not_found');
  const matches = domains.items.filter((item) => item?.id === domainId);
  if (matches.length !== 1) return result('not_found');
  const domain = matches[0];
  if (!hasId(domain.websiteId)) return result('unbound');
  const sites = websites.items.filter((item) => item?.id === domain.websiteId);
  if (sites.length !== 1) return result('not_found');
  const website = sites[0];
  if (!hasId(domain.serverId) || domain.serverId !== website.serverId) return result('inconsistent');
  if (!SUPPORTED_RUNTIMES.has(website.runtimeType)) return result('unsupported');
  return result('ready', website);
}
