import { MailAliasRegistryError } from './mail-alias-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const CREATE_FIELDS = new Set(['mailDomainId', 'source', 'destinations']);
const UPDATE_FIELDS = new Set(['expectedRevision', 'destinations', 'enabled']);
const DELETE_FIELDS = new Set(['expectedRevision', 'confirmation']);

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailAliasRegistryError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function listFilter(query) {
  if (Object.keys(query ?? {}).some((field) => field !== 'mailDomainId') || Array.isArray(query?.mailDomainId)) {
    throw new MailAliasRegistryError('mail_alias_query_invalid', 'Mail alias list accepts only one mailDomainId filter');
  }
  return { mailDomainId: query?.mailDomainId || null };
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailAliasRegistryError('mail_alias_query_invalid', 'Mail alias operation does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

const noHostSideEffects = Object.freeze({ mailConfigurationChanged: false, mailDataChanged: false });

export function mountMailAliasRoutes(app, {
  mailAliasRegistry, mailDomainRegistry = null, domainRegistry = null, localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || typeof app.patch !== 'function' || typeof app.delete !== 'function') {
    throw new Error('Express application is required');
  }
  if (!mailAliasRegistry || typeof mailAliasRegistry.createAlias !== 'function'
    || typeof mailAliasRegistry.listAliases !== 'function' || typeof mailAliasRegistry.getAlias !== 'function'
    || typeof mailAliasRegistry.updateAlias !== 'function' || typeof mailAliasRegistry.deleteAlias !== 'function') {
    throw new Error('Mail alias registry is required');
  }
  if (localServerId !== null && (!mailDomainRegistry || !domainRegistry)) {
    throw new Error('Local mail alias scope dependencies are required');
  }

  async function localMailDomain(mailDomainId) {
    const mailDomain = await mailDomainRegistry?.getMailDomain(mailDomainId);
    const domain = mailDomain?.webDomainId ? await domainRegistry?.getDomain(mailDomain.webDomainId) : null;
    if (localServerId !== null && domain?.serverId !== localServerId) {
      throw new MailAliasRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
    }
    return mailDomain;
  }

  async function localAlias(mailAliasId) {
    const alias = await mailAliasRegistry.getAlias(mailAliasId);
    if (!alias) throw new MailAliasRegistryError('mail_alias_not_found', 'Mail alias was not found', 404);
    await localMailDomain(alias.mailDomainId);
    return alias;
  }

  app.get('/api/mail-aliases', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const filter = listFilter(request.query);
    if (localServerId !== null && filter.mailDomainId) await localMailDomain(filter.mailDomainId);
    const aliases = await mailAliasRegistry.listAliases(filter);
    if (localServerId === null) return response.json({ data: aliases });
    const local = await Promise.all(aliases.map(async (alias) => {
      const mailDomain = await mailDomainRegistry.getMailDomain(alias.mailDomainId);
      const domain = mailDomain?.webDomainId ? await domainRegistry.getDomain(mailDomain.webDomainId) : null;
      return domain?.serverId === localServerId ? alias : null;
    }));
    return response.json({ data: local.filter(Boolean) });
  }));

  app.get('/api/mail-aliases/:mailAliasId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    return response.json({ data: await localAlias(request.params.mailAliasId) });
  }));

  app.post('/api/mail-aliases', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, CREATE_FIELDS, 'mail_alias_create_input_invalid');
    await localMailDomain(body.mailDomainId);
    const alias = await mailAliasRegistry.createAlias(body);
    return response.status(201).json({ data: alias, sideEffects: noHostSideEffects });
  }));

  app.patch('/api/mail-aliases/:mailAliasId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, UPDATE_FIELDS, 'mail_alias_update_input_invalid');
    await localAlias(request.params.mailAliasId);
    const alias = await mailAliasRegistry.updateAlias(request.params.mailAliasId, body);
    return response.json({ data: alias, sideEffects: noHostSideEffects });
  }));

  app.delete('/api/mail-aliases/:mailAliasId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, DELETE_FIELDS, 'mail_alias_delete_input_invalid');
    await localAlias(request.params.mailAliasId);
    await mailAliasRegistry.deleteAlias(request.params.mailAliasId, body);
    return response.json({
      data: { id: request.params.mailAliasId, deleted: true },
      sideEffects: noHostSideEffects,
    });
  }));
}

export const mailAliasHttpInternals = Object.freeze({ exactBody, listFilter, emptyQuery, noHostSideEffects });
