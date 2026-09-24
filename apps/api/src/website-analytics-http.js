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
  const primary = linked.find((d) => !d.parentDomainId) ?? linked[0] ?? null;
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

function analyticsStatusView(status, tool, websiteId, { owner = false } = {}) {
  if (!status || typeof status !== 'object' || Array.isArray(status)
    || status.websiteId !== websiteId || typeof status.running !== 'boolean'
    || typeof status.socketExists !== 'boolean'
    || !tool || typeof tool !== 'object' || Array.isArray(tool)
    || typeof tool.satisfied !== 'boolean'
    || (tool.version !== null && (typeof tool.version !== 'string' || tool.version.length > 40))) {
    throw new WebsiteAnalyticsHttpError('analytics_status_invalid', 'Analytics status could not be verified', 503);
  }
  return Object.freeze({
    websiteId,
    available: tool.satisfied,
    version: tool.version ?? null,
    running: status.running,
    socketReady: status.socketExists,
    ...(owner ? { wsUrl: '/tools/goaccess/' + websiteId + '/ws' } : {}),
  });
}

function realtimeView(value, websiteId, action) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.websiteId !== websiteId) {
    throw new WebsiteAnalyticsHttpError('analytics_realtime_result_invalid', 'Analytics realtime result could not be verified', 503);
  }
  if (action === 'stop') return Object.freeze({ websiteId, running: false, stopped: value.stopped === true });
  if (value.running !== true) {
    throw new WebsiteAnalyticsHttpError('analytics_realtime_result_invalid', 'Analytics realtime daemon did not confirm running state', 503);
  }
  return Object.freeze({
    websiteId,
    running: true,
    alreadyRunning: value.alreadyRunning === true,
  });
}

function requireAnalyticsOwner(request, response, next) {
  return requirePanelRouteAccess(request, response, () => {
    if (request.auth?.user?.role !== 'owner') {
      return response.status(403).json({ error: { code: 'forbidden', message: 'Owner access is required.' } });
    }
    return next();
  });
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
        const message = ({
          report_generation_failed: 'Analytics report could not be generated',
          report_read_failed: 'Analytics report could not be read',
          daemon_start_failed: 'Realtime analytics service could not be started',
          daemon_verify_failed: 'Realtime analytics service could not be verified',
          invalid_id: 'Analytics Website identity is invalid',
          invalid_path: 'Analytics path configuration is invalid',
        })[error.code] ?? 'Website analytics operation failed';
        return next(new WebsiteAnalyticsHttpError(error.code, message, 500));
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
        generatedAt: result.generatedAt,
      },
    });
  }));

  app.get('/api/websites/:websiteId/analytics/status', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const [status, tool] = await Promise.all([
      goaccessManager.inspectDaemon({ websiteId: website.id }),
      goaccessManager.inspectGoAccess(),
    ]);
    return response.json({ data: analyticsStatusView(status, tool, website.id, { owner: request.auth?.user?.role === 'owner' }) });
  }));

  app.post('/api/websites/:websiteId/analytics/realtime/start', requireAnalyticsOwner, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const primaryDomain = await resolvePrimaryDomain(website.id, domainRegistry) ?? website.name;

    const result = await goaccessManager.startRealtimeDaemon({
      websiteId: website.id,
      primaryDomain,
    });

    return response.json({ data: realtimeView(result, website.id, 'start') });
  }));

  app.post('/api/websites/:websiteId/analytics/realtime/stop', requireAnalyticsOwner, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const result = await goaccessManager.stopRealtimeDaemon({ websiteId: website.id });
    return response.json({ data: realtimeView(result, website.id, 'stop') });
  }));

  app.post('/api/websites/:websiteId/analytics/realtime/restart', requireAnalyticsOwner, asyncRoute(async (request, response) => {
    const website = await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId);
    const primaryDomain = await resolvePrimaryDomain(website.id, domainRegistry) ?? website.name;

    const result = await goaccessManager.restartRealtimeDaemon({
      websiteId: website.id,
      primaryDomain,
    });

    return response.json({ data: realtimeView(result, website.id, 'restart') });
  }));
}


export const websiteAnalyticsHttpInternals = Object.freeze({
  analyticsStatusView,
  realtimeView,
});
