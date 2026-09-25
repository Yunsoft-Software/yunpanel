import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteRemovalRuntimeError } from './website-removal-runtime.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const START_FIELDS = new Set(['previewDigest', 'confirmation']);
const CONTINUE_STEP_FIELDS = new Set(['expectedUpdatedAt', 'stepId', 'confirmation']);

export class WebsiteRemovalHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteRemovalHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((field) => !fields.has(field))) {
    throw new WebsiteRemovalHttpError(code, message);
  }
  return body;
}

function startBody(body) {
  const value = exactBody(
    body,
    START_FIELDS,
    'website_removal_input_invalid',
    'Send previewDigest and confirmation',
  );
  if (typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new WebsiteRemovalHttpError(
      'website_removal_input_invalid',
      'A current previewDigest and exact removal confirmation are required',
    );
  }
  return value;
}

function continueStepBody(body) {
  const value = exactBody(
    body,
    CONTINUE_STEP_FIELDS,
    'website_removal_step_continuation_input_invalid',
    'Send expectedUpdatedAt, stepId and confirmation',
  );
  if (typeof value.expectedUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.expectedUpdatedAt))
    || new Date(value.expectedUpdatedAt).toISOString() !== value.expectedUpdatedAt
    || typeof value.stepId !== 'string' || !SAFE_ID.test(value.stepId)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new WebsiteRemovalHttpError(
      'website_removal_step_continuation_input_invalid',
      'A valid expectedUpdatedAt, stepId and confirmation are required',
    );
  }
  return value;
}

function requireRemovalOwner(request, response, next) {
  return requirePanelRouteAccess(request, response, () => {
    if (request.auth?.user?.role !== 'owner') {
      return response.status(403).json({ error: { code: 'forbidden', message: 'Owner access is required.' } });
    }
    return next();
  });
}

function removalActor(request) {
  const sessionId = request.auth?.id;
  const userId = request.auth?.user?.id;
  const role = request.auth?.user?.role;
  if (typeof sessionId !== 'string' || typeof userId !== 'string' || role !== 'owner') {
    throw new WebsiteRemovalHttpError(
      'website_removal_actor_invalid',
      'Live Owner session identity is required.',
      403,
    );
  }
  return Object.freeze({ sessionId, userId, role });
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (error instanceof WebsiteRemovalRuntimeError) {
        return next(new WebsiteRemovalHttpError(error.code, error.message, error.status));
      }
      return next(error);
    }
  };
}

export function mountWebsiteRemovalRoutes(app, { runtime } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!runtime || typeof runtime.preview !== 'function' || typeof runtime.start !== 'function'
    || typeof runtime.continueStep !== 'function' || typeof runtime.get !== 'function'
    || typeof runtime.list !== 'function' || typeof runtime.listForWebsite !== 'function') {
    throw new Error('Website removal runtime is required');
  }

  app.get('/api/website-removal-operations', requireRemovalOwner, asyncRoute(async (_request, response) => {
    const operations = await runtime.list();
    response.set('Cache-Control', 'no-store');
    response.json({ data: operations });
  }));

  app.get('/api/website-removal-operations/:operationId', requireRemovalOwner, asyncRoute(async (request, response) => {
    const operation = await runtime.get(request.params.operationId);
    if (!operation) {
      throw new WebsiteRemovalHttpError('website_removal_operation_not_found', 'Website removal operation was not found', 404);
    }
    response.set('Cache-Control', 'no-store');
    response.json({ data: operation });
  }));

  app.post('/api/website-removal-operations/:operationId/continue', requireRemovalOwner, asyncRoute(async (request, response) => {
    const operation = await runtime.get(request.params.operationId);
    if (!operation) {
      throw new WebsiteRemovalHttpError('website_removal_operation_not_found', 'Website removal operation was not found', 404);
    }
    const body = continueStepBody(request.body);
    const updated = await runtime.continueStep({
      websiteId: operation.websiteId,
      operationId: operation.id,
      expectedUpdatedAt: body.expectedUpdatedAt,
      stepId: body.stepId,
      confirmation: body.confirmation,
      actor: removalActor(request),
    });
    response.set('Cache-Control', 'no-store');
    response.json({ data: updated });
  }));

  app.get('/api/websites/:websiteId/removal', requireRemovalOwner, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const [preview, operations] = await Promise.all([
      runtime.preview({ websiteId }),
      runtime.listForWebsite(websiteId),
    ]);
    const data = { preview, operations };
    response.set('Cache-Control', 'no-store');
    response.json({ preview, operations, data });
  }));

  app.post('/api/websites/:websiteId/removal-preview', requireRemovalOwner, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const preview = await runtime.preview({ websiteId });
    response.set('Cache-Control', 'no-store');
    response.json({ preview, data: preview });
  }));

  app.post('/api/websites/:websiteId/removal', requireRemovalOwner, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const body = startBody(request.body);
    const operation = await runtime.start({
      websiteId,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
      actor: removalActor(request),
    });
    response.status(201).json({ operation, data: operation });
  }));

  app.get('/api/websites/:websiteId/removal-operations', requireRemovalOwner, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const operations = await runtime.listForWebsite(websiteId);
    response.set('Cache-Control', 'no-store');
    response.json({ operations, data: operations });
  }));

  app.get('/api/websites/:websiteId/removal-operations/:operationId', requireRemovalOwner, asyncRoute(async (request, response) => {
    const { websiteId, operationId } = request.params;
    const operation = await runtime.get(operationId);
    if (!operation || operation.websiteId !== websiteId) {
      throw new WebsiteRemovalHttpError('website_removal_operation_not_found', 'Website removal operation was not found', 404);
    }
    response.json({ operation, data: operation });
  }));

  app.post('/api/websites/:websiteId/removal-operations/:operationId/continue', requireRemovalOwner, asyncRoute(async (request, response) => {
    const { websiteId, operationId } = request.params;
    const body = continueStepBody(request.body);
    const operation = await runtime.continueStep({
      websiteId,
      operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      stepId: body.stepId,
      confirmation: body.confirmation,
      actor: removalActor(request),
    });
    response.json({ operation, data: operation });
  }));
}
