import { requirePanelRouteAccess } from './panel-http-guard.js';

const DELETE_FIELDS = new Set(['expectedRevision', 'deleteJobId', 'confirmation']);

export class MailDomainDeleteHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainDeleteHttpError';
    this.code = code;
    this.status = status;
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailDomainDeleteHttpError('mail_domain_delete_query_invalid', 'Mail domain deletion does not accept query parameters');
  }
}

function input(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== DELETE_FIELDS.size
    || Object.keys(body).some((field) => !DELETE_FIELDS.has(field))) {
    throw new MailDomainDeleteHttpError(
      'mail_domain_delete_input_invalid',
      'Request must contain exactly expectedRevision, deleteJobId, confirmation',
    );
  }
  return body;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountMailDomainDeleteRoute(app, { mailDeleteFinalizeService } = {}) {
  if (!app || typeof app.delete !== 'function') throw new Error('Express application is required');
  if (!mailDeleteFinalizeService || typeof mailDeleteFinalizeService.finalizeMailDomain !== 'function') {
    throw new Error('Mail domain delete finalizer is required');
  }

  app.delete('/api/mail-domains/:mailDomainId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = input(request.body);
    const result = await mailDeleteFinalizeService.finalizeMailDomain({
      mailDomainId: request.params.mailDomainId,
      ...body,
    });
    return response.json({
      data: result,
      sideEffects: { mailConfigurationChanged: false, mailDataChanged: false },
    });
  }));
}

export const mailDomainDeleteHttpInternals = Object.freeze({
  deleteFields: Object.freeze([...DELETE_FIELDS]),
  emptyQuery,
  input,
});
