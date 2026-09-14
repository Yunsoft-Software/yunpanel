import { requirePanelRouteAccess } from './panel-http-guard.js';

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountApplicationPassengerMigrationRoutes(app, { previewService } = {}) {
  if (!app || typeof app.get !== 'function'
    || !previewService || typeof previewService.preview !== 'function') {
    throw new Error('Application Passenger migration route dependencies are required');
  }

  app.get(
    '/api/applications/:applicationId/passenger-migration-preview',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => response.json({
      data: await previewService.preview(request.params.applicationId),
    })),
  );
}

export const applicationPassengerMigrationHttpInternals = Object.freeze({ asyncRoute });
