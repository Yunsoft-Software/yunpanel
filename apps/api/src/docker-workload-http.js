import { DockerWorkloadRegistryError } from './docker-workload-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const CREATE_FIELDS = new Set(['serverId', 'name', 'managementMode', 'proxyTarget']);

function createInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== CREATE_FIELDS.size || Object.keys(body).some((key) => !CREATE_FIELDS.has(key))) {
    throw new DockerWorkloadRegistryError('docker_workload_input_invalid', 'Send serverId, name, managementMode and proxyTarget');
  }
  return body;
}

function listFilter(query) {
  if (Object.keys(query ?? {}).some((key) => key !== 'serverId') || Array.isArray(query?.serverId)) {
    throw new DockerWorkloadRegistryError('docker_workload_query_invalid', 'Docker workload list accepts only one serverId filter');
  }
  return { serverId: query?.serverId || null };
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new DockerWorkloadRegistryError('docker_workload_query_invalid', 'Docker workload detail does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function requireOwnerOrReadOnly(request, response, next) {
  const auth = request.auth;
  if (!auth?.user) {
    return response.status(401).json({ error: { code: 'unauthorized', message: 'Authenticated panel context is required.' } });
  }
  const role = auth.user.role;
  if (['site_manager', 'reseller', 'customer'].includes(role)
    || auth.user.hosting?.kind === 'reseller'
    || auth.user.hosting?.kind === 'customer') {
    return response.status(403).json({ error: { code: 'forbidden', message: 'Site-scoped role cannot access Docker workloads.' } });
  }
  return next();
}

function requireOwnerGateway(request, response, next) {
  const auth = request.auth;
  if (!auth?.user) {
    return response.status(401).json({ error: { code: 'unauthorized', message: 'Authenticated panel context is required.' } });
  }
  const role = auth.user.role;
  if (role !== 'owner') {
    return response.status(403).json({ error: { code: 'forbidden', message: 'Portainer adapter requires authenticated Owner access.' } });
  }
  if (auth.access && auth.access.mode !== 'management') {
    return response.status(403).json({ error: { code: 'forbidden', message: 'Portainer adapter requires management mode.' } });
  }
  if (auth.security && auth.security.managementAllowed === false) {
    return response.status(403).json({ error: { code: 'forbidden', message: 'Portainer adapter access is not allowed.' } });
  }
  return next();
}

export function mountDockerWorkloadRoutes(app, {
  dockerWorkloadRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!dockerWorkloadRegistry || typeof dockerWorkloadRegistry.createWorkload !== 'function'
    || typeof dockerWorkloadRegistry.getWorkload !== 'function' || typeof dockerWorkloadRegistry.listWorkloads !== 'function') {
    throw new Error('Docker workload registry is required');
  }

  app.get('/api/docker/workloads', requireOwnerOrReadOnly, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const filter = listFilter(request.query);
    if (localServerId && filter.serverId && filter.serverId !== localServerId) {
      throw new DockerWorkloadRegistryError('local_server_required', 'Docker workloads can be listed only for this panel host', 404);
    }
    return response.json({ data: await dockerWorkloadRegistry.listWorkloads({ serverId: localServerId ?? filter.serverId }) });
  }));

  app.get('/api/docker/workloads/:dockerWorkloadId', requireOwnerOrReadOnly, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const workload = await dockerWorkloadRegistry.getWorkload(request.params.dockerWorkloadId);
    if (!workload || (localServerId && workload.serverId !== localServerId)) throw new DockerWorkloadRegistryError('docker_workload_not_found', 'Docker workload was not found', 404);
    return response.json({ data: workload });
  }));

  app.post('/api/docker/workloads', requireOwnerOrReadOnly, requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = createInput(request.body);
    if (localServerId && body.serverId !== localServerId) {
      throw new DockerWorkloadRegistryError('local_server_required', 'Docker workloads can be created only on this panel host', 404);
    }
    const workload = await dockerWorkloadRegistry.createWorkload({ ...body, serverId: localServerId ?? body.serverId });
    return response.status(201).json({
      data: workload,
      sideEffects: Object.freeze({ containersChanged: false, nginxChanged: false }),
    });
  }));

  // Portainer adapter configuration / status
  app.get('/api/docker/portainer', requireOwnerGateway, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const adapter = typeof dockerWorkloadRegistry.getPortainerAdapter === 'function'
      ? await dockerWorkloadRegistry.getPortainerAdapter()
      : { enabled: false, adapter: 'portainer', directPortPublic: false };
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    return response.json({ data: adapter });
  }));

  app.post('/api/docker/portainer', requireOwnerGateway, asyncRoute(async (request, response) => {
    const body = request.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new DockerWorkloadRegistryError('portainer_input_invalid', 'Portainer configuration must be an object', 400);
    }
    if (body.directPortPublic === true) {
      throw new DockerWorkloadRegistryError('portainer_direct_port_public_forbidden', 'Portainer direct port must not be public', 400);
    }
    if (typeof dockerWorkloadRegistry.configurePortainerAdapter !== 'function') {
      throw new DockerWorkloadRegistryError('portainer_adapter_unavailable', 'Portainer adapter is not available', 503);
    }
    const serverId = localServerId ?? body.serverId;
    const adapter = await dockerWorkloadRegistry.configurePortainerAdapter({
      serverId,
      enabled: body.enabled !== false,
      endpoint: body.endpoint,
      token: body.token ?? body.credentials?.token ?? null,
      credentials: body.credentials ?? null,
      directPortPublic: false,
    });
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    return response.status(200).json({ data: adapter });
  }));

  app.put('/api/docker/portainer', requireOwnerGateway, asyncRoute(async (request, response) => {
    const body = request.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new DockerWorkloadRegistryError('portainer_input_invalid', 'Portainer configuration must be an object', 400);
    }
    if (body.directPortPublic === true) {
      throw new DockerWorkloadRegistryError('portainer_direct_port_public_forbidden', 'Portainer direct port must not be public', 400);
    }
    if (typeof dockerWorkloadRegistry.configurePortainerAdapter !== 'function') {
      throw new DockerWorkloadRegistryError('portainer_adapter_unavailable', 'Portainer adapter is not available', 503);
    }
    const serverId = localServerId ?? body.serverId;
    const adapter = await dockerWorkloadRegistry.configurePortainerAdapter({
      serverId,
      enabled: body.enabled !== false,
      endpoint: body.endpoint,
      token: body.token ?? body.credentials?.token ?? null,
      credentials: body.credentials ?? null,
      directPortPublic: false,
    });
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    return response.status(200).json({ data: adapter });
  }));

  app.delete('/api/docker/portainer', requireOwnerGateway, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    if (typeof dockerWorkloadRegistry.configurePortainerAdapter !== 'function') {
      throw new DockerWorkloadRegistryError('portainer_adapter_unavailable', 'Portainer adapter is not available', 503);
    }
    const adapter = await dockerWorkloadRegistry.configurePortainerAdapter({ enabled: false });
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    return response.json({ data: adapter });
  }));

  // Portainer gateway session creation
  const handleCreateSession = asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    if (typeof dockerWorkloadRegistry.getPortainerAdapter !== 'function'
      || typeof dockerWorkloadRegistry.createPortainerGatewaySession !== 'function') {
      throw new DockerWorkloadRegistryError('portainer_adapter_unavailable', 'Portainer adapter is not available', 503);
    }
    const adapter = await dockerWorkloadRegistry.getPortainerAdapter();
    if (!adapter?.enabled) {
      throw new DockerWorkloadRegistryError('portainer_adapter_disabled', 'Portainer adapter is not enabled', 409);
    }
    const session = await dockerWorkloadRegistry.createPortainerGatewaySession({
      ownerSessionId: request.auth?.id ?? request.auth?.user?.id,
      userId: request.auth?.user?.id,
      ttlMs: typeof request.body?.ttlMs === 'number' ? request.body.ttlMs : 3600_000,
    });
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    return response.status(201).json({ data: session });
  });

  app.post('/api/docker/portainer/session', requireOwnerGateway, handleCreateSession);
  app.post('/api/docker/portainer/gateway/session', requireOwnerGateway, handleCreateSession);
  app.post('/api/docker/portainer/sessions', requireOwnerGateway, handleCreateSession);

  // Gateway access checks
  const handleGatewayAccess = asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    if (typeof dockerWorkloadRegistry.getPortainerAdapter !== 'function') {
      throw new DockerWorkloadRegistryError('portainer_adapter_unavailable', 'Portainer adapter is not available', 503);
    }
    const adapter = await dockerWorkloadRegistry.getPortainerAdapter();
    if (!adapter?.enabled) {
      throw new DockerWorkloadRegistryError('portainer_adapter_disabled', 'Portainer adapter is not enabled', 409);
    }
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    return response.status(204).end();
  });

  app.get('/api/docker/portainer-gateway-access', requireOwnerGateway, handleGatewayAccess);
  app.get('/api/portainer-gateway-access', requireOwnerGateway, handleGatewayAccess);

  // Gateway session detail
  app.get('/api/docker/portainer/gateway/:sessionId', requireOwnerGateway, asyncRoute(async (request, response) => {
    if (typeof dockerWorkloadRegistry.authorizePortainerGatewaySession !== 'function') {
      throw new DockerWorkloadRegistryError('portainer_adapter_unavailable', 'Portainer adapter is not available', 503);
    }
    const session = dockerWorkloadRegistry.authorizePortainerGatewaySession(request.params.sessionId, {
      ownerSessionId: request.auth?.id ?? request.auth?.user?.id,
      userId: request.auth?.user?.id,
    });
    if (!session) {
      throw new DockerWorkloadRegistryError('portainer_gateway_session_not_found', 'Portainer gateway session was not found or has expired', 404);
    }
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    return response.json({
      data: {
        sessionId: session.id,
        audience: 'portainer',
        gatewayPath: `/api/docker/portainer/gateway/${session.id}`,
        endpoint: session.endpoint,
        directPortPublic: false,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
      },
    });
  }));
}

export const dockerWorkloadHttpInternals = Object.freeze({
  createInput,
  listFilter,
  emptyQuery,
  requireOwnerGateway,
  requireOwnerOrReadOnly,
});
