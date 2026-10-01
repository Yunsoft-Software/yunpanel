import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteRemovalRuntimeError } from './website-removal-runtime.js';
import { extractActorTenant } from './tenant-boundary.js';

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

function removalActor(request) {
  const sessionId = request.auth?.id;
  const userId = request.auth?.user?.id;
  const role = request.auth?.user?.role;
  if (typeof sessionId !== 'string' || typeof userId !== 'string'
    || !['owner', 'site_manager', 'reseller', 'customer'].includes(role)) {
    throw new WebsiteRemovalHttpError(
      'website_removal_actor_invalid',
      'Live Website removal session identity is required.',
      403,
    );
  }
  return Object.freeze({ sessionId, userId, role });
}

function removalNotFound() {
  return new WebsiteRemovalHttpError(
    'website_removal_operation_not_found',
    'Website removal operation was not found',
    404,
  );
}

async function requireWebsiteAccess(request, targetWebsiteId, { websiteRegistry = null, localServerId = null, allowDeleted = false } = {}) {
  const actor = removalActor(request);
  const auth = request.auth;
  const actorTenant = extractActorTenant(auth);
  if (!actorTenant.active) {
    throw new WebsiteRemovalHttpError(
      'tenant_actor_inactive',
      'Inactive account cannot access tenant resources.',
      403,
    );
  }
  if (actor.role === 'owner') return actor;
  if (auth?.access?.mode !== 'site_management' || auth?.security?.managementAllowed !== true
    || !Array.isArray(actorTenant.websiteIds) || !actorTenant.websiteIds.includes(targetWebsiteId)) {
    throw removalNotFound();
  }
  if (websiteRegistry && typeof websiteRegistry.getWebsite === 'function') {
    let website;
    try { website = await websiteRegistry.getWebsite(targetWebsiteId); }
    catch {
      throw new WebsiteRemovalHttpError(
        'website_removal_scope_unavailable',
        'Website removal scope could not be verified',
        503,
      );
    }
    if (website) {
      if (website.id !== targetWebsiteId
        || (localServerId !== null && localServerId !== undefined && website.serverId !== localServerId)) {
        throw removalNotFound();
      }
    } else if (!allowDeleted) {
      throw removalNotFound();
    }
  } else if (!websiteRegistry) {
    throw new WebsiteRemovalHttpError(
      'website_removal_scope_unavailable',
      'Website removal scope could not be verified',
      503,
    );
  }
  return actor;
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

export function mountWebsiteRemovalRoutes(app, {
  runtime,
  siteMutationLock = null,
  websiteRegistry = null,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!runtime || typeof runtime.preview !== 'function' || typeof runtime.start !== 'function'
    || typeof runtime.continueStep !== 'function' || typeof runtime.get !== 'function'
    || typeof runtime.listForWebsite !== 'function') {
    throw new Error('Website removal runtime is required');
  }

  async function withOptionalLock(websiteId, action) {
    if (!siteMutationLock || runtime?.hasSiteMutationLock) {
      return action();
    }
    if (typeof siteMutationLock.withSiteLock !== 'function') {
      throw new WebsiteRemovalHttpError(
        'website_removal_lock_unavailable',
        'Site mutation lock is unavailable.',
        503,
      );
    }
    return siteMutationLock.withSiteLock({ websiteId }, action);
  }

  app.get('/api/website-removal-operations', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const actor = removalActor(request);
    const actorTenant = extractActorTenant(request.auth);
    if (!actorTenant.active) {
      throw new WebsiteRemovalHttpError('tenant_actor_inactive', 'Inactive account cannot access tenant resources.', 403);
    }
    const operations = typeof runtime.list === 'function' ? await runtime.list() : [];
    const filtered = actor.role === 'owner'
      ? operations
      : operations.filter((op) => actorTenant.websiteIds.includes(op.websiteId));
    response.set('Cache-Control', 'no-store');
    response.json({ data: filtered });
  }));

  app.get('/api/website-removal-operations/:operationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const operation = await runtime.get(request.params.operationId);
    if (!operation) {
      throw removalNotFound();
    }
    await requireWebsiteAccess(request, operation.websiteId, { websiteRegistry, localServerId, allowDeleted: true });
    response.set('Cache-Control', 'no-store');
    response.json({ data: operation });
  }));

  app.post('/api/website-removal-operations/:operationId/continue', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const operation = await runtime.get(request.params.operationId);
    if (!operation) {
      throw removalNotFound();
    }
    const actor = await requireWebsiteAccess(request, operation.websiteId, { websiteRegistry, localServerId, allowDeleted: true });
    const body = continueStepBody(request.body);
    const updated = await withOptionalLock(operation.websiteId, () => runtime.continueStep({
      websiteId: operation.websiteId,
      operationId: operation.id,
      expectedUpdatedAt: body.expectedUpdatedAt,
      stepId: body.stepId,
      confirmation: body.confirmation,
      actor,
    }));
    response.set('Cache-Control', 'no-store');
    response.json({ data: updated });
  }));

  app.get('/api/websites/:websiteId/removal', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    await requireWebsiteAccess(request, websiteId, { websiteRegistry, localServerId });
    const [preview, operations] = await Promise.all([
      runtime.preview({ websiteId }),
      runtime.listForWebsite(websiteId),
    ]);
    const data = { preview, operations };
    response.set('Cache-Control', 'no-store');
    response.json({ preview, operations, data });
  }));

  app.post('/api/websites/:websiteId/removal-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    await requireWebsiteAccess(request, websiteId, { websiteRegistry, localServerId });
    const preview = await runtime.preview({ websiteId });
    response.set('Cache-Control', 'no-store');
    response.json({ preview, data: preview });
  }));

  app.post('/api/websites/:websiteId/removal', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    const actor = await requireWebsiteAccess(request, websiteId, { websiteRegistry, localServerId });
    const body = startBody(request.body);
    const operation = await withOptionalLock(websiteId, () => runtime.start({
      websiteId,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
      actor,
    }));
    response.status(201).json({ operation, data: operation });
  }));

  app.get('/api/websites/:websiteId/removal-operations', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId } = request.params;
    await requireWebsiteAccess(request, websiteId, { websiteRegistry, localServerId, allowDeleted: true });
    const operations = await runtime.listForWebsite(websiteId);
    response.set('Cache-Control', 'no-store');
    response.json({ operations, data: operations });
  }));

  app.get('/api/websites/:websiteId/removal-operations/:operationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId, operationId } = request.params;
    await requireWebsiteAccess(request, websiteId, { websiteRegistry, localServerId, allowDeleted: true });
    const operation = await runtime.get(operationId);
    if (!operation || operation.websiteId !== websiteId) {
      throw removalNotFound();
    }
    response.json({ operation, data: operation });
  }));

  app.post('/api/websites/:websiteId/removal-operations/:operationId/continue', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { websiteId, operationId } = request.params;
    const actor = await requireWebsiteAccess(request, websiteId, { websiteRegistry, localServerId, allowDeleted: true });
    const body = continueStepBody(request.body);
    const operation = await withOptionalLock(websiteId, () => runtime.continueStep({
      websiteId,
      operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      stepId: body.stepId,
      confirmation: body.confirmation,
      actor,
    }));
    response.json({ operation, data: operation });
  }));
}

export const websiteRemovalHttpInternals = Object.freeze({
  exactBody,
  startBody,
  continueStepBody,
  removalActor,
  requireWebsiteAccess,
  removalNotFound,
});
