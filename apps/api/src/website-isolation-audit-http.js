import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteIsolationAuditError } from './website-isolation-audit.js';
import { WebsiteRegistryError } from './website-registry.js';

function mappedAuditError(error) {
  if (error instanceof WebsiteIsolationAuditError) {
    return new WebsiteRegistryError(error.code, error.message, error.status);
  }
  return error;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(mappedAuditError(error)); }
  };
}

async function requireLocalWebsite(websiteRegistry, websiteId, localServerId) {
  const website = await websiteRegistry.getWebsite(websiteId);
  if (!website || (localServerId && website.serverId !== localServerId)) {
    throw new WebsiteRegistryError('website_not_found', 'Website not found', 404);
  }
  return website;
}

export function mountWebsiteIsolationAuditRoutes(app, {
  auditService,
  websiteRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('Express application is required');
  if (!auditService || typeof auditService.audit !== 'function') {
    throw new Error('Website isolation audit service is required');
  }
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new Error('Website registry is required for isolation audit scope');
  }

  app.get('/api/websites/:websiteId/isolation-audit', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const audit = await auditService.audit(website.id);
    return response.json({ data: audit });
  }));
}

export const websiteIsolationAuditHttpInternals = Object.freeze({
  mappedAuditError,
  requireLocalWebsite,
});
