import { requirePanelRouteAccess } from './panel-http-guard.js';
import { previewWebsiteMigration } from './website-migration-preview.js';

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountWebsiteMigrationRoutes(app, {
  websiteRegistry,
  domainRegistry,
  applicationRegistry,
  preview = previewWebsiteMigration,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('Express application is required');
  if (!websiteRegistry || typeof websiteRegistry.listWebsites !== 'function') throw new Error('Website registry is required');
  if (!domainRegistry || typeof domainRegistry.listDomains !== 'function') throw new Error('Domain registry is required');
  if (!applicationRegistry || typeof applicationRegistry.listApplications !== 'function') throw new Error('Application registry is required');
  if (typeof preview !== 'function') throw new Error('Website migration preview is required');

  app.get('/api/websites/migration/preview', requirePanelRouteAccess, asyncRoute(async (_request, response) => {
    const [domains, websites, applications] = await Promise.all([
      domainRegistry.listDomains(),
      websiteRegistry.listWebsites(),
      applicationRegistry.listApplications(),
    ]);
    return response.json({ data: preview({ domains, websites, applications }) });
  }));
}
