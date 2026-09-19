import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteSuspensionRuntimeError } from './website-suspension-runtime.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const START_FIELDS = new Set(['previewDigest', 'confirmation']);
const OPERATION_FIELDS = new Set(['operationId', 'expectedUpdatedAt', 'confirmation']);

export class WebsiteSuspensionHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteSuspensionHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((field) => !fields.has(field))) {
    throw new WebsiteSuspensionHttpError(code, message);
  }
  return body;
}

function startBody(body) {
  const value = exactBody(
    body,
    START_FIELDS,
    'website_suspension_input_invalid',
    'Send previewDigest and confirmation',
  );
  if (typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new WebsiteSuspensionHttpError(
      'website_suspension_input_invalid',
      'A current previewDigest and exact confirmation are required',
    );
  }
  return value;
}

function operationBody(body, code) {
  const value = exactBody(
    body,
    OPERATION_FIELDS,
    code,
    'Send operationId, expectedUpdatedAt and confirmation',
  );
  if (typeof value.operationId !== 'string' || !value.operationId
    || typeof value.expectedUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.expectedUpdatedAt))
    || new Date(value.expectedUpdatedAt).toISOString() !== value.expectedUpdatedAt
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new WebsiteSuspensionHttpError(
      code,
      'A valid operationId, current expectedUpdatedAt and exact confirmation are required',
    );
  }
  return value;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (error instanceof WebsiteSuspensionRuntimeError) {
        return next(new WebsiteSuspensionHttpError(error.code, error.message, error.status));
      }
      return next(error);
    }
  };
}

export function mountWebsiteSuspensionRoutes(app, { runtime } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!runtime || typeof runtime.preview !== 'function' || typeof runtime.start !== 'function'
    || typeof runtime.resume !== 'function' || typeof runtime.listForWebsite !== 'function') {
    throw new Error('Website suspension runtime is required');
  }

  app.get('/api/websites/:websiteId/suspension', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const [preview, operations] = await Promise.all([
      runtime.preview({ websiteId }),
      runtime.listForWebsite(websiteId),
    ]);
    response.json({ preview, operations });
  }));

  app.post('/api/websites/:websiteId/suspension/start', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const body = startBody(request.body);
    const operation = await runtime.start({
      websiteId,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    });
    response.status(201).json({ operation });
  }));

  app.post('/api/websites/:websiteId/suspension/retry', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const body = operationBody(request.body, 'website_suspension_retry_input_invalid');
    const operation = await runtime.retrySuspend({
      websiteId,
      operationId: body.operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      confirmation: body.confirmation,
    });
    response.json({ operation });
  }));

  app.post('/api/websites/:websiteId/suspension/resume', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const body = operationBody(request.body, 'website_resume_input_invalid');
    const operation = await runtime.resume({
      websiteId,
      operationId: body.operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      confirmation: body.confirmation,
    });
    response.json({ operation });
  }));

  app.post('/api/websites/:websiteId/suspension/resume-retry', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const body = operationBody(request.body, 'website_resume_retry_input_invalid');
    const operation = await runtime.retryResume({
      websiteId,
      operationId: body.operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      confirmation: body.confirmation,
    });
    response.json({ operation });
  }));
}
