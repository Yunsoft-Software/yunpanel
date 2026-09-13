import { requirePanelRouteAccess } from './panel-http-guard.js';
import { MailDeleteImpactError } from './mail-delete-impact.js';

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailDeleteImpactError('mail_delete_impact_query_invalid', 'Mail delete impact does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountMailDeleteImpactRoutes(app, { mailDeleteImpactService } = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('Express application is required');
  if (!mailDeleteImpactService || typeof mailDeleteImpactService.inspectMailbox !== 'function'
    || typeof mailDeleteImpactService.inspectMailDomain !== 'function') {
    throw new Error('Mail delete impact service is required');
  }

  app.get('/api/mailboxes/:mailboxId/delete-impact', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    return response.json({ data: await mailDeleteImpactService.inspectMailbox(request.params.mailboxId) });
  }));
  app.get('/api/mail-domains/:mailDomainId/delete-impact', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    return response.json({ data: await mailDeleteImpactService.inspectMailDomain(request.params.mailDomainId) });
  }));
}

export const mailDeleteImpactHttpInternals = Object.freeze({ emptyQuery });
