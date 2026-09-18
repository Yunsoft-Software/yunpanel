import { requirePanelRouteAccess } from './panel-http-guard.js';
import { ElFinderHandoffError } from './elfinder-handoff-service.js';

function emptyBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new ElFinderHandoffError(
      'elfinder_handoff_request_invalid',
      'elFinder handoff request body must be empty',
    );
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new ElFinderHandoffError(
      'elfinder_handoff_query_invalid',
      'elFinder handoff does not accept query parameters',
    );
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountElFinderHandoffRoutes(app, {
  registry,
  elFinderHandoffService,
} = {}) {
  if (!app || typeof app.post !== 'function'
    || !registry || typeof registry.getServer !== 'function'
    || !elFinderHandoffService || typeof elFinderHandoffService.issue !== 'function') {
    throw new TypeError('elFinder handoff HTTP dependencies are required');
  }

  app.post(
    '/api/servers/:serverId/websites/:websiteId/elfinder-handoffs',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      emptyBody(request.body);
      const auth = request.auth;
      if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string'
        || auth.user.role !== 'owner' || auth.access?.mode !== 'management'
        || auth.security?.managementAllowed !== true) {
        throw new ElFinderHandoffError(
          'elfinder_handoff_owner_required',
          'elFinder requires an authenticated Owner session',
          403,
        );
      }
      const server = await registry.getServer(request.params.serverId);
      if (!server) {
        throw new ElFinderHandoffError('server_not_found', 'Server not found', 404);
      }
      const handoff = await elFinderHandoffService.issue({
        sessionId: auth.id,
        userId: auth.user.id,
        serverId: server.id,
        websiteId: request.params.websiteId,
      });
      response.set('Cache-Control', 'no-store');
      response.set('Pragma', 'no-cache');
      return response.status(201).json({ data: handoff });
    }),
  );
}

export const elFinderHandoffHttpInternals = Object.freeze({
  emptyBody,
  emptyQuery,
});
