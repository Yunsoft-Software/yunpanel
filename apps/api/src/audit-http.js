import { AuditStoreError } from './audit-store.js';
import { AuthError } from './auth-error.js';

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

export function handleAuditRead({ request, response, query, store, json }) {
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    throw new AuthError('method_not_allowed', 'Use GET for audit history.', 405);
  }
  if (!store?.audit || typeof store.audit.list !== 'function') {
    throw new AuthError('audit_unavailable', 'Audit history is temporarily unavailable.', 503);
  }
  let page;
  try {
    page = store.audit.list(parseAuditQuery(query));
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof AuditStoreError && error.code.startsWith('invalid_audit_')) {
      throw new AuthError('invalid_audit_query', 'Audit filters are invalid.', 400);
    }
    throw error;
  }
  return json(response, 200, { data: page });
}
