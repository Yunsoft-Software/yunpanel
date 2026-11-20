import { DockerComposeProjectRegistryError } from './docker-compose-project-registry.js';
import { DockerVolumeOperationsError } from './docker-volume-operations.js';
import { requireOwnerDockerAccess } from './domain-proxy-routes.js';
import { JobRegistryError } from './job-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

export class DockerVolumeHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerVolumeHttpError';
    this.code = code;
    this.status = status;
  }
}

const KNOWN_ERRORS = Object.freeze([
  DockerComposeProjectRegistryError,
  DockerVolumeOperationsError,
  JobRegistryError,
]);

function exactBody(body, fields, message) {
  const keys = Object.keys(body ?? {});
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new DockerVolumeHttpError('docker_volume_input_invalid', message, 400);
  }
  return body;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (error instanceof DockerVolumeHttpError) {
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
      throw new DockerVolumeHttpError(error.code, error.message, error.status ?? 400);
    }
    throw error;
  }
}

async function requireLocalProject(projectRegistry, projectId, localServerId) {
  const project = await safeCall(() => projectRegistry.getProject(projectId));
  if (!project || (localServerId && project.serverId !== localServerId)) {
    throw new DockerVolumeHttpError('docker_compose_project_not_found', 'Docker Compose project was not found', 404);
  }
  return project;
}

export function mountDockerVolumeRoutes(app, {
  dockerComposeProjectRegistry,
  dockerVolumeOperationsService,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function') {
    throw new Error('Docker Compose project registry is required');
  }
  if (!dockerVolumeOperationsService
    || typeof dockerVolumeOperationsService.listProjectVolumes !== 'function'
    || typeof dockerVolumeOperationsService.previewDelete !== 'function'
    || typeof dockerVolumeOperationsService.queueDelete !== 'function') {
    throw new Error('Docker volume operations service is required');
  }

  app.get('/api/docker/projects/:dockerProjectId/volumes', requirePanelRouteAccess, requireOwnerDockerAccess, asyncRoute(async (request, response) => {
    if (Object.keys(request.query ?? {}).length !== 0) {
      throw new DockerVolumeHttpError('docker_volume_query_invalid', 'Docker project volume listing does not accept query parameters', 400);
    }
    const project = await requireLocalProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    const data = await safeCall(() => dockerVolumeOperationsService.listProjectVolumes({ projectId: project.id }));
    return response.json({ data, sideEffects: false });
  }));

  app.post('/api/docker/projects/:dockerProjectId/volumes/delete-preview', requirePanelRouteAccess, requireOwnerDockerAccess, asyncRoute(async (request, response) => {
    const body = exactBody(request.body, ['volumeKey'], 'Send only volumeKey');
    const project = await requireLocalProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    const preview = await safeCall(() => dockerVolumeOperationsService.previewDelete({
      projectId: project.id,
      volumeKey: body.volumeKey,
    }));
    return response.json({ data: preview, sideEffects: false });
  }));

  app.post('/api/docker/projects/:dockerProjectId/volumes/delete', requirePanelRouteAccess, requireOwnerDockerAccess, asyncRoute(async (request, response) => {
    const body = exactBody(
      request.body,
      ['volumeKey', 'expectedPreviewDigest', 'confirmation'],
      'Send volumeKey, expectedPreviewDigest and confirmation',
    );
    const project = await requireLocalProject(dockerComposeProjectRegistry, request.params.dockerProjectId, localServerId);
    const queued = await safeCall(() => dockerVolumeOperationsService.queueDelete({
      projectId: project.id,
      volumeKey: body.volumeKey,
      expectedPreviewDigest: body.expectedPreviewDigest,
      confirmation: body.confirmation,
    }));
    return response.status(202).json({ data: queued, sideEffects: false });
  }));
}

export const dockerVolumeHttpInternals = Object.freeze({
  exactBody,
});
