import { requirePanelRouteAccess } from './panel-http-guard.js';
import { PhpMyAdminHandoffError } from './phpmyadmin-handoff-service.js';

const BODY_FIELDS = new Set(['credentialId']);

function exactBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== BODY_FIELDS.size
    || Object.keys(body).some((field) => !BODY_FIELDS.has(field))
    || typeof body.credentialId !== 'string') {
    throw new PhpMyAdminHandoffError(
      'phpmyadmin_handoff_request_invalid',
      'Request must contain exactly credentialId',
    );
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new PhpMyAdminHandoffError(
      'phpmyadmin_handoff_query_invalid',
      'phpMyAdmin handoff does not accept query parameters',
    );
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountPhpMyAdminHandoffRoutes(app, {
  registry,
  phpMyAdminHandoffService,
} = {}) {
  if (!app || typeof app.post !== 'function'
    || !registry || typeof registry.getServer !== 'function'
    || !phpMyAdminHandoffService || typeof phpMyAdminHandoffService.issue !== 'function') {
    throw new TypeError('phpMyAdmin handoff HTTP dependencies are required');
  }

  app.post(
    '/api/servers/:serverId/websites/:websiteId/phpmyadmin-handoffs',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const auth = request.auth;
      if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string'
        || auth.user.role !== 'owner' || auth.access?.mode !== 'management'
        || auth.security?.managementAllowed !== true) {
        throw new PhpMyAdminHandoffError(
          'phpmyadmin_handoff_owner_required',
          'phpMyAdmin requires an authenticated Owner session',
          403,
        );
      }
      const server = await registry.getServer(request.params.serverId);
      if (!server) {
        throw new PhpMyAdminHandoffError(
          'server_not_found',
          'Server not found',
          404,
        );
      }
      const body = exactBody(request.body);
      const handoff = await phpMyAdminHandoffService.issue({
        sessionId: auth.id,
        userId: auth.user.id,
        serverId: server.id,
        websiteId: request.params.websiteId,
        credentialId: body.credentialId,
      });
      response.set('Cache-Control', 'no-store');
      response.set('Pragma', 'no-cache');
      return response.status(201).json({ data: handoff });
    }),
  );
}

export const phpMyAdminHandoffHttpInternals = Object.freeze({
  bodyFields: Object.freeze([...BODY_FIELDS]),
  exactBody,
  emptyQuery,
});
