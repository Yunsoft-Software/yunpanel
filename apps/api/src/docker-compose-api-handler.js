import express from 'express';
import { mountDockerComposeRoutes } from './docker-compose-http.js';

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
  localServerId = null,
} = {}) {
  if (typeof baseHandler !== 'function'
    || !runtime || typeof runtime !== 'object'
    || !runtime.projectRegistry || !runtime.environmentRegistry || !runtime.credentialRegistry
    || !runtime.operationsService || typeof runtime.validateDockerCompose !== 'function') {
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
    validateDockerCompose: runtime.validateDockerCompose,
    localServerId,
  });
  app.use(baseHandler);
  return app;
}
