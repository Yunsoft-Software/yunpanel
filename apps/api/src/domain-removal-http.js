import { requirePanelRouteAccess } from './panel-http-guard.js';
import { DomainRemovalRuntimeError } from './domain-removal-runtime.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const START_FIELDS = new Set(['previewDigest', 'confirmation']);
const RETRY_ROUTING_FIELDS = new Set(['expectedUpdatedAt', 'checksum', 'confirmation']);
const CONTINUE_STEP_FIELDS = new Set(['expectedUpdatedAt', 'stepId', 'checksum', 'confirmation']);

export class DomainRemovalHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainRemovalHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((field) => !fields.has(field))) {
    throw new DomainRemovalHttpError(code, message);
  }
  return body;
}

function startBody(body) {
  const value = exactBody(
    body,
    START_FIELDS,
    'domain_removal_input_invalid',
    'Send previewDigest and confirmation',
  );
  if (typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new DomainRemovalHttpError(
      'domain_removal_input_invalid',
      'A current previewDigest and exact removal confirmation are required',
    );
  }
  return value;
}

function retryRoutingBody(body) {
  const value = exactBody(
    body,
    RETRY_ROUTING_FIELDS,
    'domain_removal_routing_retry_input_invalid',
    'Send expectedUpdatedAt, checksum and confirmation',
  );
  if (typeof value.expectedUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.expectedUpdatedAt))
    || new Date(value.expectedUpdatedAt).toISOString() !== value.expectedUpdatedAt
    || typeof value.checksum !== 'string' || !SHA256_PATTERN.test(value.checksum)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new DomainRemovalHttpError(
      'domain_removal_routing_retry_input_invalid',
      'A valid expectedUpdatedAt, checksum and confirmation are required',
    );
  }
  return value;
}

function continueStepBody(body) {
  const value = exactBody(
    body,
    CONTINUE_STEP_FIELDS,
    'domain_removal_step_continuation_input_invalid',
    'Send expectedUpdatedAt, stepId, checksum and confirmation',
  );
  if (typeof value.expectedUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.expectedUpdatedAt))
    || new Date(value.expectedUpdatedAt).toISOString() !== value.expectedUpdatedAt
    || typeof value.stepId !== 'string' || !SAFE_ID.test(value.stepId)
    || typeof value.checksum !== 'string' || !SHA256_PATTERN.test(value.checksum)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new DomainRemovalHttpError(
      'domain_removal_step_continuation_input_invalid',
      'A valid expectedUpdatedAt, stepId, checksum and confirmation are required',
    );
  }
  return value;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (error instanceof DomainRemovalRuntimeError) {
        return next(new DomainRemovalHttpError(error.code, error.message, error.status));
      }
      return next(error);
    }
  };
}

export function mountDomainRemovalRoutes(app, { runtime } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!runtime || typeof runtime.preview !== 'function' || typeof runtime.start !== 'function'
    || typeof runtime.retryRouting !== 'function' || typeof runtime.continueStep !== 'function'
    || typeof runtime.get !== 'function' || typeof runtime.listForDomain !== 'function') {
    throw new Error('Domain removal runtime is required');
  }

  app.get('/api/domains/:domainId/removal', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { domainId } = request.params;
    const [preview, operations] = await Promise.all([
      runtime.preview({ domainId }),
      runtime.listForDomain(domainId),
    ]);
    response.json({ preview, operations });
  }));

  app.post('/api/domains/:domainId/removal-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { domainId } = request.params;
    const preview = await runtime.preview({ domainId });
    response.json({ preview });
  }));

  app.post('/api/domains/:domainId/removal', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { domainId } = request.params;
    const body = startBody(request.body);
    const operation = await runtime.start({
      domainId,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    });
    response.status(201).json({ operation });
  }));

  app.get('/api/domains/:domainId/removal-operations', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { domainId } = request.params;
    const operations = await runtime.listForDomain(domainId);
    response.json({ operations });
  }));

  app.get('/api/domains/:domainId/removal-operations/:operationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { operationId } = request.params;
    const operation = await runtime.get(operationId);
    if (!operation) {
      throw new DomainRemovalHttpError('domain_removal_operation_not_found', 'Domain removal operation was not found', 404);
    }
    response.json({ operation });
  }));

  app.post('/api/domains/:domainId/removal-operations/:operationId/retry-routing', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { domainId, operationId } = request.params;
    const body = retryRoutingBody(request.body);
    const operation = await runtime.retryRouting({
      domainId,
      operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      checksum: body.checksum,
      confirmation: body.confirmation,
    });
    response.json({ operation });
  }));

  app.post('/api/domains/:domainId/removal-operations/:operationId/continue', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { domainId, operationId } = request.params;
    const body = continueStepBody(request.body);
    const operation = await runtime.continueStep({
      domainId,
      operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      stepId: body.stepId,
      checksum: body.checksum,
      confirmation: body.confirmation,
    });
    response.json({ operation });
  }));
}
