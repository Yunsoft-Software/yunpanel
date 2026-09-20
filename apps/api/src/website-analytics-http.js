import { createGoAccessManager, GoAccessManagerError } from '@yunpanel/host-runtime';
import { requirePanelRouteAccess } from './panel-http-guard.js';

export class WebsiteAnalyticsHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteAnalyticsHttpError';
    this.code = code;
    this.status = status;
  }
}

async function resolvePrimaryDomain(websiteId, domainRegistry) {
  if (!domainRegistry || typeof domainRegistry.listDomains !== 'function') return null;
  const domains = await domainRegistry.listDomains();
  const linked = domains.filter((d) => d.websiteId === websiteId);
  const primary = linked.find((d) => !d.parentId) ?? linked[0] ?? null;
  return primary ? primary.primaryDomain : null;
}

async function requireLocalWebsite(websiteRegistry, websiteId, localServerId) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new WebsiteAnalyticsHttpError('website_registry_unavailable', 'Website registry is unavailable', 503);
  }
  const website = await websiteRegistry.getWebsite(websiteId);
  if (!website) {
    throw new WebsiteAnalyticsHttpError('website_not_found', 'Website not found', 404);
  }
  if (localServerId && website.serverId !== localServerId) {
    throw new WebsiteAnalyticsHttpError('website_not_local', 'Website is not managed on this host', 409);
  }
  return website;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      if (error instanceof WebsiteAnalyticsHttpError) {
        return next(error);
      }
      if (error instanceof GoAccessManagerError) {
        return next(new WebsiteAnalyticsHttpError(error.code, error.message, 500));
      }
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      return next(new WebsiteAnalyticsHttpError(
        typeof error?.code === 'string' ? error.code : 'website_analytics_failed',
        error?.message ?? 'Website analytics operation failed',
        status,
      ));
    }
  };
}

export function mountWebsiteAnalyticsRoutes(app, {
  websiteRegistry,
  domainRegistry,
  goaccessManager = createGoAccessManager(),
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || !websiteRegistry) {
    throw new Error('Website analytics HTTP dependencies are required');
  }

  app.get('/api/websites/:websiteId/analytics/report', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const primaryDomain = await resolvePrimaryDomain(website.id, domainRegistry) ?? website.name;

    const result = await goaccessManager.generateStaticReport({
      websiteId: website.id,
      primaryDomain,
    });

    if (request.query.format === 'html') {
      const report = await goaccessManager.readReport({ websiteId: website.id });
      if (!report) {
        throw new WebsiteAnalyticsHttpError('report_not_found', 'Analytics report could not be generated', 500);
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
      return response.send(report.content);
    }

    return response.json({
      data: {
        websiteId: website.id,
        primaryDomain,
        outputPath: result.outputPath,
        generatedAt: result.generatedAt,
      },
    });
  }));

  app.get('/api/websites/:websiteId/analytics/status', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const status = await goaccessManager.inspectDaemon({ websiteId: website.id });
    return response.json({
      data: {
        ...status,
        wsUrl: `/tools/goaccess/${website.id}/ws`,
      },
    });
  }));

  app.post('/api/websites/:websiteId/analytics/realtime/start', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const primaryDomain = await resolvePrimaryDomain(website.id, domainRegistry) ?? website.name;

    const result = await goaccessManager.startRealtimeDaemon({
      websiteId: website.id,
      primaryDomain,
    });

    return response.json({ data: result });
  }));

  app.post('/api/websites/:websiteId/analytics/realtime/stop', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const result = await goaccessManager.stopRealtimeDaemon({ websiteId: website.id });
    return response.json({ data: result });
  }));

  app.post('/api/websites/:websiteId/analytics/realtime/restart', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const primaryDomain = await resolvePrimaryDomain(website.id, domainRegistry) ?? website.name;

    const result = await goaccessManager.restartRealtimeDaemon({
      websiteId: website.id,
      primaryDomain,
    });

    return response.json({ data: result });
  }));
}
