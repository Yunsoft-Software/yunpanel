import { requirePanelRouteAccess } from '../http/panel-http-guard.js';

export function mountWebsiteStaticCopyRoutes(app, { service, php = false }) {
  const root = `/api/websites/:websiteId/${php ? 'php-copy' : 'static-copy'}`;
  const route = (action, status, getInput) => async (request, response, next) => {
    try {
      const actor = { sessionId: request.auth?.id, userId: request.auth?.user?.id, role: request.auth?.user?.role };
      const data = await service[action](request.params.websiteId, getInput(request), actor);
      response.set('Cache-Control', 'no-store').status(status).json({ data });
    } catch (error) { next(error); }
  };
  const body = (request) => request.body;
  app.post(`${root}/preview`, requirePanelRouteAccess, route('preview', 200, body));
  app.post(`${root}/requests`, requirePanelRouteAccess, route('queue', 202, body));
  app.get(`${root}/requests/:requestId`, requirePanelRouteAccess, route('getRequest', 200, (request) => request.params.requestId));
}
