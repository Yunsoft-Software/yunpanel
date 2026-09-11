import { requirePanelRouteAccess } from './panel-http-guard.js';
import { previewResourceImpact, ResourceImpactError } from './resource-impact.js';

const DELETE_FIELDS = new Set(['operation']);
const MOVE_FIELDS = new Set(['operation', 'targetServerId']);

function impactInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ResourceImpactError('impact_input_invalid', 'Send a documented impact preview input');
  }
  const fields = body.operation === 'move' ? MOVE_FIELDS : DELETE_FIELDS;
  if (Object.keys(body).length !== fields.size || Object.keys(body).some((key) => !fields.has(key))) {
    throw new ResourceImpactError('impact_input_invalid', 'Delete accepts only operation; move also requires targetServerId');
  }
  return Object.freeze({ operation: body.operation, targetServerId: body.targetServerId ?? null });
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountResourceImpactRoutes(app, dependencies = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  const handler = (resourceType, parameter) => asyncRoute(async (request, response) => {
    const input = impactInput(request.body);
    if (dependencies.localServerId && input.operation === 'move') {
      throw new ResourceImpactError('local_server_only', 'Resources cannot be moved to another server from a local panel', 409);
    }
    if (dependencies.localServerId) {
      const registry = resourceType === 'website' ? dependencies.websiteRegistry : dependencies.domainRegistry;
      const method = resourceType === 'website' ? 'getWebsite' : 'getDomain';
      const resource = await registry[method](request.params[parameter]);
      if (!resource || resource.serverId !== dependencies.localServerId) {
        throw new ResourceImpactError(`${resourceType}_not_found`, `${resourceType === 'website' ? 'Website' : 'Domain'} not found`, 404);
      }
    }
    const preview = await previewResourceImpact({
      resourceType,
      resourceId: request.params[parameter],
      operation: input.operation,
      targetServerId: input.targetServerId,
      ...dependencies,
    });
    return response.json({ data: preview });
  });

  app.post('/api/websites/:websiteId/impact-preview', requirePanelRouteAccess, handler('website', 'websiteId'));
  app.post('/api/domains/:domainId/impact-preview', requirePanelRouteAccess, handler('domain', 'domainId'));
}

export const resourceImpactHttpInternals = Object.freeze({ impactInput });
