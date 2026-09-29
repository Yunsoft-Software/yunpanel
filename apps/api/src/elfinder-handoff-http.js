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
  if (!app || typeof app.post !== 'function' || typeof app.get !== 'function'
    || !registry || typeof registry.getServer !== 'function'
    || !elFinderHandoffService || typeof elFinderHandoffService.issue !== 'function') {
    throw new TypeError('elFinder handoff HTTP dependencies are required');
  }

  app.get(
    '/api/elfinder-bootstrap-access',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const auth = request.auth;
      const isOwner = auth?.user?.role === 'owner'
        && auth?.access?.mode === 'management'
        && auth?.security?.managementAllowed === true;
      const active = auth?.user?.active !== false && auth?.user?.active !== 0;
      const isSiteActor = active
        && ['site_manager', 'reseller', 'customer'].includes(auth?.user?.role)
        && auth?.access?.mode === 'site_management'
        && auth?.security?.managementAllowed === true
        && Array.isArray(auth?.user?.websiteIds)
        && auth.user.websiteIds.length > 0;
      if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string'
        || (!isOwner && !isSiteActor)) {
        throw new ElFinderHandoffError(
          'elfinder_bootstrap_authorized_required',
          'elFinder requires an authorized Website management session',
          403,
        );
      }
      response.set('Cache-Control', 'no-store');
      response.set('Pragma', 'no-cache');
      return response.status(204).end();
    }),
  );

  app.post(
    '/api/servers/:serverId/websites/:websiteId/elfinder-handoffs',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      emptyBody(request.body);
      const auth = request.auth;
      const active = auth?.user?.active !== false && auth?.user?.active !== 0;
      const isOwner = active && auth?.user?.role === 'owner' && auth?.access?.mode === 'management' && auth?.security?.managementAllowed === true;
      const isSiteActor = active
        && ['site_manager', 'reseller', 'customer'].includes(auth?.user?.role)
        && auth?.access?.mode === 'site_management'
        && auth?.security?.managementAllowed === true
        && (auth?.user?.websiteIds ?? []).includes(request.params.websiteId);
      if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string' || (!isOwner && !isSiteActor)) {
        throw new ElFinderHandoffError(
          'elfinder_handoff_authorized_required',
          'elFinder requires an authorized session for this website',
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
        sessionDigest: request.authSessionDigest,
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
