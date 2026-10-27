import { currentAuditActorId } from './audit-request-context.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

// Owner-only management of automation API keys. A key's secret is returned once, at creation.
function requireOwner(request, response, next) {
  const auth = request.auth;
  if (auth?.user?.role === 'owner' && auth.access?.mode === 'management') return next();
  return response.status(403).json({ error: { code: 'forbidden', message: 'Only the Owner can manage API keys.' } });
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountApiKeyRoutes(app, { apiKeyStore, audit = null } = {}) {
  if (!app || !apiKeyStore) throw new Error('API key routes require the key store');
  const record = async (action, resourceId) => {
    if (audit && typeof audit.record === 'function') {
      await audit.record({ actorId: currentAuditActorId() ?? 'unknown', action, resourceType: 'api_key', resourceId, outcome: 'success' });
    }
  };

  app.get('/api/api-keys', requirePanelRouteAccess, requireOwner, asyncRoute(async (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    return response.json({ data: { keys: await apiKeyStore.list() } });
  }));
  app.post('/api/api-keys', requirePanelRouteAccess, requireOwner, asyncRoute(async (request, response) => {
    const result = await apiKeyStore.create({ ...request.body, createdBy: request.auth.user.id });
    await record('api_key.create', result.key.id);
    response.setHeader('cache-control', 'no-store');
    return response.status(201).json({ data: result });
  }));
  app.delete('/api/api-keys/:keyId', requirePanelRouteAccess, requireOwner, asyncRoute(async (request, response) => {
    const key = await apiKeyStore.revoke(request.params.keyId);
    await record('api_key.revoke', key.id);
    return response.json({ data: key });
  }));
  app.use('/api/api-keys', (error, _request, response, next) => {
    if (error?.name === 'ApiKeyStoreError') return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return next(error);
  });
}
