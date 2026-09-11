import { AuthError } from './auth-error.js';

export const READ_ONLY_PERMISSIONS = Object.freeze([
  'servers.read',
  'websites.read',
  'applications.read',
  'domains.read',
  'certificates.read',
  'dns_zones.read',
  'mail_domains.read',
  'docker_workloads.read',
]);

const READ_ONLY_RULES = Object.freeze([
  ['servers.read', /^\/api\/servers(?:\/[^/%]+)?$/],
  ['websites.read', /^\/api\/websites(?:\/[^/%]+(?:\/domains)?)?$/],
  ['applications.read', /^\/api\/applications(?:\/[^/%]+)?$/],
  ['domains.read', /^\/api\/domains(?:\/[^/%]+)?$/],
  ['certificates.read', /^\/api\/certificates(?:\/[^/%]+)?$/],
  ['dns_zones.read', /^\/api\/dns-zones(?:\/[^/%]+)?$/],
  ['mail_domains.read', /^\/api\/mail-domains(?:\/[^/%]+)?$/],
  ['docker_workloads.read', /^\/api\/docker\/workloads(?:\/[^/%]+)?$/],
]);

export function describePanelAccess(session) {
  if (!session) return null;
  const management = session.user?.role === 'owner' && session.security?.managementAllowed === true;
  const readOnly = session.user?.role === 'read_only';
  return {
    ...session,
    access: {
      mode: management ? 'management' : readOnly ? 'read_only' : 'self_service',
      permissions: management ? ['*'] : readOnly ? [...READ_ONLY_PERMISSIONS] : [],
    },
  };
}

export function readOnlyPermission(method, pathname) {
  if (!['GET', 'HEAD'].includes(method) || typeof pathname !== 'string') return null;
  return READ_ONLY_RULES.find(([, pattern]) => pattern.test(pathname))?.[0] ?? null;
}

export function requireReadOnlyRequest(session, method, pathname) {
  const current = describePanelAccess(session);
  if (!current) throw new AuthError('unauthorized', 'Sign in to continue.', 401);
  if (current.user?.role !== 'read_only') throw new AuthError('forbidden', 'Read-only access is not available for this account.', 403);
  if (!readOnlyPermission(method, pathname)) {
    throw new AuthError('forbidden', 'This read-only account cannot access that panel operation.', 403);
  }
  return current;
}
