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
  if (method === 'POST' && pathname === '/api/mail-domains') return { action: 'mail_domain.track', resourceType: 'mail_domain', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/mailboxes') return { action: 'mailbox.create', resourceType: 'mailbox', resourceId: 'new' };
  if ((parts = match(pathname, /^\/api\/mailboxes\/([^/]+)\/password$/)) && method === 'POST') return { action: 'mailbox.password.rotate', resourceType: 'mailbox', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/mailboxes\/([^/]+)$/)) && method === 'PATCH') return { action: 'mailbox.update', resourceType: 'mailbox', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/mailboxes\/([^/]+)$/)) && method === 'DELETE') return { action: 'mailbox.delete', resourceType: 'mailbox', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/mail-domains\/([^/]+)\/config-preview$/)) && method === 'POST') return { action: 'mail.configuration.preview', resourceType: 'mail_domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/mail-domains\/([^/]+)\/config-apply$/)) && method === 'POST') return { action: 'mail.configuration.apply', resourceType: 'mail_domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/mail-domains\/([^/]+)\/config-rollback-preview$/)) && method === 'POST') return { action: 'mail.configuration.rollback.preview', resourceType: 'mail_domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/mail-domains\/([^/]+)\/config-rollback$/)) && method === 'POST') return { action: 'mail.configuration.rollback', resourceType: 'mail_domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/mail-domains\/([^/]+)\/dkim\/local-dns-retirement-preview$/)) && method === 'POST') return { action: 'mail.dkim.local_dns_retirement.preview', resourceType: 'mail_domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/mail-domains\/([^/]+)\/dkim\/local-dns-retirement-apply$/)) && method === 'POST') return { action: 'mail.dkim.local_dns_retirement.apply', resourceType: 'mail_domain', resourceId: parts[0] };
  if (method === 'POST' && pathname === '/api/websites') return { action: 'website.create', resourceType: 'website', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/websites/migration/create-website') return { action: 'website.migration.create', resourceType: 'website_migration', resourceId: 'create' };
  if (method === 'POST' && pathname === '/api/websites/migration/bind') return { action: 'website.migration.bind', resourceType: 'website_migration', resourceId: 'bind' };
  if (method === 'POST' && pathname === '/api/websites/migration/rollback-binding') return { action: 'website.migration.rollback_binding', resourceType: 'website_migration', resourceId: 'binding' };
  if (method === 'POST' && pathname === '/api/websites/migration/finalize') return { action: 'website.migration.finalize', resourceType: 'website_migration', resourceId: 'policy' };
  if (method === 'POST' && pathname === '/api/websites/migration/rollback') return { action: 'website.migration.rollback', resourceType: 'website_migration', resourceId: 'policy' };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/update-preview$/)) && method === 'POST') return { action: 'website.update.preview', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/impact-preview$/)) && method === 'POST') return { action: 'website.impact.preview', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/backup\/preview$/)) && method === 'POST') return { action: 'website.backup.preview', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/backup$/)) && method === 'POST') return { action: 'website.backup', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/restore\/preview$/)) && method === 'POST') return { action: 'website.restore.preview', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/restore$/)) && method === 'POST') return { action: 'website.restore', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/sftp\/keys$/)) && method === 'POST') return { action: 'website.sftp_key.add', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/sftp\/keys\/[^/]+\/revoke$/)) && method === 'POST') return { action: 'website.sftp_key.revoke', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/sftp\/keys\/[^/]+\/rotate$/)) && method === 'POST') return { action: 'website.sftp_key.rotate', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)\/sftp\/keys\/reconcile$/)) && method === 'POST') return { action: 'website.sftp_key.reconcile', resourceType: 'website', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/websites\/([^/]+)$/)) && method === 'PATCH') return { action: 'website.update', resourceType: 'website', resourceId: parts[0] };
  if (method === 'POST' && pathname === '/api/backups/repositories') return { action: 'backup_repository.create', resourceType: 'backup_repository', resourceId: 'new' };
  if ((parts = match(pathname, /^\/api\/backups\/repositories\/([^/]+)\/init$/)) && method === 'POST') return { action: 'backup_repository.init', resourceType: 'backup_repository', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/backups\/repositories\/([^/]+)$/)) && method === 'DELETE') return { action: 'backup_repository.delete', resourceType: 'backup_repository', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/backups\/repositories\/([^/]+)\/check$/)) && method === 'POST') return { action: 'backup_repository.check', resourceType: 'backup_repository', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/backups\/repositories\/([^/]+)\/unlock$/)) && method === 'POST') return { action: 'backup_repository.unlock', resourceType: 'backup_repository', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/backups\/repositories\/([^/]+)\/prune$/)) && method === 'POST') return { action: 'backup_repository.prune', resourceType: 'backup_repository', resourceId: parts[0] };
  if (method === 'POST' && pathname === '/api/backups/remotes') return { action: 'backup_remote.create', resourceType: 'backup_remote', resourceId: 'new' };
  if ((parts = match(pathname, /^\/api\/backups\/remotes\/([^/]+)$/)) && method === 'PUT') return { action: 'backup_remote.update', resourceType: 'backup_remote', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/backups\/remotes\/([^/]+)$/)) && method === 'DELETE') return { action: 'backup_remote.delete', resourceType: 'backup_remote', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/backups\/remotes\/([^/]+)\/test$/)) && method === 'POST') return { action: 'backup_remote.test', resourceType: 'backup_remote', resourceId: parts[0] };
  if (method === 'POST' && pathname === '/api/applications') return { action: 'application.create', resourceType: 'application', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/terminal/capabilities') return { action: 'terminal.capability.issued', resourceType: 'terminal', resourceId: 'new' };
  if (method === 'POST' && pathname === '/api/domains') return { action: 'domain.create', resourceType: 'domain', resourceId: 'new' };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/deploy$/)) && method === 'POST') return { action: 'application.deploy', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/rollback$/)) && method === 'POST') return { action: 'application.rollback', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/restart$/)) && method === 'POST') return { action: 'application.restart', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/process$/)) && method === 'POST') return { action: 'application.process', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/status\/refresh$/)) && method === 'POST') return { action: 'application.status.refresh', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/configuration-preview$/)) && method === 'POST') return { action: 'application.configuration.preview', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/configuration$/)) && method === 'POST') return { action: 'application.configuration.update', resourceType: 'application', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/deployment-credential$/)) && ['PUT', 'DELETE'].includes(method)) {
    return { action: method === 'PUT' ? 'application.git_credential.updated' : 'application.git_credential.deleted', resourceType: 'application', resourceId: parts[0] };
  }
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/github-webhook$/)) && ['PUT', 'DELETE'].includes(method)) {
    return { action: method === 'PUT' ? 'application.github_webhook.updated' : 'application.github_webhook.deleted', resourceType: 'application', resourceId: parts[0] };
  }
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/environment\/import$/)) && method === 'POST') {
    return { action: 'application.environment.imported', resourceType: 'application', resourceId: parts[0] };
  }
  if ((parts = match(pathname, /^\/api\/applications\/([^/]+)\/environment\/[^/]+$/)) && ['PUT', 'DELETE'].includes(method)) {
    return { action: method === 'PUT' ? 'application.environment.updated' : 'application.environment.deleted', resourceType: 'application', resourceId: parts[0] };
  }
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/stage$/)) && method === 'POST') return { action: 'domain.stage', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/update-preview$/)) && method === 'POST') return { action: 'domain.update.preview', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)$/)) && method === 'PATCH') return { action: 'domain.update', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/reparent-preview$/)) && method === 'POST') return { action: 'domain.reparent.preview', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/impact-preview$/)) && method === 'POST') return { action: 'domain.impact.preview', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/reparent$/)) && method === 'POST') return { action: 'domain.reparent', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/activate$/)) && method === 'POST') return { action: 'domain.activate', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/dns\/dnssec\/preview$/)) && method === 'POST') return { action: 'dns.dnssec.preview', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/dns\/dnssec\/apply$/)) && method === 'POST') return { action: 'dns.dnssec.apply', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/dns\/dnssec\/rollover\/apply$/)) && method === 'POST') return { action: 'dns.dnssec.rollover.apply', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/dns\/dnssec\/rollover\/operations\/[^/]+\/continue$/)) && method === 'POST') return { action: 'dns.dnssec.rollover.continue', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/certificates\/custom-preview$/)) && method === 'POST') return { action: 'certificate.custom.preview', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/certificates\/custom$/)) && method === 'POST') return { action: 'certificate.custom.import', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/certificates\/([^/]+)\/select-preview$/)) && method === 'POST') return { action: 'certificate.select.preview', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/certificates\/([^/]+)\/select$/)) && method === 'POST') return { action: 'certificate.select', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/domains\/([^/]+)\/certificates\/issue$/)) && method === 'POST') return { action: 'certificate.issue', resourceType: 'domain', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/dns-zones\/([^/]+)\/provider-credential$/)) && method === 'PUT') return { action: 'dns.provider.configure', resourceType: 'dns_zone', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/dns-zones\/([^/]+)\/provider-credential$/)) && method === 'DELETE') return { action: 'dns.provider.delete', resourceType: 'dns_zone', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/dns-zones\/([^/]+)\/readiness\/refresh$/)) && method === 'POST') return { action: 'dns.readiness.refresh', resourceType: 'dns_zone', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/dns-zones\/([^/]+)\/records\/preview$/)) && method === 'POST') return { action: 'dns.record.preview', resourceType: 'dns_zone', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/dns-zones\/([^/]+)\/records\/apply$/)) && method === 'POST') return { action: 'dns.record.apply', resourceType: 'dns_zone', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/dns-zones\/([^/]+)\/requirements\/preview$/)) && method === 'POST') return { action: 'dns.requirements.preview', resourceType: 'dns_zone', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/dns-zones\/([^/]+)\/requirements\/apply$/)) && method === 'POST') return { action: 'dns.requirements.apply', resourceType: 'dns_zone', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/dns\/authoritative\/preview$/)) && method === 'POST') return { action: 'dns.authoritative.preview', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/dns\/authoritative\/apply$/)) && method === 'POST') return { action: 'dns.authoritative.apply', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/dns\/authoritative\/recovery\/resolve$/)) && method === 'POST') return { action: 'dns.authoritative.recovery.resolve', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/dns\/authoritative\/recovery\/retry$/)) && method === 'POST') return { action: 'dns.authoritative.recovery.retry', resourceType: 'server', resourceId: parts[0] };
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/dns\/authoritative\/rollback$/)) && method === 'POST') return { action: 'dns.authoritative.rollback', resourceType: 'server', resourceId: parts[0] };
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
  if ((parts = match(pathname, /^\/api\/servers\/([^/]+)\/databases\/([^/]+)\/backup$/)) && method === 'POST') return { action: 'database.backup', resourceType: 'database', resourceId: parts[1] };
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
