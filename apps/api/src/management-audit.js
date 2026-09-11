import { AuthError } from './auth-error.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function safeSegment(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f/%]/.test(value) ? value : null;
}

function match(pathname, pattern) {
  const result = pattern.exec(pathname);
  if (!result) return null;
  const parts = result.slice(1).map(safeSegment);
  return parts.some((part) => part === null) ? null : parts;
}

export function classifyManagementMutation(method, pathname) {
  if (!MUTATION_METHODS.has(method) || typeof pathname !== 'string') return null;
  let parts;

  if (method === 'POST' && pathname === '/api/sites/create-preview') return { action: 'site.create.preview', resourceType: 'site', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/sites') return { action: 'site.create', resourceType: 'site', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/dns-zones') return { action: 'dns_zone.external.track', resourceType: 'dns_zone', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/mail-domains') return { action: 'mail_domain.external.track', resourceType: 'mail_domain', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/websites') return { action: 'website.create', resourceType: 'website', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/websites/migration/create-website') return { action: 'website.migration.create', resourceType: 'website_migration', resourceId: 'create' };
  if (method === 'POST' && pathname === '/api/websites/migration/bind') return { action: 'website.migration.bind', resourceType: 'website_migration', resourceId: 'bind' };
  if (method === 'POST' && pathname === '/api/websites/migration/rollback-binding') return { action: 'website.migration.rollback_binding', resourceType: 'website_migration', resourceId: 'binding' };
  if (method === 'POST' && pathname === '/api/websites/migration/finalize') return { action: 'website.migration.finalize', resourceType: 'website_migration', resourceId: 'policy' };
  if (method === 'POST' && pathname === '/api/websites/migration/rollback') return { action: 'website.migration.rollback', resourceType: 'website_migration', resourceId: 'policy' };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/update-preview$/)) && method === 'POST') return { action: 'website.update.preview', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/impact-preview$/)) && method === 'POST') return { action: 'website.impact.preview', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)$/)) && method === 'PATCH') return { action: 'website.update', resourceType: 'website', resourceId: parts[0] };
  if (method === 'POST' && pathname === '/api/applications') return { action: 'application.create', resourceType: 'application', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/domains') return { action: 'domain.create', resourceType: 'domain', resourceId: 'new' };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/deploy$/)) && method === 'POST') return { action: 'application.deploy', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/rollback$/)) && method === 'POST') return { action: 'application.rollback', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/restart$/)) && method === 'POST') return { action: 'application.restart', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/process$/)) && method === 'POST') return { action: 'application.process', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/status\/refresh$/)) && method === 'POST') return { action: 'application.status.refresh', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/configuration-preview$/)) && method === 'POST') return { action: 'application.configuration.preview', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/configuration$/)) && method === 'POST') return { action: 'application.configuration.update', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/environment\/[^/]+$/)) && ['PUT', 'DELETE'].includes(method)) {
    return { action: method === 'PUT' ? 'application.environment.updated' : 'application.environment.deleted', resourceType: 'application', resourceId: parts[0] };
  }
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/stage$/)) && method === 'POST') return { action: 'domain.stage', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/reparent-preview$/)) && method === 'POST') return { action: 'domain.reparent.preview', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/impact-preview$/)) && method === 'POST') return { action: 'domain.impact.preview', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/reparent$/)) && method === 'POST') return { action: 'domain.reparent', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/activate$/)) && method === 'POST') return { action: 'domain.activate', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/certificates\/issue$/)) && method === 'POST') return { action: 'certificate.issue', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/certificates\/([^/]+)\/renew$/)) && method === 'POST') return { action: 'certificate.renew', resourceType: 'certificate', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/jobs\/([^/]+)\/cancel$/)) && method === 'POST') return { action: 'job.cancel', resourceType: 'job', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/system\/packages\/inspect$/)) && method === 'POST') return { action: 'system.packages.inspect', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/system\/upgrade$/)) && method === 'POST') return { action: 'system.upgrade', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/node-runtimes\/inspect$/)) && method === 'POST') return { action: 'node_runtime.inspect', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/node-runtimes\/([^/]+)\/install$/)) && method === 'POST') return { action: 'node_runtime.install', resourceType: 'server', resourceId: `${parts[0]}:${parts[1]}` };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/services\/inspect$/)) && method === 'POST') return { action: 'system.services.inspect', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/services\/([^/]+)\/install$/)) && method === 'POST') return { action: 'service.install', resourceType: 'service', resourceId: `${parts[0]}:${parts[1]}` };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/services\/([^/]+)\/control$/)) && method === 'POST') return { action: 'service.control', resourceType: 'service', resourceId: `${parts[0]}:${parts[1]}` };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/databases\/inspect$/)) && method === 'POST') return { action: 'database.inspect', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/databases$/)) && method === 'POST') return { action: 'database.create', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/databases\/([^/]+)$/)) && method === 'DELETE') return { action: 'database.delete', resourceType: 'database', resourceId: parts[1] };
  return null;
}

function outcomeForStatus(statusCode) {
  if (!Number.isInteger(statusCode)) return 'failed';
  if (statusCode === 202) return 'accepted';
  if (statusCode >= 200 && statusCode < 400) return 'succeeded';
  return statusCode === 401 || statusCode === 403 ? 'denied' : 'failed';
}

export function attachManagementAudit({ request, response, pathname, audit, onAuditError = () => {} } = {}) {
  const classification = classifyManagementMutation(request?.method, pathname);
  if (!classification) return null;
  const actorId = request?.auth?.user?.id;
  if (typeof actorId !== 'string' || !actorId) throw new AuthError('audit_actor_invalid', 'Management audit actor is unavailable.', 503);
  if (!audit || typeof audit.record !== 'function' || typeof onAuditError !== 'function'
    || !response || typeof response.once !== 'function') {
    throw new AuthError('audit_unavailable', 'Management audit is temporarily unavailable.', 503);
  }

  try {
    audit.record({ actorId, ...classification, outcome: 'accepted' });
  } catch {
    throw new AuthError('audit_unavailable', 'Management audit is temporarily unavailable.', 503);
  }

  response.once('finish', () => {
    const outcome = outcomeForStatus(response.statusCode);
    if (outcome === 'accepted') return;
    try {
      audit.record({
        actorId,
        ...classification,
        outcome,
        code: outcome === 'succeeded' ? null : `http_${response.statusCode}`,
      });
    } catch {
      try { onAuditError({ action: classification.action, resourceType: classification.resourceType, outcome }); } catch {}
    }
  });
  return Object.freeze({ actorId, ...classification });
}

export const managementAuditInternals = Object.freeze({
  mutationMethods: Object.freeze([...MUTATION_METHODS]),
  safeSegment,
  outcomeForStatus,
});
