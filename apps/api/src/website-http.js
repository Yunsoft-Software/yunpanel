import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteRegistryError } from './website-registry.js';

const CREATE_FIELDS = new Set(['serverId', 'name', 'applicationId', 'runtimeType']);

function assertCreateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !CREATE_FIELDS.has(key))) {
    throw new WebsiteRegistryError('invalid_website_input', 'Send only documented Website fields');
  }
  return body;
}

function listFilter(query) {
  const keys = Object.keys(query ?? {});
  if (keys.some((key) => key !== 'serverId') || Array.isArray(query?.serverId)) {
    throw new WebsiteRegistryError('invalid_website_query', 'Website list accepts only one serverId filter');
  }
  return { serverId: query?.serverId || null };
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountWebsiteRoutes(app, { websiteRegistry, domainRegistry } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!websiteRegistry || typeof websiteRegistry.listWebsites !== 'function'
    || typeof websiteRegistry.getWebsite !== 'function' || typeof websiteRegistry.createWebsite !== 'function') {
    throw new Error('Website registry is required');
  }
  if (!domainRegistry || typeof domainRegistry.listDomains !== 'function') throw new Error('Domain registry is required for Website relationships');

  app.get('/api/websites', requirePanelRouteAccess, asyncRoute(async (request, response) => (
    response.json({ data: await websiteRegistry.listWebsites(listFilter(request.query)) })
  )));

  app.get('/api/websites/:websiteId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await websiteRegistry.getWebsite(request.params.websiteId);
    if (!website) throw new WebsiteRegistryError('website_not_found', 'Website not found', 404);
    return response.json({ data: website });
  }));

  app.get('/api/websites/:websiteId/domains', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await websiteRegistry.getWebsite(request.params.websiteId);
    if (!website) throw new WebsiteRegistryError('website_not_found', 'Website not found', 404);
    const domains = (await domainRegistry.listDomains()).filter((domain) => domain.websiteId === website.id);
    return response.json({ data: domains });
  }));

  app.post('/api/websites', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = assertCreateBody(request.body);
    const website = await websiteRegistry.createWebsite({
      serverId: body.serverId,
      name: body.name,
      applicationId: body.applicationId ?? null,
      runtimeType: body.runtimeType ?? null,
    });
    return response.status(201).json({ data: website });
  }));
}

export const websiteHttpInternals = Object.freeze({ assertCreateBody, listFilter });
