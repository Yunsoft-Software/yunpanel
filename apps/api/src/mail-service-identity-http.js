import { ensureMailConfigurationIdle } from './mail-configuration-http.js';
import { MailServiceIdentityRegistryError } from './mail-service-identity-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const BIND_FIELDS = new Set(['expectedRevision', 'webDomainId']);
const CLEAR_FIELDS = new Set(['expectedRevision', 'confirmation']);

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailServiceIdentityRegistryError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailServiceIdentityRegistryError(
      'mail_service_identity_query_invalid',
      'Mail service identity operation does not accept query parameters',
    );
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function requireLocalServerId(localServerId) {
  if (typeof localServerId !== 'string' || !localServerId) {
    throw new MailServiceIdentityRegistryError(
      'mail_service_identity_local_server_unavailable',
      'Mail service identity requires the configured local server',
      503,
    );
  }
  return localServerId;
}

async function ensureNoEnabledLocalMailDomains({ mailDomainRegistry, domainRegistry, serverId }) {
  const domains = await mailDomainRegistry.listMailDomains();
  for (const mailDomain of domains) {
    if (mailDomain.managementMode !== 'local' || mailDomain.status !== 'enabled' || !mailDomain.webDomainId) continue;
    const webDomain = await domainRegistry.getDomain(mailDomain.webDomainId);
    if (webDomain?.serverId === serverId) {
      throw new MailServiceIdentityRegistryError(
        'mail_service_identity_in_use',
        'Disable and apply all local mail domains before clearing the mail service identity',
        409,
      );
    }
  }
}

const bindSideEffects = Object.freeze({
  mailConfigurationChanged: false,
  mailDataChanged: false,
  requiresConfigurationApply: true,
});
const clearSideEffects = Object.freeze({
  mailConfigurationChanged: false,
  mailDataChanged: false,
  requiresConfigurationApply: false,
});

export function mountMailServiceIdentityRoutes(app, {
  mailServiceIdentityRegistry,
  mailDomainRegistry,
  domainRegistry,
  jobRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.put !== 'function' || typeof app.delete !== 'function') {
    throw new Error('Express application is required');
  }
  if (!mailServiceIdentityRegistry || typeof mailServiceIdentityRegistry.getForServer !== 'function'
    || typeof mailServiceIdentityRegistry.bind !== 'function'
    || typeof mailServiceIdentityRegistry.clear !== 'function') {
    throw new Error('Mail service identity registry is required');
  }
  if (!mailDomainRegistry || typeof mailDomainRegistry.listMailDomains !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function') {
    throw new Error('Mail service identity scope dependencies are required');
  }

  app.get('/api/mail-service-identity', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const serverId = requireLocalServerId(localServerId);
    return response.json({ data: await mailServiceIdentityRegistry.getForServer(serverId) });
  }));

  app.put('/api/mail-service-identity', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const serverId = requireLocalServerId(localServerId);
    const body = exactBody(request.body, BIND_FIELDS, 'mail_service_identity_bind_input_invalid');
    await ensureMailConfigurationIdle(jobRegistry, serverId);
    const identity = await mailServiceIdentityRegistry.bind({
      serverId,
      webDomainId: body.webDomainId,
      expectedRevision: body.expectedRevision,
    });
    return response.json({ data: identity, sideEffects: bindSideEffects });
  }));

  app.delete('/api/mail-service-identity', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const serverId = requireLocalServerId(localServerId);
    const body = exactBody(request.body, CLEAR_FIELDS, 'mail_service_identity_clear_input_invalid');
    await ensureMailConfigurationIdle(jobRegistry, serverId);
    await ensureNoEnabledLocalMailDomains({ mailDomainRegistry, domainRegistry, serverId });
    const result = await mailServiceIdentityRegistry.clear(serverId, body);
    return response.json({ data: result, sideEffects: clearSideEffects });
  }));
}

export const mailServiceIdentityHttpInternals = Object.freeze({
  exactBody,
  emptyQuery,
  requireLocalServerId,
  ensureNoEnabledLocalMailDomains,
  bindSideEffects,
  clearSideEffects,
});