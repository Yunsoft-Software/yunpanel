import { AuditStoreError } from './audit-store.js';
import { AuthError } from './auth-error.js';
import { extractActorTenant } from './tenant-boundary.js';

const ALLOWED_QUERY_KEYS = new Set(['limit', 'offset', 'actorId', 'resourceType', 'resourceId', 'action', 'outcome', 'from', 'to']);

function one(query, key) {
  if (!query.has(key)) return null;
  const values = query.getAll(key);
  if (values.length !== 1) throw new AuthError('invalid_audit_query', 'Use one value for each audit filter.');
  return values[0];
}

function parseInteger(value, fallback, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return fallback;
  if (!/^\d+$/.test(value)) throw new AuthError('invalid_audit_query', `Audit ${field} must be numeric.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AuthError('invalid_audit_query', `Audit ${field} is outside the allowed range.`);
  }
  return parsed;
}

export function parseAuditQuery(query) {
  for (const key of query.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw new AuthError('invalid_audit_query', 'Unsupported audit filter.', 400);
  }
  const resourceType = one(query, 'resourceType');
  const resourceId = one(query, 'resourceId');
  if ((resourceType == null) !== (resourceId == null)) {
    throw new AuthError('invalid_audit_query', 'Audit resourceType and resourceId must be supplied together.', 400);
  }
  const from = parseInteger(one(query, 'from'), null, 'from');
  const to = parseInteger(one(query, 'to'), null, 'to');
  if (from != null && to != null && from > to) {
    throw new AuthError('invalid_audit_query', 'Audit time range is invalid.', 400);
  }
  return {
    limit: parseInteger(one(query, 'limit'), 50, 'limit', { minimum: 1, maximum: 100 }),
    offset: parseInteger(one(query, 'offset'), 0, 'offset'),
    actorId: one(query, 'actorId'),
    resourceType,
    resourceId,
    action: one(query, 'action'),
    outcome: one(query, 'outcome'),
    from,
    to,
  };
}

function resolveHostingAccounts(store) {
  if (!store) return null;
  if (typeof store.listChildCustomerIds === 'function') return store;
  return store.hostingAccounts ?? store.users?.hostingAccounts ?? store.hostingAccountStore ?? store.hosting ?? null;
}

export function handleAuditRead({ request, response, query, store, json }) {
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    throw new AuthError('method_not_allowed', 'Use GET for audit history.', 405);
  }
  if (!store?.audit || typeof store.audit.list !== 'function') {
    throw new AuthError('audit_unavailable', 'Audit history is temporarily unavailable.', 503);
  }
  const auth = request.auth;
  let actorTenant = null;
  if (auth?.user) {
    actorTenant = extractActorTenant(auth);
    if (!actorTenant.isGlobal) {
      if (!actorTenant.active) {
        throw new AuthError('tenant_actor_inactive', 'Inactive account cannot access audit history.', 403);
      }
      if (actorTenant.isLegacySiteManager) {
        throw new AuthError('forbidden', 'Site manager cannot access global audit history.', 403);
      }
    }
  }

  const parsedQuery = parseAuditQuery(query);

  if (actorTenant && !actorTenant.isGlobal) {
    if (parsedQuery.actorId) {
      if (actorTenant.isCustomer && parsedQuery.actorId !== actorTenant.actorId) {
        throw new AuthError('tenant_boundary_forbidden', 'Cannot query audit history for foreign actor.', 403);
      }
      if (actorTenant.isReseller && parsedQuery.actorId !== actorTenant.actorId) {
        const hosting = resolveHostingAccounts(store);
        const childIds = (hosting && typeof hosting.listChildCustomerIds === 'function')
          ? hosting.listChildCustomerIds(actorTenant.actorId)
          : [];
        if (!childIds.includes(parsedQuery.actorId)) {
          throw new AuthError('tenant_boundary_forbidden', 'Cannot query audit history for foreign actor.', 403);
        }
      }
    }
    if (parsedQuery.resourceType && parsedQuery.resourceId) {
      if (parsedQuery.resourceType === 'website') {
        if (!actorTenant.websiteIds.includes(parsedQuery.resourceId)) {
          throw new AuthError('tenant_boundary_forbidden', 'Cannot query audit history for foreign website.', 403);
        }
      } else if (parsedQuery.resourceType === 'customer') {
        if (actorTenant.isCustomer && parsedQuery.resourceId !== actorTenant.actorId) {
          throw new AuthError('tenant_boundary_forbidden', 'Cannot query audit history for foreign customer.', 403);
        }
        if (actorTenant.isReseller) {
          const hosting = resolveHostingAccounts(store);
          const childIds = (hosting && typeof hosting.listChildCustomerIds === 'function')
            ? hosting.listChildCustomerIds(actorTenant.actorId)
            : [];
          if (!childIds.includes(parsedQuery.resourceId)) {
            throw new AuthError('tenant_boundary_forbidden', 'Cannot query audit history for foreign customer.', 403);
          }
        }
      } else if (!['domain', 'mailbox', 'database', 'application'].includes(parsedQuery.resourceType)) {
        throw new AuthError('tenant_boundary_forbidden', `Cannot query audit history for ${parsedQuery.resourceType}.`, 403);
      }
    }
  }

  let page;
  try {
    page = store.audit.list(parsedQuery);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof AuditStoreError && error.code.startsWith('invalid_audit_')) {
      throw new AuthError('invalid_audit_query', 'Audit filters are invalid.', 400);
    }
    throw error;
  }

  if (actorTenant && !actorTenant.isGlobal) {
    const listKey = Array.isArray(page?.events) ? 'events' : Array.isArray(page?.items) ? 'items' : null;
    if (listKey) {
      const hosting = resolveHostingAccounts(store);
      const childIds = (actorTenant.isReseller && hosting && typeof hosting.listChildCustomerIds === 'function')
        ? hosting.listChildCustomerIds(actorTenant.actorId)
        : [];
      const filtered = page[listKey].filter((item) => {
        if (item.actorId === actorTenant.actorId) return true;
        if (actorTenant.isReseller) {
          if (childIds.includes(item.actorId)) return true;
          if (item.resourceType === 'website' && actorTenant.websiteIds.includes(item.resourceId)) return true;
          if (item.resourceType === 'customer' && childIds.includes(item.resourceId)) return true;
        }
        if (actorTenant.isCustomer) {
          if (item.resourceType === 'website' && actorTenant.websiteIds.includes(item.resourceId)) return true;
        }
        return false;
      });
      page = {
        ...page,
        [listKey]: filtered,
        total: filtered.length,
      };
    }
  }

  return json(response, 200, { data: page });
}
