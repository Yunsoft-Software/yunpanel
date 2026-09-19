import { requirePanelRouteAccess } from './panel-http-guard.js';

const BIND_PREVIEW_FIELDS = new Set(['certificateId']);
const BIND_FIELDS = new Set(['certificateId', 'previewDigest', 'confirmation']);
const DELETE_FIELDS = new Set(['expectedRevision', 'previewDigest', 'confirmation']);
const CONTINUE_FIELDS = new Set(['operationId', 'expectedUpdatedAt', 'confirmation']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class RoundcubeDomainMappingHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RoundcubeDomainMappingHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))) {
    throw new RoundcubeDomainMappingHttpError(
      code,
      'Request fields are invalid',
    );
  }
  return value;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new RoundcubeDomainMappingHttpError(
      'roundcube_mapping_query_invalid',
      'Roundcube mapping endpoints do not accept query parameters',
    );
  }
}

function certificateId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new RoundcubeDomainMappingHttpError(
      'roundcube_mapping_certificate_invalid',
      'certificateId is invalid',
    );
  }
  return value;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountRoundcubeDomainMappingRoutes(app, {
  service,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!service || typeof service.previewBind !== 'function'
    || typeof service.beginBind !== 'function'
    || typeof service.previewDelete !== 'function'
    || typeof service.beginDelete !== 'function'
    || typeof service.inspect !== 'function'
    || typeof service.continueOperation !== 'function') {
    throw new Error('Roundcube Domain mapping service is required');
  }

  app.get(
    '/api/mail-domains/:mailDomainId/webmail',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      response.set('Cache-Control', 'no-store');
      return response.json({ data: await service.inspect(request.params.mailDomainId) });
    }),
  );

  app.post(
    '/api/mail-domains/:mailDomainId/webmail/bind-preview',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const body = exactBody(
        request.body,
        BIND_PREVIEW_FIELDS,
        'roundcube_mapping_bind_preview_invalid',
      );
      const preview = await service.previewBind({
        mailDomainId: request.params.mailDomainId,
        certificateId: certificateId(body.certificateId),
      });
      response.set('Cache-Control', 'no-store');
      return response.json({ data: preview });
    }),
  );

  app.post(
    '/api/mail-domains/:mailDomainId/webmail/bind',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const body = exactBody(
        request.body,
        BIND_FIELDS,
        'roundcube_mapping_bind_invalid',
      );
      if (typeof body.previewDigest !== 'string' || !SHA256_PATTERN.test(body.previewDigest)
        || typeof body.confirmation !== 'string' || !body.confirmation) {
        throw new RoundcubeDomainMappingHttpError(
          'roundcube_mapping_bind_identity_invalid',
          'Current mapping preview digest and exact confirmation are required',
          409,
        );
      }
      const result = await service.beginBind({
        mailDomainId: request.params.mailDomainId,
        certificateId: certificateId(body.certificateId),
        previewDigest: body.previewDigest,
        confirmation: body.confirmation,
      });
      response.set('Cache-Control', 'no-store');
      return response.status(202).json({ data: result });
    }),
  );

  app.post(
    '/api/mail-domains/:mailDomainId/webmail/delete-preview',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      exactBody(
        request.body,
        new Set(),
        'roundcube_mapping_delete_preview_invalid',
      );
      const result = await service.previewDelete(request.params.mailDomainId);
      response.set('Cache-Control', 'no-store');
      return response.json({ data: result });
    }),
  );

  app.post(
    '/api/mail-domains/:mailDomainId/webmail/delete',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const body = exactBody(
        request.body,
        DELETE_FIELDS,
        'roundcube_mapping_delete_invalid',
      );
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
        || typeof body.previewDigest !== 'string' || !SHA256_PATTERN.test(body.previewDigest)
        || typeof body.confirmation !== 'string' || !body.confirmation) {
        throw new RoundcubeDomainMappingHttpError(
          'roundcube_mapping_delete_identity_invalid',
          'Current mapping revision, preview digest and exact confirmation are required',
          409,
        );
      }
      const result = await service.beginDelete(request.params.mailDomainId, {
        expectedRevision: body.expectedRevision,
        previewDigest: body.previewDigest,
        confirmation: body.confirmation,
      });
      response.set('Cache-Control', 'no-store');
      return response.status(202).json({ data: result });
    }),
  );

  app.post(
    '/api/mail-domains/:mailDomainId/webmail/continue',
    requirePanelRouteAccess,
    asyncRoute(async (request, response) => {
      emptyQuery(request.query);
      const body = exactBody(
        request.body,
        CONTINUE_FIELDS,
        'roundcube_mapping_continuation_invalid',
      );
      if (typeof body.operationId !== 'string' || !body.operationId
        || typeof body.expectedUpdatedAt !== 'string'
        || !Number.isFinite(Date.parse(body.expectedUpdatedAt))
        || typeof body.confirmation !== 'string' || !body.confirmation) {
        throw new RoundcubeDomainMappingHttpError(
          'roundcube_mapping_continuation_identity_invalid',
          'Current mapping operation identity and exact confirmation are required',
          409,
        );
      }
      const result = await service.continueOperation({
        mailDomainId: request.params.mailDomainId,
        operationId: body.operationId,
        expectedUpdatedAt: new Date(body.expectedUpdatedAt).toISOString(),
        confirmation: body.confirmation,
      });
      response.set('Cache-Control', 'no-store');
      return response.status(202).json({ data: result });
    }),
  );
}

export const roundcubeDomainMappingHttpInternals = Object.freeze({
  exactBody,
  emptyQuery,
  certificateId,
});
