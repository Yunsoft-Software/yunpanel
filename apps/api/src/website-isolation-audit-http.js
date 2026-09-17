import { requirePanelRouteAccess } from './panel-http-guard.js';
import { WebsiteIsolationAuditError } from './website-isolation-audit.js';
import { WebsiteIsolationMigrationRuntimeError } from './website-isolation-migration-runtime.js';
import { WebsiteRegistryError } from './website-registry.js';

const APPLY_FIELDS = new Set(['expectedPreviewDigest', 'confirmation']);
const ROLLBACK_FIELDS = new Set(['confirmation']);

function mappedAuditError(error) {
  if (error instanceof WebsiteIsolationAuditError) {
    return new WebsiteRegistryError(error.code, error.message, error.status);
  }
  if (error instanceof WebsiteIsolationMigrationRuntimeError) {
    return new WebsiteRegistryError(error.code, error.message, error.status);
  }
  return error;
}

function exactBody(value, fields, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))) {
    throw new WebsiteRegistryError(code, message, 400);
  }
  return value;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(mappedAuditError(error)); }
  };
}

async function requireLocalWebsite(websiteRegistry, websiteId, localServerId) {
  const website = await websiteRegistry.getWebsite(websiteId);
  if (!website || (localServerId && website.serverId !== localServerId)) {
    throw new WebsiteRegistryError('website_not_found', 'Website not found', 404);
  }
  return website;
}

export function mountWebsiteIsolationAuditRoutes(app, {
  auditService,
  websiteRegistry = null,
  localServerId = null,
  migrationRuntime = null,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('Express application is required');
  if (!auditService || typeof auditService.audit !== 'function') {
    throw new Error('Website isolation audit service is required');
  }
  if (websiteRegistry !== null && typeof websiteRegistry.getWebsite !== 'function') {
    throw new Error('Website registry isolation audit scope is invalid');
  }
  if (migrationRuntime !== null && (
    typeof app.post !== 'function'
    || typeof migrationRuntime.start !== 'function'
    || typeof migrationRuntime.rollback !== 'function'
    || typeof migrationRuntime.get !== 'function'
    || typeof migrationRuntime.listForWebsite !== 'function'
  )) throw new Error('Website isolation migration runtime is invalid');

  app.get('/api/websites/:websiteId/isolation-audit', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const websiteId = websiteRegistry
      ? (await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId)).id
      : request.params.websiteId;
    const audit = await auditService.audit(websiteId);
    return response.json({ data: audit });
  }));

  if (migrationRuntime) {
    app.get('/api/websites/:websiteId/isolation-migrations', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const websiteId = websiteRegistry
        ? (await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId)).id
        : request.params.websiteId;
      return response.json({ data: await migrationRuntime.listForWebsite(websiteId) });
    }));

    app.post('/api/websites/:websiteId/isolation-migrations', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const websiteId = websiteRegistry
        ? (await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId)).id
        : request.params.websiteId;
      const body = exactBody(
        request.body,
        APPLY_FIELDS,
        'website_isolation_migration_input_invalid',
        'Send exactly expectedPreviewDigest and confirmation to apply Website isolation migration',
      );
      const result = await migrationRuntime.start({
        websiteId,
        previewDigest: body.expectedPreviewDigest,
        confirmation: body.confirmation,
      });
      return response.status(result.status === 'applying' ? 202 : 200).json({ data: result });
    }));

    app.get('/api/websites/:websiteId/isolation-migrations/:operationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const websiteId = websiteRegistry
        ? (await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId)).id
        : request.params.websiteId;
      const result = await migrationRuntime.get(request.params.operationId);
      if (result.websiteId !== websiteId) throw new WebsiteRegistryError('website_isolation_migration_not_found', 'Website isolation migration was not found', 404);
      return response.json({ data: result });
    }));

    app.post('/api/websites/:websiteId/isolation-migrations/:operationId/rollback', requirePanelRouteAccess, asyncRoute(async (request, response) => {
      const websiteId = websiteRegistry
        ? (await requireLocalWebsite(websiteRegistry, request.params.websiteId, localServerId)).id
        : request.params.websiteId;
      const current = await migrationRuntime.get(request.params.operationId);
      if (current.websiteId !== websiteId) throw new WebsiteRegistryError('website_isolation_migration_not_found', 'Website isolation migration was not found', 404);
      const body = exactBody(
        request.body,
        ROLLBACK_FIELDS,
        'website_isolation_migration_rollback_input_invalid',
        'Send exactly confirmation to roll back Website isolation migration',
      );
      return response.json({ data: await migrationRuntime.rollback({
        operationId: current.id,
        confirmation: body.confirmation,
      }) });
    }));
  }
}

export const websiteIsolationAuditHttpInternals = Object.freeze({
  mappedAuditError,
  requireLocalWebsite,
  exactBody,
});
