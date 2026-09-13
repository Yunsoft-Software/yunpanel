import { BackupManifestError } from './backup-manifest.js';
import { DockerComposeProjectRegistryError } from './docker-compose-project-registry.js';
import { createDockerStorageBackupView } from './docker-storage-backup-view.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

export class DockerStorageBackupHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerStorageBackupHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      if (error instanceof DockerStorageBackupHttpError) {
        return response.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof DockerComposeProjectRegistryError) {
        return response.status(error.status ?? 400).json({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof BackupManifestError) {
        return response.status(409).json({
          error: {
            code: 'docker_storage_backup_state_invalid',
            message: 'Docker storage backup state is invalid',
          },
        });
      }
      return next(error);
    }
  };
}

export function mountDockerStorageBackupRoutes(app, {
  dockerComposeProjectRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('Express application is required');
  }
  if (!dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function') {
    throw new TypeError('Docker Compose project registry is required');
  }
  if (localServerId !== null && (typeof localServerId !== 'string' || localServerId.length === 0)) {
    throw new TypeError('localServerId must be a non-empty string when provided');
  }

  app.get('/api/docker/projects/:dockerProjectId/storage-backup', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    if (Object.keys(request.query ?? {}).length !== 0) {
      throw new DockerStorageBackupHttpError(
        'docker_storage_backup_query_invalid',
        'Docker storage backup policy does not accept query parameters',
      );
    }
    const project = await dockerComposeProjectRegistry.getProject(request.params.dockerProjectId);
    if (!project || (localServerId && project.serverId !== localServerId)) {
      throw new DockerStorageBackupHttpError(
        'docker_compose_project_not_found',
        'Docker Compose project was not found',
        404,
      );
    }
    return response.status(200).json({ data: createDockerStorageBackupView(project) });
  }));
}

export const dockerStorageBackupHttpInternals = Object.freeze({ asyncRoute });
