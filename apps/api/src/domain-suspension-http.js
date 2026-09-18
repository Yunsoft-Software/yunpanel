import { requirePanelRouteAccess } from './panel-http-guard.js';
import { DomainSuspensionRuntimeError } from './domain-suspension-runtime.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const APPLY_FIELDS = new Set(['previewDigest', 'confirmation']);
const OPERATION_FIELDS = new Set(['expectedUpdatedAt', 'checksum', 'confirmation']);

export class DomainSuspensionHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainSuspensionHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((field) => !fields.has(field))) {
    throw new DomainSuspensionHttpError(code, message);
  }
  return body;
}

function emptyBody(body, code) {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new DomainSuspensionHttpError(code, 'Request body must be empty');
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new DomainSuspensionHttpError(
      'domain_suspension_query_invalid',
      'Domain suspension routes do not accept query parameters',
    );
  }
}

function applyBody(body) {
  const value = exactBody(
    body,
    APPLY_FIELDS,
    'domain_suspension_input_invalid',
    'Send previewDigest and confirmation',
  );
  if (typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new DomainSuspensionHttpError(
      'domain_suspension_input_invalid',
      'A current previewDigest and exact suspension confirmation are required',
    );
  }
  return value;
}

function operationBody(body, code) {
  const value = exactBody(
    body,
    OPERATION_FIELDS,
    code,
    'Send expectedUpdatedAt, checksum and confirmation',
  );
  if (typeof value.expectedUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.expectedUpdatedAt))
    || new Date(value.expectedUpdatedAt).toISOString() !== value.expectedUpdatedAt
    || typeof value.checksum !== 'string' || !SHA256_PATTERN.test(value.checksum)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new DomainSuspensionHttpError(
      code,
      'A current operation revision, checksum and exact confirmation are required',
    );
  }
  return value;
}

async function suspensionOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DomainSuspensionRuntimeError) {
      throw new DomainSuspensionHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountDomainSuspensionRoutes(app, { runtime } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!runtime || typeof runtime.start !== 'function'
    || typeof runtime.retrySuspend !== 'function' || typeof runtime.resume !== 'function'
    || typeof runtime.retryResume !== 'function' || typeof runtime.get !== 'function'
    || typeof runtime.listForDomain !== 'function') {
    throw new Error('Domain suspension runtime is required');
  }

  app.post('/api/domains/:domainId/suspend-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    emptyBody(request.body, 'domain_suspension_preview_input_invalid');
    // Runtime does not expose a second preview implementation; the injected
    // service preview is surfaced by a read-only method on production runtime.
    if (typeof runtime.preview !== 'function') {
      throw new DomainSuspensionHttpError(
        'domain_suspension_preview_unavailable',
        'Domain suspension preview is unavailable',
        503,
      );
    }
    const preview = await suspensionOperation(
      () => runtime.preview({ domainId: request.params.domainId }),
    );
    response.set('Cache-Control', 'no-store');
    return response.json({ data: preview });
  }));

  app.post('/api/domains/:domainId/suspend', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = applyBody(request.body);
    const operation = await suspensionOperation(() => runtime.start({
      domainId: request.params.domainId,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    }));
    return response.status(202).json({ data: operation });
  }));

  app.get('/api/domains/:domainId/suspension-operations', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const operations = await suspensionOperation(
      () => runtime.listForDomain(request.params.domainId),
    );
    response.set('Cache-Control', 'no-store');
    return response.json({ data: operations });
  }));

  app.get('/api/domains/:domainId/suspension-operations/:operationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const operation = await suspensionOperation(() => runtime.get(request.params.operationId));
    if (!operation || operation.domainId !== request.params.domainId) {
      throw new DomainSuspensionHttpError(
        'domain_suspension_operation_not_found',
        'Domain suspension operation was not found',
        404,
      );
    }
    response.set('Cache-Control', 'no-store');
    return response.json({ data: operation });
  }));

  app.post('/api/domains/:domainId/suspension-operations/:operationId/suspend-retry', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = operationBody(request.body, 'domain_suspension_retry_input_invalid');
    const operation = await suspensionOperation(() => runtime.retrySuspend({
      domainId: request.params.domainId,
      operationId: request.params.operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      checksum: body.checksum,
      confirmation: body.confirmation,
    }));
    return response.status(202).json({ data: operation });
  }));

  app.post('/api/domains/:domainId/suspension-operations/:operationId/resume', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = operationBody(request.body, 'domain_resume_input_invalid');
    const operation = await suspensionOperation(() => runtime.resume({
      domainId: request.params.domainId,
      operationId: request.params.operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      checksum: body.checksum,
      confirmation: body.confirmation,
    }));
    return response.status(202).json({ data: operation });
  }));

  app.post('/api/domains/:domainId/suspension-operations/:operationId/resume-retry', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = operationBody(request.body, 'domain_resume_retry_input_invalid');
    const operation = await suspensionOperation(() => runtime.retryResume({
      domainId: request.params.domainId,
      operationId: request.params.operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      checksum: body.checksum,
      confirmation: body.confirmation,
    }));
    return response.status(202).json({ data: operation });
  }));
}

export const domainSuspensionHttpInternals = Object.freeze({
  applyFields: Object.freeze([...APPLY_FIELDS]),
  operationFields: Object.freeze([...OPERATION_FIELDS]),
  exactBody,
  emptyBody,
  emptyQuery,
  applyBody,
  operationBody,
});
