import { requirePanelRouteAccess } from './panel-http-guard.js';

export class WebsiteProvisioningHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteProvisioningHttpError';
    this.code = code;
    this.status = status;
  }
}

function operationId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new WebsiteProvisioningHttpError('website_provisioning_operation_invalid', 'Website provisioning operation id is invalid');
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

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountWebsiteProvisioningRoutes(app, { registry, orchestrator } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || !registry || typeof registry.get !== 'function'
    || !orchestrator || typeof orchestrator.runNext !== 'function'
    || typeof orchestrator.retryStep !== 'function'
    || typeof orchestrator.compensateStep !== 'function') {
    throw new Error('Website provisioning HTTP dependencies are required');
  }

  app.get('/api/sites/provisioning/:operationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const id = operationId(request.params.operationId);
    const operation = await registry.get(id);
    if (!operation) {
      throw new WebsiteProvisioningHttpError(
        'website_provisioning_not_found',
        'Website provisioning operation was not found',
        404,
      );
    }
    return response.json({ data: operation });
  }));

  app.post('/api/sites/provisioning/:operationId/continue', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const id = operationId(request.params.operationId);
    continueBody(request.body, id);
    const result = await orchestrator.runNext(id);
    const status = ['progressed', 'reconciled'].includes(result.outcome) && !result.operation.ready ? 202 : 200;
    return response.status(status).json({ data: result });
  }));

  app.post('/api/sites/provisioning/:operationId/steps/:stepId/retry', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const id = operationId(request.params.operationId);
    const provisioningStepId = stepId(request.params.stepId);
    retryBody(request.body, id, provisioningStepId);
    const result = await orchestrator.retryStep(id, provisioningStepId);
    const status = ['progressed', 'reconciled'].includes(result.outcome) && !result.operation.ready ? 202 : 200;
    return response.status(status).json({ data: result });
  }));

  app.post('/api/sites/provisioning/:operationId/steps/:stepId/compensate', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const id = operationId(request.params.operationId);
    const provisioningStepId = stepId(request.params.stepId);
    compensateBody(request.body, id, provisioningStepId);
    const result = await orchestrator.compensateStep(id, provisioningStepId);
    return response.status(200).json({ data: result });
  }));
}

export const websiteProvisioningHttpInternals = Object.freeze({
  operationId,
  stepId,
  continueBody,
  retryBody,
  compensateBody,
});
