import { discoverAppliedTrafficVhosts } from '@yunpanel/host-runtime';

function currentUtcMonth(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 7);
}

function summarizeVhostsByWebsite(vhosts = []) {
  const grouped = new Map();
  for (const entry of vhosts) {
    if (!entry || typeof entry.websiteId !== 'string') continue;
    const id = entry.websiteId.trim().toLowerCase();
    if (!id) continue;
    const list = grouped.get(id) ?? [];
    list.push(entry);
    grouped.set(id, list);
  }
  const summary = new Map();
  for (const [id, list] of grouped.entries()) {
    const allDedicated = list.every((item) => item.mode === 'dedicated_traffic_log');
    const allGuardReady = list.every((item) => item.trafficGuardReady === true);
    const anyDedicated = list.some((item) => item.mode === 'dedicated_traffic_log');
    summary.set(id, Object.freeze({
      trafficGuardReady: allGuardReady,
      accountingMode: allDedicated ? 'dedicated_traffic_log' : (anyDedicated ? 'mixed' : 'legacy_applied_access_log'),
      includesStaticAssets: allDedicated,
    }));
  }
  return summary;
}

export function createWebsiteTrafficCoordinator({
  domainRegistry,
  websiteRegistry = null,
  hostingAccounts = null,
  websiteTrafficLedger = null,
  websiteTrafficEnforcer = null,
  sitesDir = '/etc/nginx/sites-enabled',
  allowedLogDir = '/var/log/nginx',
  now = () => Date.now(),
} = {}) {
  if (!domainRegistry || typeof domainRegistry.listDomains !== 'function') {
    throw new TypeError('Website traffic coordinator requires a live domainRegistry');
  }

  let reconcileChain = Promise.resolve();
  let activeEnforcer = websiteTrafficEnforcer ?? null;
  let appliedBlockedWebsiteIds = new Set();
  let appliedVhostsByWebsiteId = new Map();
  let hasDiscovered = false;

  function setEnforcer(nextEnforcer) {
    activeEnforcer = nextEnforcer ?? null;
  }

  async function discoverAppliedVhosts() {
    const domains = await domainRegistry.listDomains();
    const discovered = await discoverAppliedTrafficVhosts({
      domains: Array.isArray(domains) ? domains : [],
      sitesDir,
      allowedLogDir,
    });
    appliedVhostsByWebsiteId = summarizeVhostsByWebsite(discovered.vhosts);
    hasDiscovered = true;
    return discovered;
  }

  async function reconcileTrafficEnforcementInternal({ syncLedger = true } = {}) {
    await discoverAppliedVhosts();

    if (syncLedger && typeof websiteTrafficLedger?.sync === 'function') {
      try {
        await websiteTrafficLedger.sync();
      } catch {
        // Ledger preserves its own collector error state without crashing reconciliation.
      }
    }

    const currentMonth = currentUtcMonth(now());
    const enforcedCustomers = typeof hostingAccounts?.listEnforcedTrafficCustomers === 'function'
      ? hostingAccounts.listEnforcedTrafficCustomers()
      : [];

    const desiredBlocked = new Set();
    for (const customer of Array.isArray(enforcedCustomers) ? enforcedCustomers : []) {
      if (!customer || !Number.isSafeInteger(customer.maxTrafficMb) || customer.maxTrafficMb < 0) continue;
      const siteIds = Array.isArray(customer.websiteIds)
        ? [...new Set(customer.websiteIds.map((id) => String(id).trim().toLowerCase()).filter(Boolean))]
        : [];
      if (siteIds.length === 0) continue;

      const maxBytes = customer.maxTrafficMb * 1024 * 1024;
      if (typeof websiteTrafficLedger?.getMonthlyTotalsForWebsites !== 'function') continue;

      const totals = await websiteTrafficLedger.getMonthlyTotalsForWebsites(siteIds, {
        month: currentMonth,
        sync: false,
      });
      if (totals?.ok && Number.isFinite(totals.bytes) && totals.bytes >= maxBytes) {
        for (const siteId of siteIds) {
          desiredBlocked.add(siteId);
        }
      }
    }

    const sortedDesired = [...desiredBlocked].sort((a, b) => a.localeCompare(b));

    if (typeof activeEnforcer?.reconcile !== 'function') {
      return Object.freeze({
        month: currentMonth,
        applied: false,
        blockedWebsiteIds: Object.freeze([]),
        desiredBlockedWebsiteIds: Object.freeze(sortedDesired),
        reconcileResult: null,
      });
    }

    const domains = await domainRegistry.listDomains();
    const reconcileResult = await activeEnforcer.reconcile({
      domains: Array.isArray(domains) ? domains : [],
      blockedWebsiteIds: sortedDesired,
    });

    appliedBlockedWebsiteIds = new Set(sortedDesired);
    await discoverAppliedVhosts().catch(() => {});

    return Object.freeze({
      month: currentMonth,
      applied: true,
      blockedWebsiteIds: Object.freeze(sortedDesired),
      desiredBlockedWebsiteIds: Object.freeze(sortedDesired),
      reconcileResult,
    });
  }

  function reconcileTrafficEnforcement(options = {}) {
    const run = reconcileChain.then(() => reconcileTrafficEnforcementInternal(options));
    reconcileChain = run.catch(() => {});
    return run;
  }

  function getSiteTrafficMeta(websiteId) {
    const id = typeof websiteId === 'string' ? websiteId.trim().toLowerCase() : '';
    const vhost = id ? (appliedVhostsByWebsiteId.get(id) ?? null) : null;
    const trafficGuardReady = vhost?.trafficGuardReady === true;
    return Object.freeze({
      blocked: Boolean(id && appliedBlockedWebsiteIds.has(id) && trafficGuardReady),
      trafficGuardReady,
      accountingMode: vhost?.accountingMode ?? null,
      includesStaticAssets: typeof vhost?.includesStaticAssets === 'boolean' ? vhost.includesStaticAssets : null,
    });
  }

  async function resolveSiteTrafficMeta(websiteId) {
    if (!hasDiscovered) {
      try {
        await discoverAppliedVhosts();
      } catch {
        // Keep read-only fallback state if sitesDir is unavailable.
      }
    }
    return getSiteTrafficMeta(websiteId);
  }

  return Object.freeze({
    websiteRegistry,
    setEnforcer,
    discoverAppliedVhosts,
    reconcileTrafficEnforcement,
    getSiteTrafficMeta,
    resolveSiteTrafficMeta,
  });
}
