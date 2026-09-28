import { requirePanelRouteAccess } from './panel-http-guard.js';
import { SiteHealthError } from './site-health-service.js';

export class SiteHealthHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SiteHealthHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      if (error instanceof SiteHealthError) {
        return response.status(error.status).json({
          error: { code: error.code, message: error.message },
        });
      }
      return next(error);
    }
  };
}

function requireManagementRole(request, response, next) {
  const role = request.auth?.user?.role;
  if (!role || role === 'read_only') {
    return response.status(403).json({
      error: { code: 'forbidden', message: 'Management permissions required for repair operations.' },
    });
  }
  return next();
}

export function mountSiteHealthRoutes(app, {
  siteHealthService,
  websiteRegistry,
  domainRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || !siteHealthService) {
    throw new TypeError('Site health HTTP dependencies are required');
  }

  // GET /api/websites/:websiteId/health
  app.get('/api/websites/:websiteId/health', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const websiteId = request.params.websiteId;
    const report = await siteHealthService.inspectSiteHealth({ websiteId });
    return response.json({ data: report });
  }));

  // POST /api/websites/:websiteId/health/repair
  app.post('/api/websites/:websiteId/health/repair', requireManagementRole, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const websiteId = request.params.websiteId;
    const { action, layer, options } = request.body ?? {};

    if (!action) {
      throw new SiteHealthError('repair_action_required', 'Repair action is required in request body', 400);
    }

    const result = await siteHealthService.repairSiteHealth({
      websiteId,
      layer,
      action,
      options,
    });

    return response.json({ data: result });
  }));

  // GET /api/domains/:domainId/health
  app.get('/api/domains/:domainId/health', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const domainId = request.params.domainId;
    const report = await siteHealthService.inspectSiteHealth({ domainId });
    return response.json({ data: report });
  }));

  // POST /api/domains/:domainId/health/repair
  app.post('/api/domains/:domainId/health/repair', requireManagementRole, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const domainId = request.params.domainId;
    const { action, layer, options } = request.body ?? {};

    if (!action) {
      throw new SiteHealthError('repair_action_required', 'Repair action is required in request body', 400);
    }

    const result = await siteHealthService.repairSiteHealth({
      domainId,
      layer,
      action,
      options,
    });

    return response.json({ data: result });
  }));
}

export const siteHealthHttpInternals = Object.freeze({
  requireManagementRole,
  asyncRoute,
});
