import { AuthError } from './auth-error.js';

const ALLOWED_QUERY_KEYS = new Set(['limit', 'offset', 'actorId', 'resourceType', 'resourceId']);

function one(query, key) {
  if (!query.has(key)) return null;
  const values = query.getAll(key);
  if (values.length !== 1) throw new AuthError('invalid_audit_query', 'Use one value for each audit filter.');
  return values[0];
}

function parsePagination(value, fallback, field) {
  if (value == null) return fallback;
  if (!/^\d+$/.test(value)) throw new AuthError('invalid_audit_query', `Audit ${field} must be numeric.`);
  return Number(value);
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
  return {
    limit: parsePagination(one(query, 'limit'), 50, 'limit'),
    offset: parsePagination(one(query, 'offset'), 0, 'offset'),
    actorId: one(query, 'actorId'),
    resourceType,
    resourceId,
  };
}

export function handleAuditRead({ request, response, query, store, json }) {
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    throw new AuthError('method_not_allowed', 'Use GET for audit history.', 405);
  }
  if (!store?.audit || typeof store.audit.list !== 'function') {
    throw new AuthError('audit_unavailable', 'Audit history is temporarily unavailable.', 503);
  }
  return json(response, 200, { data: store.audit.list(parseAuditQuery(query)) });
}
