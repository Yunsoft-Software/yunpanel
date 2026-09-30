import { requirePanelRouteAccess } from './panel-http-guard.js';
import { SystemWatchdogError } from './system-watchdog-service.js';

export class SystemWatchdogHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SystemWatchdogHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      if (error instanceof SystemWatchdogError) {
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
      error: { code: 'forbidden', message: 'Management permissions required for watchdog operations.' },
    });
  }
  return next();
}

function requireOwnerRole(request, response, next) {
  const role = request.auth?.user?.role;
  if (role !== 'owner') {
    return response.status(403).json({
      error: { code: 'forbidden', message: 'Owner permissions required for system component recovery.' },
    });
  }
  return next();
}

async function resolveServer(registry, serverId, localServerId) {
  const targetId = (!serverId || serverId === 'local') ? (localServerId || 'local') : serverId;
  if (!registry || typeof registry.getServer !== 'function') {
    return { id: targetId };
  }
  try {
    const server = await registry.getServer(targetId);
    if (server) return server;
  } catch {
    // fall back if server record lookup fails
  }
  return { id: targetId };
}

export function mountSystemWatchdogRoutes(app, {
  watchdogService,
  registry = null,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express application is required');
  }
  if (!watchdogService || typeof watchdogService.getStatus !== 'function') {
    throw new TypeError('System watchdog service is required');
  }

  // GET /api/servers/:serverId/watchdog/status
  app.get('/api/servers/:serverId/watchdog/status', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const status = await watchdogService.getStatus({ serverId: server.id });
    return response.json({ data: status });
  }));

  // POST /api/servers/:serverId/watchdog/check
  app.post('/api/servers/:serverId/watchdog/check', requireManagementRole, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const result = await watchdogService.check({ serverId: server.id });
    return response.json({ data: result });
  }));

  // POST /api/servers/:serverId/watchdog/recover
  app.post('/api/servers/:serverId/watchdog/recover', requireOwnerRole, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const { targetType, targetId, confirmation } = request.body ?? {};

    if (!targetType || !targetId) {
      throw new SystemWatchdogHttpError('target_parameters_required', 'targetType and targetId are required in request body', 400);
    }
    if (!confirmation) {
      throw new SystemWatchdogHttpError('confirmation_required', `Confirmation is required: recover:${targetType}:${targetId}`, 400);
    }

    const result = await watchdogService.recoverComponent({
      serverId: server.id,
      targetType,
      targetId,
      confirmation,
    });

    return response.json({ data: result });
  }));

  // Global / local server watchdog shortcuts: /api/system/watchdog/*
  app.get('/api/system/watchdog/status', requirePanelRouteAccess, asyncRoute(async (_request, response) => {
    const status = await watchdogService.getStatus({ serverId: localServerId });
    return response.json({ data: status });
  }));

  app.post('/api/system/watchdog/check', requireManagementRole, requirePanelRouteAccess, asyncRoute(async (_request, response) => {
    const result = await watchdogService.check({ serverId: localServerId });
    return response.json({ data: result });
  }));

  app.post('/api/system/watchdog/recover', requireOwnerRole, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { targetType, targetId, confirmation } = request.body ?? {};

    if (!targetType || !targetId) {
      throw new SystemWatchdogHttpError('target_parameters_required', 'targetType and targetId are required in request body', 400);
    }
    if (!confirmation) {
      throw new SystemWatchdogHttpError('confirmation_required', `Confirmation is required: recover:${targetType}:${targetId}`, 400);
    }

    const result = await watchdogService.recoverComponent({
      serverId: localServerId,
      targetType,
      targetId,
      confirmation,
    });

    return response.json({ data: result });
  }));
}

export const systemWatchdogHttpInternals = Object.freeze({
  requireManagementRole,
  requireOwnerRole,
  resolveServer,
});
