import { DnsZoneMailDkimRetirementError } from './dns-zone-mail-dkim-retirement.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const PREVIEW_FIELDS = new Set(['expectedRevision']);
const APPLY_FIELDS = new Set(['expectedRevision', 'previewDigest', 'confirmation']);

export class DnsZoneMailDkimRetirementHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneMailDkimRetirementHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new DnsZoneMailDkimRetirementHttpError(
      code,
      `Request must contain exactly ${[...fields].join(', ')}`,
    );
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new DnsZoneMailDkimRetirementHttpError(
      'mail_dkim_local_retirement_query_invalid',
      'Local DKIM retirement does not accept query parameters',
    );
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

async function retirementOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsZoneMailDkimRetirementError) {
      throw new DnsZoneMailDkimRetirementHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

export function mountDnsZoneMailDkimRetirementRoutes(app, { serviceForRequest } = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  if (typeof serviceForRequest !== 'function') throw new Error('Local DKIM retirement service resolver is required');

  app.post(
    '/api/mail-domains/:mailDomainId/dkim/local-dns-retirement-preview',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const body = exactBody(
        request.body,
        PREVIEW_FIELDS,
        'mail_dkim_local_retirement_preview_input_invalid',
      );
      const preview = await retirementOperation(async () => {
        const service = await serviceForRequest();
        if (!service || typeof service.preview !== 'function') {
          throw new DnsZoneMailDkimRetirementHttpError(
            'mail_dkim_local_retirement_dependencies_invalid',
            'Local DKIM retirement service is unavailable',
            503,
          );
        }
        return service.preview({
          mailDomainId: request.params.mailDomainId,
          expectedRevision: body.expectedRevision,
        });
      });
      return response.json({ data: preview });
    }),
  );

  app.post(
    '/api/mail-domains/:mailDomainId/dkim/local-dns-retirement-apply',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const body = exactBody(
        request.body,
        APPLY_FIELDS,
        'mail_dkim_local_retirement_apply_input_invalid',
      );
      const result = await retirementOperation(async () => {
        const service = await serviceForRequest();
        if (!service || typeof service.apply !== 'function') {
          throw new DnsZoneMailDkimRetirementHttpError(
            'mail_dkim_local_retirement_dependencies_invalid',
            'Local DKIM retirement service is unavailable',
            503,
          );
        }
        return service.apply({
          mailDomainId: request.params.mailDomainId,
          expectedRevision: body.expectedRevision,
          previewDigest: body.previewDigest,
          confirmation: body.confirmation,
        });
      });
      return response.json({ data: result });
    }),
  );
}

export const dnsZoneMailDkimRetirementHttpInternals = Object.freeze({
  previewFields: PREVIEW_FIELDS,
  applyFields: APPLY_FIELDS,
  exactBody,
  emptyQuery,
});
