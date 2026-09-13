import { DockerComposeValidationError } from '@yunpanel/host-runtime';
import { DockerComposeProjectRegistryError } from './docker-compose-project-registry.js';
import { DockerComposeEnvironmentRegistryError } from './docker-compose-environment-registry.js';
import { DockerRegistryCredentialRegistryError } from './docker-registry-credential-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

export class DockerComposeHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerComposeHttpError';
    this.code = code;
    this.status = status;
  }
}

const KNOWN_ERRORS = Object.freeze([
  DockerComposeValidationError,
  DockerComposeProjectRegistryError,
  DockerComposeEnvironmentRegistryError,
  DockerRegistryCredentialRegistryError,
]);

function exactBody(body, fields, message) {
  const keys = Object.keys(body ?? {});
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new DockerComposeHttpError('docker_compose_input_invalid', message);
  }
  return body;
}

function optionalEmptyBody(body) {
  if (body === undefined || body === null) return;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new DockerComposeHttpError('docker_compose_input_invalid', 'Request body must be empty');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (error instanceof DockerComposeHttpError) {
        return response.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
      return next(error);
    }
  };
}

async function safeCall(callback) {
  try { return await callback(); }
  catch (error) {
    if (KNOWN_ERRORS.some((Type) => error instanceof Type)) {
      throw new DockerComposeHttpError(error.code, error.message, error.status ?? 400);
    }
    throw error;
  }
}

function requireLocalServer(serverId, localServerId) {
  if (typeof serverId !== 'string' || !serverId) {
    throw new DockerComposeHttpError('invalid_server_id', 'serverId is required');
  }
  if (localServerId && serverId !== localServerId) {
    throw new DockerComposeHttpError('local_server_required', 'Docker Compose projects can be managed only on this panel host', 404);
  }
  return localServerId ?? serverId;
}

async function requireProject(projectRegistry, projectId, localServerId) {
  const project = await safeCall(() => projectRegistry.getProject(projectId));
  if (!project || (localServerId && project.serverId !== localServerId)) {
    throw new DockerComposeHttpError('docker_compose_project_not_found', 'Docker Compose project was not found', 404);
  }
  return project;
}

export function mountDockerComposeRoutes(app, {
  dockerComposeProjectRegistry,
  dockerComposeEnvironmentRegistry,
  dockerRegistryCredentialRegistry,
  validateDockerCompose,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.put !== 'function') {
    throw new Error('Express application is required');
  }
  if (!dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.createProject !== 'function'
    || typeof dockerComposeProjectRegistry.updateProject !== 'function'
    || typeof dockerComposeProjectRegistry.getProject !== 'function'
    || typeof dockerComposeProjectRegistry.listProjects !== 'function'
    || typeof dockerComposeProjectRegistry.materializeProject !== 'function') {
    throw new Error('Docker Compose project registry is required');
  }
  if (!dockerComposeEnvironmentRegistry || typeof dockerComposeEnvironmentRegistry.getEnvironment !== 'function'
    || typeof dockerComposeEnvironmentRegistry.replaceEnvironment !== 'function'
    || typeof dockerComposeEnvironmentRegistry.materializeEnvironment !== 'function') {
    throw new Error('Docker Compose environment registry is required');
  }
  if (!dockerRegistryCredentialRegistry || typeof dockerRegistryCredentialRegistry.listCredentials !== 'function'
    || typeof dockerRegistryCredentialRegistry.setCredential !== 'function') {
    throw new Error('Docker registry credential registry is required');
  }
  if (typeof validateDockerCompose !== 'function') throw new Error('Docker Compose validator is required');

  app.get('/api/docker/projects', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    if (Object.keys(request.query ?? {}).length !== 0) {
      throw new DockerComposeHttpError('docker_compose_query_invalid', 'Docker Compose project list does not accept query parameters');
    }
    const projects = await safeCall(() => dockerComposeProjectRegistry.listProjects({ serverId: localServerId }));
    return response.json({ data: projects });
  }));

  app.get('/api/docker/projects/:dockerProjectId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    if (Object.keys(request.query ?? {}).length !== 0) {
      throw new DockerComposeHttpError('docker_compose_query_invalid', 'Docker Compose project detail does not accept query parameters');
    }
    const project = await requireProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    const [environment, credentials] = await Promise.all([
      safeCall(() => dockerComposeEnvironmentRegistry.getEnvironment(project.id)),
      safeCall(() => dockerRegistryCredentialRegistry.listCredentials({ projectId: project.id })),
    ]);
    return response.json({ data: { project, environment, credentials } });
  }));

  app.post('/api/docker/projects/validate', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(
      request.body,
      ['serverId', 'projectName', 'document', 'environment'],
      'Send serverId, projectName, document and environment',
    );
    requireLocalServer(body.serverId, localServerId);
    const validation = await safeCall(() => validateDockerCompose({
      projectName: body.projectName,
      document: body.document,
      environment: body.environment,
      interpolate: true,
    }));
    return response.json({ data: validation, sideEffects: false });
  }));

  app.post('/api/docker/projects', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(
      request.body,
      ['serverId', 'projectName', 'document'],
      'Send serverId, projectName and document',
    );
    const serverId = requireLocalServer(body.serverId, localServerId);
    const validation = await safeCall(() => validateDockerCompose({
      projectName: body.projectName,
      document: body.document,
      environment: {},
      interpolate: false,
    }));
    const project = await safeCall(() => dockerComposeProjectRegistry.createProject({
      serverId,
      projectName: body.projectName,
      document: body.document,
      validation,
    }));
    const environment = await safeCall(() => dockerComposeEnvironmentRegistry.getEnvironment(project.id));
    return response.status(201).json({ data: { project, environment }, sideEffects: false });
  }));

  app.put('/api/docker/projects/:dockerProjectId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(request.body, ['expectedRevision', 'document'], 'Send expectedRevision and document');
    const current = await requireProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    const validation = await safeCall(() => validateDockerCompose({
      projectName: current.projectName,
      document: body.document,
      environment: {},
      interpolate: false,
    }));
    const project = await safeCall(() => dockerComposeProjectRegistry.updateProject(current.id, {
      expectedRevision: body.expectedRevision,
      document: body.document,
      validation,
    }));
    return response.json({ data: project, sideEffects: false });
  }));

  app.get('/api/docker/projects/:dockerProjectId/environment', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const project = await requireProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    return response.json({ data: await safeCall(() => dockerComposeEnvironmentRegistry.getEnvironment(project.id)) });
  }));

  app.put('/api/docker/projects/:dockerProjectId/environment', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(request.body, ['expectedRevision', 'variables'], 'Send expectedRevision and variables');
    const project = await requireProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    const desired = await safeCall(() => dockerComposeProjectRegistry.materializeProject(project.id, {
      expectedRevision: project.revision,
    }));
    await safeCall(() => validateDockerCompose({
      projectName: project.projectName,
      document: desired.document,
      environment: body.variables,
      interpolate: true,
    }));
    const environment = await safeCall(() => dockerComposeEnvironmentRegistry.replaceEnvironment(project.id, {
      expectedRevision: body.expectedRevision,
      variables: body.variables,
    }));
    return response.json({ data: environment, sideEffects: false });
  }));

  app.post('/api/docker/projects/:dockerProjectId/validate', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    optionalEmptyBody(request.body);
    const project = await requireProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    const [desired, environment] = await Promise.all([
      safeCall(() => dockerComposeProjectRegistry.materializeProject(project.id, { expectedRevision: project.revision })),
      safeCall(() => dockerComposeEnvironmentRegistry.materializeEnvironment(project.id)),
    ]);
    const validation = await safeCall(() => validateDockerCompose({
      projectName: project.projectName,
      document: desired.document,
      environment: environment.variables,
      interpolate: true,
    }));
    return response.json({
      data: {
        validation,
        projectRevision: project.revision,
        environmentRevision: environment.revision,
      },
      sideEffects: false,
    });
  }));

  app.get('/api/docker/projects/:dockerProjectId/credentials', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const project = await requireProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    return response.json({ data: await safeCall(() => dockerRegistryCredentialRegistry.listCredentials({ projectId: project.id })) });
  }));

  app.put('/api/docker/projects/:dockerProjectId/credentials', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(
      request.body,
      ['registryHost', 'expectedRevision', 'username', 'secret'],
      'Send registryHost, expectedRevision, username and secret',
    );
    const project = await requireProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    const credential = await safeCall(() => dockerRegistryCredentialRegistry.setCredential(project.id, body));
    return response.json({ data: credential, sideEffects: false });
  }));
}

export const dockerComposeHttpInternals = Object.freeze({
  exactBody,
  optionalEmptyBody,
  requireLocalServer,
  requireProject,
});
