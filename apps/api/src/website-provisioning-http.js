import { requirePanelRouteAccess } from './panel-http-guard.js';
import { mountWebsiteIsolationAuditRoutes } from './website-isolation-audit-http.js';
import { canBeginCompensationInOrder } from './website-provisioning-compensation-order.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WebsiteProvisioningHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteProvisioningHttpError';
    this.code = code;
    this.status = status;
  }
}

function operationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new WebsiteProvisioningHttpError('website_provisioning_operation_invalid', 'Website provisioning operation id is invalid');
  }
  return value.toLowerCase();
}

function websiteId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new WebsiteProvisioningHttpError('website_provisioning_website_invalid', 'Website id is invalid');
  }
  return value.toLowerCase();
}

function stepId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,80}$/.test(value)) {
    throw new WebsiteProvisioningHttpError('website_provisioning_step_invalid', 'Website provisioning step id is invalid');
  }
  return value;
}

function continueBody(body, id) {
  const expected = `continue-site-provisioning:${id}`;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || body.confirmation !== expected) {
    throw new WebsiteProvisioningHttpError(
      'website_provisioning_confirmation_required',
      `Confirm provisioning continuation with ${expected}`,
    );
  }
  return expected;
}

function retryBody(body, id, provisioningStepId) {
  const expected = `retry-site-provisioning:${id}:${provisioningStepId}`;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || body.confirmation !== expected) {
    throw new WebsiteProvisioningHttpError(
      'website_provisioning_retry_confirmation_required',
      `Confirm provisioning retry with ${expected}`,
    );
  }
  return expected;
}

function compensateBody(body, id, provisioningStepId) {
  const expected = `compensate-site-provisioning:${id}:${provisioningStepId}`;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || body.confirmation !== expected) {
    throw new WebsiteProvisioningHttpError(
      'website_provisioning_compensation_confirmation_required',
      `Confirm provisioning compensation with ${expected}`,
    );
  }
  return expected;
}

function publicCompensation(compensation) {
  return Object.freeze({
    state: typeof compensation?.state === 'string' ? compensation.state : 'not_required',
    error: typeof compensation?.error === 'string' ? compensation.error : null,
  });
}

function publicStep(operation, step, supportsCompensation = () => false) {
  const compensation = publicCompensation(step.compensation);
  return Object.freeze({
    id: step.id,
    kind: step.kind,
    required: step.required !== false,
    state: step.state,
    error: typeof step.error === 'string' ? step.error : null,
    compensation,
    canRetry: step.state === 'failed' && ['pending', 'not_required'].includes(compensation.state),
    canCompensate: ['succeeded', 'failed'].includes(step.state)
      && ['pending', 'failed'].includes(compensation.state)
      && canBeginCompensationInOrder(operation, step.id)
      && supportsCompensation(step.kind) === true,
  });
}

function publicOperation(operation, supportsCompensation = () => false) {
  if (!operation) return null;
  return Object.freeze({
    operationId: operation.operationId,
    websiteId: operation.websiteId,
    ready: operation.ready === true,
    status: operation.status,
    progress: operation.progress && typeof operation.progress === 'object'
      ? Object.freeze({
        required: operation.progress.required,
        completed: operation.progress.completed,
        remaining: operation.progress.remaining,
      })
      : null,
    createdAt: operation.createdAt ?? null,
    updatedAt: operation.updatedAt ?? null,
    steps: Object.freeze((operation.steps ?? []).map((step) => publicStep(operation, step, supportsCompensation))),
  });
}

function publicResult(result, supportsCompensation = () => false) {
  return Object.freeze({
    operationId: result?.operation?.operationId ?? result?.operationId ?? null,
    outcome: result?.outcome ?? null,
    stepId: result?.stepId ?? null,
    actionRequired: typeof result?.actionRequired === 'string' ? result.actionRequired : null,
    error: typeof result?.error === 'string' ? result.error : null,
    operation: publicOperation(result?.operation ?? null, supportsCompensation),
  });
}

function requestActor(request) {
  const sessionId = request.auth?.id;
  const userId = request.auth?.user?.id;
  const role = request.auth?.user?.role;
  if (typeof sessionId !== 'string' || typeof userId !== 'string'
    || !['owner', 'site_manager'].includes(role)) {
    throw new WebsiteProvisioningHttpError(
      'website_provisioning_actor_invalid',
      'Live Website provisioning session identity is required',
      403,
    );
  }
  return Object.freeze({ sessionId, userId, role });
}

function provisioningNotFound() {
  return new WebsiteProvisioningHttpError(
    'website_provisioning_not_found',
    'Website provisioning operation was not found',
    404,
  );
}

async function requireWebsiteAccess(request, targetWebsiteId, { websiteRegistry, localServerId } = {}) {
  const actor = requestActor(request);
  if (actor.role === 'owner') return actor;
  const auth = request.auth;
  if (auth?.access?.mode !== 'site_management' || auth?.security?.managementAllowed !== true
    || !Array.isArray(auth.user?.websiteIds) || !auth.user.websiteIds.includes(targetWebsiteId)) {
    throw provisioningNotFound();
  }
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new WebsiteProvisioningHttpError(
      'website_provisioning_scope_unavailable',
      'Website provisioning scope could not be verified',
      503,
    );
  }
  let website;
  try { website = await websiteRegistry.getWebsite(targetWebsiteId); }
  catch {
    throw new WebsiteProvisioningHttpError(
      'website_provisioning_scope_unavailable',
      'Website provisioning scope could not be verified',
      503,
    );
  }
  if (!website || website.id !== targetWebsiteId
    || (localServerId !== null && localServerId !== undefined && website.serverId !== localServerId)) {
    throw provisioningNotFound();
  }
  return actor;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountWebsiteProvisioningRoutes(app, {
  registry,
  orchestrator,
  isolationMigration = null,
  websiteRegistry = null,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || !registry || typeof registry.get !== 'function' || typeof registry.getLatestForWebsite !== 'function'
    || !orchestrator || typeof orchestrator.runNext !== 'function'
    || typeof orchestrator.retryStep !== 'function'
    || typeof orchestrator.compensateStep !== 'function'
    || typeof orchestrator.supportsCompensation !== 'function') {
    throw new Error('Website provisioning HTTP dependencies are required');
  }

  const projectOperation = (operation) => publicOperation(operation, orchestrator.supportsCompensation);
  const projectResult = (result) => publicResult(result, orchestrator.supportsCompensation);

  app.get('/api/sites/:websiteId/provisioning/latest', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const id = websiteId(request.params.websiteId);
    await requireWebsiteAccess(request, id, { websiteRegistry, localServerId });
    const operation = await registry.getLatestForWebsite(id);
    return response.json({ data: projectOperation(operation) });
  }));

  app.get('/api/sites/provisioning/:operationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const id = operationId(request.params.operationId);
    const operation = await registry.get(id);
    if (!operation) throw provisioningNotFound();
    await requireWebsiteAccess(request, operation.websiteId, { websiteRegistry, localServerId });
    return response.json({ data: projectOperation(operation) });
  }));

  if (typeof registry.auditIsolation === 'function') {
    mountWebsiteIsolationAuditRoutes(app, {
      auditService: Object.freeze({
        audit: (value) => registry.auditIsolation(websiteId(value)),
      }),
      ...(isolationMigration ? { migrationRuntime: isolationMigration } : {}),
      ...(websiteRegistry ? { websiteRegistry, localServerId } : {}),
    });
  }

  app.post('/api/sites/provisioning/:operationId/continue', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const id = operationId(request.params.operationId);
    continueBody(request.body, id);
    const operation = await registry.get(id);
    if (!operation) throw provisioningNotFound();
    const actor = await requireWebsiteAccess(request, operation.websiteId, { websiteRegistry, localServerId });
    const result = await orchestrator.runNext(id, actor);
    const status = ['progressed', 'reconciled'].includes(result.outcome) && !result.operation.ready ? 202 : 200;
    return response.status(status).json({ data: projectResult(result) });
  }));

  app.post('/api/sites/provisioning/:operationId/steps/:stepId/retry', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const id = operationId(request.params.operationId);
    const provisioningStepId = stepId(request.params.stepId);
    retryBody(request.body, id, provisioningStepId);
    const operation = await registry.get(id);
    if (!operation) throw provisioningNotFound();
    const actor = await requireWebsiteAccess(request, operation.websiteId, { websiteRegistry, localServerId });
    const result = await orchestrator.retryStep(id, provisioningStepId, actor);
    const status = ['progressed', 'reconciled'].includes(result.outcome) && !result.operation.ready ? 202 : 200;
    return response.status(status).json({ data: projectResult(result) });
  }));

  app.post('/api/sites/provisioning/:operationId/steps/:stepId/compensate', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const id = operationId(request.params.operationId);
    const provisioningStepId = stepId(request.params.stepId);
    compensateBody(request.body, id, provisioningStepId);
    const operation = await registry.get(id);
    if (!operation) throw provisioningNotFound();
    const actor = await requireWebsiteAccess(request, operation.websiteId, { websiteRegistry, localServerId });
    const result = await orchestrator.compensateStep(id, provisioningStepId, actor);
    return response.status(200).json({ data: projectResult(result) });
  }));
}

export const websiteProvisioningHttpInternals = Object.freeze({
  operationId,
  websiteId,
  stepId,
  continueBody,
  retryBody,
  compensateBody,
  publicOperation,
  publicResult,
  requestActor,
  requireWebsiteAccess,
});
