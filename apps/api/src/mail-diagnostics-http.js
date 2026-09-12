import { requirePanelRouteAccess } from './panel-http-guard.js';

export class MailDiagnosticsHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDiagnosticsHttpError';
    this.code = code;
    this.status = status;
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailDiagnosticsHttpError(
      'mail_diagnostics_query_invalid',
      'Mail diagnostics does not accept query parameters',
    );
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

async function scopedLocalMailDomain({ mailDomainRegistry, domainRegistry, mailDomainId, localServerId }) {
  const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
  if (!mailDomain) throw new MailDiagnosticsHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
  if (mailDomain.managementMode !== 'local') {
    throw new MailDiagnosticsHttpError(
      'mail_diagnostics_local_domain_required',
      'Mail diagnostics requires a locally managed mail domain',
      409,
    );
  }
  if (!mailDomain.webDomainId) {
    throw new MailDiagnosticsHttpError(
      'mail_domain_server_unavailable',
      'Mail domain is not bound to a local web domain',
      409,
    );
  }
  const domain = await domainRegistry.getDomain(mailDomain.webDomainId);
  if (!domain || domain.primaryDomain !== mailDomain.domainName
    || (localServerId !== null && domain.serverId !== localServerId)) {
    throw new MailDiagnosticsHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
  }
  return Object.freeze({ mailDomain, domain });
}

export function mountMailDiagnosticsRoutes(app, {
  mailDiagnosticsInspector,
  mailDkimRegistry,
  mailDomainRegistry,
  domainRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('Express application is required');
  if (!mailDiagnosticsInspector || typeof mailDiagnosticsInspector.inspect !== 'function') {
    throw new Error('Mail diagnostics inspector is required');
  }
  if (!mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function') {
    throw new Error('Managed DKIM registry is required');
  }
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function') {
    throw new Error('Mail diagnostics scope dependencies are required');
  }

  app.get('/api/mail-domains/:mailDomainId/diagnostics', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const { mailDomain } = await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const dkim = await mailDkimRegistry.getKey(mailDomain.id);
    return response.json({
      data: await mailDiagnosticsInspector.inspect(mailDomain.domainName, { dkim }),
    });
  }));
}

export const mailDiagnosticsHttpInternals = Object.freeze({
  emptyQuery,
  scopedLocalMailDomain,
});
