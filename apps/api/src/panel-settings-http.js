import { requirePanelRouteAccess } from './panel-http-guard.js';

export class PanelSettingsHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PanelSettingsHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      return next(error);
    }
  };
}

export function mountPanelSettingsRoutes(app, { panelSettingsService }) {
  if (!app || typeof app.get !== 'function' || typeof app.patch !== 'function') {
    throw new Error('Express application is required');
  }
  if (!panelSettingsService || typeof panelSettingsService.getSystemSettings !== 'function') {
    throw new Error('Panel settings service is required');
  }

  app.get(
    ['/api/settings', '/api/panel/settings'],
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      const data = await panelSettingsService.getSystemSettings();
      return response.json({ data });
    }),
  );

  app.patch(
    ['/api/settings', '/api/panel/settings'],
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      const data = await panelSettingsService.updateSystemSettings(request.body);
      return response.json({ data });
    }),
  );
}
