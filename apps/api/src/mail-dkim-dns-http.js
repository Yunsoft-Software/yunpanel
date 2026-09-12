import { requirePanelRouteAccess } from './panel-http-guard.js';

const PREVIEW_FIELDS = new Set(['kind', 'expectedRevision']);
const APPLY_FIELDS = new Set(['kind', 'expectedRevision', 'previewDigest', 'confirmation']);

export class MailDkimDnsHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDkimDnsHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailDkimDnsHttpError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new MailDkimDnsHttpError('mail_dkim_dns_reconcile_input_invalid', 'DKIM DNS reconcile requires an empty JSON object');
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailDkimDnsHttpError('mail_dkim_dns_query_invalid', 'DKIM DNS operation does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountMailDkimDnsRoutes(app, { mailDkimDnsService } = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!mailDkimDnsService || typeof mailDkimDnsService.preview !== 'function'
    || typeof mailDkimDnsService.apply !== 'function'
    || typeof mailDkimDnsService.reconcileRetirement !== 'function') {
    throw new Error('DKIM DNS service is required');
  }

  app.post('/api/mail-domains/:mailDomainId/dkim/dns-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, PREVIEW_FIELDS, 'mail_dkim_dns_preview_input_invalid');
    const preview = await mailDkimDnsService.preview({
      mailDomainId: request.params.mailDomainId,
      kind: body.kind,
      expectedRevision: body.expectedRevision,
    });
    return response.json({ data: preview });
  }));

  app.post('/api/mail-domains/:mailDomainId/dkim/dns-apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, APPLY_FIELDS, 'mail_dkim_dns_apply_input_invalid');
    const result = await mailDkimDnsService.apply({
      mailDomainId: request.params.mailDomainId,
      kind: body.kind,
      expectedRevision: body.expectedRevision,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    });
    return response.status(result.job ? 202 : 200).json({ data: result });
  }));

  app.post('/api/mail-domains/:mailDomainId/dkim/dns-reconcile', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    emptyBody(request.body);
    return response.json({ data: await mailDkimDnsService.reconcileRetirement(request.params.mailDomainId) });
  }));
}

export const mailDkimDnsHttpInternals = Object.freeze({
  previewFields: PREVIEW_FIELDS,
  applyFields: APPLY_FIELDS,
  exactBody,
  emptyBody,
  emptyQuery,
});
