import { currentAuditActorId } from './audit-request-context.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

// Users of password-protected directories (nginxSettings.protectedPaths). Domain
// ownership for site-scoped roles is enforced by the site resource boundary on
// /api/domains/:id; this module checks the server, the Domain state and that the
// key belongs to the Domain. Passwords go straight to the host manager.
export class ProtectedPathHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ProtectedPathHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountProtectedPathRoutes(app, { domainRegistry, protectedPathAuthManager, localServerId = null, audit = null } = {}) {
  if (!app || !domainRegistry || !protectedPathAuthManager) throw new Error('Protected path routes require a Domain registry and the auth manager');

  async function localDomain(domainId) {
    const domain = await domainRegistry.getDomain(domainId).catch(() => null);
    if (!domain || (localServerId && domain.serverId !== localServerId)) {
      throw new ProtectedPathHttpError('domain_not_found', 'Domain was not found on this panel host', 404);
    }
    return domain;
  }

  function protectedPath(domain, key) {
    const entry = (domain.nginxSettings?.protectedPaths ?? []).find(item => item.key === key);
    if (!entry) throw new ProtectedPathHttpError('protected_path_not_found', 'This directory is not protected on the Domain', 404);
    return entry;
  }

  async function record(action, domain, outcome, code = null) {
    if (!audit || typeof audit.record !== 'function') return;
    await audit.record({ actorId: currentAuditActorId() ?? 'unknown', action, resourceType: 'domain', resourceId: domain.id, outcome, code });
  }

  async function mutate(request, action, operation) {
    const domain = await localDomain(request.params.domainId);
    if (domain.state === 'suspended') throw new ProtectedPathHttpError('domain_suspended', 'A suspended Domain cannot be changed', 409);
    const entry = protectedPath(domain, request.params.key);
    try {
      const result = await operation({ domain: domain.primaryDomain, key: entry.key, username: request.params.username });
      await record(action, domain, 'success');
      return result;
    } catch (error) {
      await record(action, domain, 'failure', typeof error?.code === 'string' ? error.code : 'protected_path_failed');
      throw error;
    }
  }

  app.get('/api/domains/:domainId/protected-paths', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const domain = await localDomain(request.params.domainId);
    const paths = [];
    for (const entry of domain.nginxSettings?.protectedPaths ?? []) {
      paths.push({ path: entry.path, key: entry.key, users: await protectedPathAuthManager.listUsers({ domain: domain.primaryDomain, key: entry.key }) });
    }
    response.setHeader('cache-control', 'no-store');
    return response.json({ data: { paths } });
  }));

  app.put('/api/domains/:domainId/protected-paths/:key/users/:username', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.password !== 'string') {
      throw new ProtectedPathHttpError('invalid_protected_path_password', 'Send exactly one password field');
    }
    const result = await mutate(request, 'domain.protected_path.user.set',
      (target) => protectedPathAuthManager.setUser({ ...target, password: body.password }));
    return response.json({ data: result });
  }));

  app.delete('/api/domains/:domainId/protected-paths/:key/users/:username', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    await mutate(request, 'domain.protected_path.user.remove', (target) => protectedPathAuthManager.removeUser(target));
    return response.json({ data: { removed: request.params.username } });
  }));

  // Host manager validation errors carry their own 4xx status.
  app.use('/api/domains/:domainId/protected-paths', (error, request, response, next) => {
    if (typeof error?.status === 'number' && error.status >= 400 && error.status < 600 && typeof error.code === 'string') {
      return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    return next(error);
  });
}
