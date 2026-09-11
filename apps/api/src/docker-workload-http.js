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

export function mountDockerWorkloadRoutes(app, { dockerWorkloadRegistry, localServerId = null } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!dockerWorkloadRegistry || typeof dockerWorkloadRegistry.createWorkload !== 'function'
    || typeof dockerWorkloadRegistry.getWorkload !== 'function' || typeof dockerWorkloadRegistry.listWorkloads !== 'function') {
    throw new Error('Docker workload registry is required');
  }

  app.get('/api/docker/workloads', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const filter = listFilter(request.query);
    if (localServerId && filter.serverId && filter.serverId !== localServerId) {
      throw new DockerWorkloadRegistryError('local_server_required', 'Docker workloads can be listed only for this panel host', 404);
    }
    return response.json({ data: await dockerWorkloadRegistry.listWorkloads({ serverId: localServerId ?? filter.serverId }) });
  }));
  app.get('/api/docker/workloads/:dockerWorkloadId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const workload = await dockerWorkloadRegistry.getWorkload(request.params.dockerWorkloadId);
    if (!workload || (localServerId && workload.serverId !== localServerId)) throw new DockerWorkloadRegistryError('docker_workload_not_found', 'Docker workload was not found', 404);
    return response.json({ data: workload });
  }));
  app.post('/api/docker/workloads', requirePanelRouteAccess, asyncRoute(async (request, response) => {
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
}

export const dockerWorkloadHttpInternals = Object.freeze({ createInput, listFilter, emptyQuery });
