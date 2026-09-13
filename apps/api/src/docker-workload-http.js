import path from 'node:path';
import { createDockerComposeValidator } from '@yunpanel/host-runtime';
import { createDockerComposeEnvironmentRegistry } from './docker-compose-environment-registry.js';
import { mountDockerComposeRoutes } from './docker-compose-http.js';
import { createDockerComposeProjectRegistry } from './docker-compose-project-registry.js';
import { createDockerRegistryCredentialRegistry } from './docker-registry-credential-registry.js';
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

function defaultComposeDependencies({ localServerId, env, cwd }) {
  const projectStorePath = env.YUNPANEL_DOCKER_COMPOSE_PROJECT_STORE
    ?? path.resolve(cwd, '.data/docker-compose-project-registry.json');
  const environmentStorePath = env.YUNPANEL_DOCKER_COMPOSE_ENVIRONMENT_STORE
    ?? path.resolve(cwd, '.data/docker-compose-environment-registry.json');
  const credentialStorePath = env.YUNPANEL_DOCKER_REGISTRY_CREDENTIAL_STORE
    ?? path.resolve(cwd, '.data/docker-registry-credential-registry.json');
  const dockerComposeProjectRegistry = createDockerComposeProjectRegistry({
    filePath: projectStorePath,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY,
    serverExists: async (serverId) => localServerId ? serverId === localServerId : true,
  });
  const projectExists = async (projectId) => Boolean(await dockerComposeProjectRegistry.getProject(projectId));
  const dockerComposeEnvironmentRegistry = createDockerComposeEnvironmentRegistry({
    filePath: environmentStorePath,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY,
    projectExists,
  });
  const dockerRegistryCredentialRegistry = createDockerRegistryCredentialRegistry({
    filePath: credentialStorePath,
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY,
    projectExists,
  });
  return Object.freeze({
    dockerComposeProjectRegistry,
    dockerComposeEnvironmentRegistry,
    dockerRegistryCredentialRegistry,
    validateDockerCompose: createDockerComposeValidator(),
  });
}

function composeDependencies(options) {
  const provided = [
    options.dockerComposeProjectRegistry,
    options.dockerComposeEnvironmentRegistry,
    options.dockerRegistryCredentialRegistry,
    options.validateDockerCompose,
  ].filter((value) => value !== null && value !== undefined).length;
  if (provided !== 0 && provided !== 4) {
    throw new Error('Docker Compose desired-state dependencies must be provided together');
  }
  if (provided === 4) {
    return Object.freeze({
      dockerComposeProjectRegistry: options.dockerComposeProjectRegistry,
      dockerComposeEnvironmentRegistry: options.dockerComposeEnvironmentRegistry,
      dockerRegistryCredentialRegistry: options.dockerRegistryCredentialRegistry,
      validateDockerCompose: options.validateDockerCompose,
    });
  }
  return defaultComposeDependencies(options);
}

export function mountDockerWorkloadRoutes(app, {
  dockerWorkloadRegistry,
  localServerId = null,
  dockerComposeProjectRegistry = null,
  dockerComposeEnvironmentRegistry = null,
  dockerRegistryCredentialRegistry = null,
  validateDockerCompose = null,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!dockerWorkloadRegistry || typeof dockerWorkloadRegistry.createWorkload !== 'function'
    || typeof dockerWorkloadRegistry.getWorkload !== 'function' || typeof dockerWorkloadRegistry.listWorkloads !== 'function') {
    throw new Error('Docker workload registry is required');
  }

  if (typeof app.put === 'function') {
    const managed = composeDependencies({
      localServerId,
      dockerComposeProjectRegistry,
      dockerComposeEnvironmentRegistry,
      dockerRegistryCredentialRegistry,
      validateDockerCompose,
      env,
      cwd,
    });
    mountDockerComposeRoutes(app, { ...managed, localServerId });
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

export const dockerWorkloadHttpInternals = Object.freeze({
  createInput,
  listFilter,
  emptyQuery,
  defaultComposeDependencies,
  composeDependencies,
});
