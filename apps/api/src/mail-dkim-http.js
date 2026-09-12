import { MailDkimRegistryError } from './mail-dkim-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const CREATE_FIELDS = new Set(['expectedRevision', 'selector']);

export class MailDkimHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDkimHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailDkimRegistryError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailDkimHttpError('mail_dkim_query_invalid', 'DKIM operation does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

const keyGenerationSideEffects = Object.freeze({
  mailConfigurationChanged: false,
  mailDataChanged: false,
  requiresDnsPublish: true,
  requiresConfigurationApply: true,
});

async function scopedLocalMailDomain({ mailDomainRegistry, domainRegistry, mailDomainId, localServerId }) {
  const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
  if (!mailDomain) throw new MailDkimRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
  if (mailDomain.managementMode !== 'local') {
    throw new MailDkimRegistryError('mail_domain_not_locally_managed', 'Mail domain is not locally managed', 409);
  }
  if (!mailDomain.webDomainId) {
    throw new MailDkimHttpError(
      'mail_domain_server_unavailable',
      'Mail domain is not bound to a local web domain',
      409,
    );
  }
  const webDomain = await domainRegistry.getDomain(mailDomain.webDomainId);
  if (!webDomain || webDomain.primaryDomain !== mailDomain.domainName
    || (localServerId !== null && webDomain.serverId !== localServerId)) {
    throw new MailDkimRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
  }
  return mailDomain;
}

export function mountMailDkimRoutes(app, {
  mailDkimRegistry,
  mailDomainRegistry,
  domainRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || typeof mailDkimRegistry.createKey !== 'function') {
    throw new Error('DKIM key registry is required');
  }
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function') {
    throw new Error('DKIM scope dependencies are required');
  }

  app.get('/api/mail-domains/:mailDomainId/dkim', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    return response.json({ data: await mailDkimRegistry.getKey(request.params.mailDomainId) });
  }));

  app.post('/api/mail-domains/:mailDomainId/dkim', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, CREATE_FIELDS, 'mail_dkim_create_input_invalid');
    await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const key = await mailDkimRegistry.createKey(request.params.mailDomainId, body);
    return response.status(201).json({ data: key, sideEffects: keyGenerationSideEffects });
  }));
}

export const mailDkimHttpInternals = Object.freeze({
  exactBody,
  emptyQuery,
  scopedLocalMailDomain,
  keyGenerationSideEffects,
});
