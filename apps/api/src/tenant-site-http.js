import { automationKey, requireAutomationKey } from './automation-http.js';

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountTenantSiteRoutes(app, { service } = {}) {
  if (!app || !service) throw new Error('Tenant site routes require the tenant site service');
  app.put('/api/automation/tenant-sites/:slug', requireAutomationKey, asyncRoute(async (request, response) => {
    const { created, site } = await service.ensure(automationKey(request), request.params.slug, request.body);
    return response.status(created || site.state !== 'active' ? 202 : 200).json({ data: site });
  }));
  app.post('/api/automation/tenant-sites/:slug/state', requireAutomationKey, asyncRoute(async (request, response) => {
    const site = await service.setMode(automationKey(request), request.params.slug, request.body);
    return response.status(site.state === 'active' ? 200 : 202).json({ data: site });
  }));
  app.get('/api/automation/tenant-sites/:slug', requireAutomationKey, asyncRoute(async (request, response) => {
    return response.json({ data: await service.status(automationKey(request), request.params.slug) });
  }));
  // Machine clients get stable codes; internal details stay in the server log.
  app.use('/api/automation', (error, _request, response, next) => {
    if (response.headersSent) return next(error);
    const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : null;
    if (status === null) {
      console.error('automation request failed', error);
      return response.status(500).json({ error: { code: 'automation_failed', message: 'The operation failed.' } });
    }
    return response.status(status).json({ error: { code: typeof error.code === 'string' ? error.code : 'invalid_request', message: error.message } });
  });
}
