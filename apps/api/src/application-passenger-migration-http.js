import { requirePanelRouteAccess } from './panel-http-guard.js';

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountApplicationPassengerMigrationRoutes(app, { previewService, migrationService } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || !previewService || typeof previewService.preview !== 'function'
    || !migrationService || typeof migrationService.apply !== 'function') {
    throw new Error('Application Passenger migration route dependencies are required');
  }

  app.get(
    '/api/applications/:applicationId/passenger-migration-preview',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => response.json({
      data: await previewService.preview(request.params.applicationId),
    })),
  );

  app.post(
    '/api/applications/:applicationId/passenger-migration',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      const applied = await migrationService.apply(request.params.applicationId, request.body);
      return response.status(202).json({ data: applied });
    }),
  );
}

export const applicationPassengerMigrationHttpInternals = Object.freeze({ asyncRoute });
