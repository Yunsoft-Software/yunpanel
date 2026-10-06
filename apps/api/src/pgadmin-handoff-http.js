import { requirePanelRouteAccess } from './panel-http-guard.js';
import { PgAdminHandoffError } from './pgadmin-handoff-service.js';

const BODY_FIELDS = new Set(['credentialId']);

function exactBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== BODY_FIELDS.size
    || Object.keys(body).some((field) => !BODY_FIELDS.has(field))
    || typeof body.credentialId !== 'string') {
    throw new PgAdminHandoffError(
      'pgadmin_handoff_request_invalid',
      'Request must contain exactly credentialId',
    );
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new PgAdminHandoffError(
      'pgadmin_handoff_query_invalid',
      'pgAdmin handoff does not accept query parameters',
    );
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function requireAuthorizedManagement(auth, websiteId = null) {
  const isOwner = auth?.user?.role === 'owner' && auth?.access?.mode === 'management' && auth?.security?.managementAllowed === true;
  const isSiteManager = ['site_manager', 'reseller', 'customer'].includes(auth?.user?.role)
    && auth?.access?.mode === 'site_management'
    && (!websiteId || (auth?.user?.websiteIds ?? []).includes(websiteId));
  if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string' || (!isOwner && !isSiteManager)) {
    throw new PgAdminHandoffError(
      'pgadmin_handoff_authorized_required',
      'pgAdmin requires an authorized session for this website',
      403,
    );
  }
  return auth;
}
const requireOwnerManagement = requireAuthorizedManagement;

export function mountPgAdminHandoffRoutes(app, {
  registry,
  pgAdminHandoffService,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || !registry || typeof registry.getServer !== 'function'
    || !pgAdminHandoffService || typeof pgAdminHandoffService.issue !== 'function') {
    throw new TypeError('pgAdmin handoff HTTP dependencies are required');
  }

  app.post(
    '/api/servers/:serverId/websites/:websiteId/pgadmin-handoffs',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const auth = requireAuthorizedManagement(request.auth, request.params.websiteId);
      const server = await registry.getServer(request.params.serverId);
      if (!server) {
        throw new PgAdminHandoffError(
          'server_not_found',
          'Server not found',
          404,
        );
      }
      const body = exactBody(request.body);
      const handoff = await pgAdminHandoffService.issue({
        sessionId: auth.id,
        userId: auth.user.id,
        sessionDigest: request.authSessionDigest,
        serverId: server.id,
        websiteId: request.params.websiteId,
        credentialId: body.credentialId,
      });
      response.set('Cache-Control', 'no-store');
      response.set('Pragma', 'no-cache');
      return response.status(201).json({ data: handoff });
    }),
  );

  app.get(
    '/api/pgadmin-signon-access',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      requireAuthorizedManagement(request.auth);
      response.set('Cache-Control', 'no-store');
      response.set('Pragma', 'no-cache');
      return response.status(204).end();
    }),
  );

  app.get(
    '/api/pgadmin-gateway-access',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      requireOwnerManagement(request.auth);
      response.set('Cache-Control', 'no-store');
      response.set('Pragma', 'no-cache');
      return response.status(204).end();
    }),
  );
}

export const pgAdminHandoffHttpInternals = Object.freeze({
  bodyFields: Object.freeze([...BODY_FIELDS]),
  exactBody,
  emptyQuery,
  requireOwnerManagement,
});
