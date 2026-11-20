import express from 'express';
import { mountDockerComposeRoutes } from './docker-compose-http.js';
import { mountDockerStorageBackupRoutes } from './docker-storage-backup-http.js';
import { mountDockerVolumeRoutes } from './docker-volume-http.js';

export const dockerComposeApiRequestContext = Symbol.for('yunpanel.docker-compose-api-context');

export class DockerComposeApiHandlerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DockerComposeApiHandlerError';
    this.code = code;
  }
}

export function createDockerComposeApiHandler({
  baseHandler,
  runtime,
  domainRegistry = null,
  jobRegistry = null,
  siteMutationLock = null,
  localServerId = null,
} = {}) {
  if (typeof baseHandler !== 'function'
    || !runtime || typeof runtime !== 'object'
    || !runtime.projectRegistry || !runtime.environmentRegistry || !runtime.credentialRegistry
    || !runtime.operationsService || !runtime.observer || typeof runtime.validateDockerCompose !== 'function') {
    throw new DockerComposeApiHandlerError(
      'docker_compose_api_handler_dependencies_invalid',
      'Docker Compose API handler dependencies are invalid',
    );
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  mountDockerComposeRoutes(app, {
    dockerComposeProjectRegistry: runtime.projectRegistry,
    dockerComposeEnvironmentRegistry: runtime.environmentRegistry,
    dockerRegistryCredentialRegistry: runtime.credentialRegistry,
    dockerComposeOperationsService: runtime.operationsService,
    dockerComposeObserver: runtime.observer,
    validateDockerCompose: runtime.validateDockerCompose,
    domainRegistry,
    jobRegistry,
    siteMutationLock,
    localServerId,
  });
  mountDockerStorageBackupRoutes(app, {
    dockerComposeProjectRegistry: runtime.projectRegistry,
    localServerId,
  });
  if (runtime.volumeOperationsService) {
    mountDockerVolumeRoutes(app, {
      dockerComposeProjectRegistry: runtime.projectRegistry,
      dockerVolumeOperationsService: runtime.volumeOperationsService,
      localServerId,
    });
  }
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    return response.status(500).json({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });
  app.use((request, response, next) => {
    Object.defineProperty(request, dockerComposeApiRequestContext, {
      value: Object.freeze({ projectRegistry: runtime.projectRegistry }),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    next();
  });
  app.use(baseHandler);
  return app;
}
