import { cronScope } from './cron-task-client.js';

// Display routing only. The authenticated API remains the authorization boundary.
export function resolveCronAccess({ domainId, domains, websites, canManage = false } = {}) {
  if (!canManage || [domains?.status, websites?.status].some((status) => ['unauthorized', 'forbidden'].includes(status))) return { state: 'forbidden' };
  if (domains?.status !== 'ready' || websites?.status !== 'ready'
    || !Array.isArray(domains.items) || !Array.isArray(websites.items)) return { state: 'unavailable' };
  const matches = domains.items.filter((item) => item?.id === domainId);
  if (typeof domainId !== 'string' || !domainId || matches.length !== 1) return { state: 'not_found' };
  const domain = matches[0];
  if (!domain.websiteId) return { state: 'unbound' };
  const sites = websites.items.filter((item) => item?.id === domain.websiteId);
  if (sites.length !== 1) return { state: 'not_found' };
  const website = sites[0];
  if (domain.serverId !== website.serverId) return { state: 'inconsistent' };
  // Match the current HTTP service, not the wider registry's future capabilities.
  if (!['static', 'node', 'php'].includes(website.runtimeType)) return { state: 'unsupported' };
  try {
    return { state: 'ready', name: domain.primaryDomain,
      scope: cronScope({ websiteId: website.id, serverId: website.serverId, applicationId: website.applicationId, unixUser: website.unixUser }) };
  } catch { return { state: 'inconsistent' }; }
}
