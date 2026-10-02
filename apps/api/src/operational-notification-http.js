import { requirePanelRouteAccess } from './panel-http-guard.js';
import { OperationalNotificationError } from './operational-notification-service.js';

export class OperationalNotificationHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'OperationalNotificationHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      if (error instanceof OperationalNotificationError) {
        return response.status(error.status).json({
          error: { code: error.code, message: error.message },
        });
      }
      return next(error);
    }
  };
}

function requireOwnerOrManagement(request, response, next) {
  const role = request.auth?.user?.role;
  if (role !== 'owner') {
    return response.status(403).json({
      error: { code: 'forbidden', message: 'Owner or management permissions required for operational check sweeps.' },
    });
  }
  return next();
}

export function mountOperationalNotificationRoutes(app, {
  notificationService,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.patch !== 'function') {
    throw new TypeError('Express application is required');
  }
  if (!notificationService || typeof notificationService.dispatch !== 'function') {
    throw new TypeError('Operational notification service is required');
  }

  // GET /api/notifications/preferences
  app.get('/api/notifications/preferences', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const actorId = request.auth?.user?.id || 'global';
    const preferences = notificationService.getPreferences(actorId);
    return response.json({ data: preferences });
  }));

  // PATCH /api/notifications/preferences
  app.patch('/api/notifications/preferences', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const actorId = request.auth?.user?.id || 'global';
    const updated = notificationService.updatePreferences(actorId, request.body ?? {});
    return response.json({ data: updated });
  }));

  // GET /api/notifications/history (and /api/notifications/deliveries)
  const historyHandler = asyncRoute(async (request, response) => {
    const actor = request.auth;
    const url = new URL(request.originalUrl ?? request.url, 'http://yunpanel.internal');
    const filter = {
      eventType: url.searchParams.get('eventType') || undefined,
      severity: url.searchParams.get('severity') || undefined,
      channel: url.searchParams.get('channel') || undefined,
      status: url.searchParams.get('status') || undefined,
      websiteId: url.searchParams.get('websiteId') || undefined,
    };
    const limit = url.searchParams.get('limit') || 100;
    const history = notificationService.getDeliveryHistory({ actor, filter, limit });
    return response.json({ data: history });
  });

  app.get('/api/notifications/history', requirePanelRouteAccess, historyHandler);
  app.get('/api/notifications/deliveries', requirePanelRouteAccess, historyHandler);

  // POST /api/notifications/test
  app.post('/api/notifications/test', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const actor = request.auth;
    const { channel = 'email', target = null, message = null } = request.body ?? {};

    const result = await notificationService.dispatchTestNotification({
      actor,
      channel,
      target,
      message,
    });

    const statusCode = result.delivered ? 200 : 502;
    return response.status(statusCode).json({ data: result });
  }));

  // POST /api/notifications/check
  app.post('/api/notifications/check', requirePanelRouteAccess, requireOwnerOrManagement, asyncRoute(async (request, response) => {
    const { disks = null, now = undefined } = request.body ?? {};

    const [sslResults, diskResults] = await Promise.all([
      notificationService.checkCertificateExpirations({ now }),
      disks ? notificationService.checkDiskAndInodeThresholds({ disks, now }) : Promise.resolve({ checked: 0, dispatched: [] }),
    ]);

    return response.json({
      data: {
        checked: {
          certificates: sslResults.checked,
          disks: diskResults.checked,
        },
        dispatchedAlertsCount: sslResults.dispatched.length + diskResults.dispatched.length,
        ssl: sslResults,
        disks: diskResults,
      },
    });
  }));

  // GET /api/notifications/status
  app.get('/api/notifications/status', requirePanelRouteAccess, asyncRoute(async (_request, response) => {
    const status = notificationService.getStatus();
    return response.json({ data: status });
  }));
}

export const operationalNotificationHttpInternals = Object.freeze({
  requireOwnerOrManagement,
});
