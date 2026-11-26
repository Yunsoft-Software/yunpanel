const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REGISTRY_HOST_PATTERN = /^(?:localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;

export class DockerComposeMaterializerError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DockerComposeMaterializerError';
    this.code = code;
    this.status = status;
  }
}

function pinnedRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.projectId !== 'string' || !value.projectId
    || !Number.isSafeInteger(value.expectedProjectRevision) || value.expectedProjectRevision < 1
    || !Number.isSafeInteger(value.expectedEnvironmentRevision) || value.expectedEnvironmentRevision < 0
    || typeof value.expectedComposeSha256 !== 'string' || !SHA256_PATTERN.test(value.expectedComposeSha256)
    || !Array.isArray(value.credentialRevisions) || value.credentialRevisions.length > 32) {
    throw new DockerComposeMaterializerError('docker_compose_materialization_request_invalid', 'Docker Compose materialization request is invalid', 400);
  }
  const credentials = [];
  const seen = new Set();
  let previous = null;
  for (const entry of value.credentialRevisions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || typeof entry.registryHost !== 'string' || !REGISTRY_HOST_PATTERN.test(entry.registryHost)
      || !Number.isSafeInteger(entry.revision) || entry.revision < 1
      || seen.has(entry.registryHost) || (previous !== null && entry.registryHost.localeCompare(previous) <= 0)) {
      throw new DockerComposeMaterializerError('docker_compose_materialization_request_invalid', 'Docker Compose credential revision pins are invalid', 400);
    }
    seen.add(entry.registryHost);
    previous = entry.registryHost;
    credentials.push({ registryHost: entry.registryHost, revision: entry.revision });
  }
  return Object.freeze({
    projectId: value.projectId,
    expectedProjectRevision: value.expectedProjectRevision,
    expectedEnvironmentRevision: value.expectedEnvironmentRevision,
    expectedComposeSha256: value.expectedComposeSha256,
    credentialRevisions: Object.freeze(credentials),
  });
}

export function createDockerComposeMaterializer({
  projectRegistry,
  environmentRegistry,
  credentialRegistry,
  validateDockerCompose,
} = {}) {
  if (!projectRegistry || typeof projectRegistry.materializeProject !== 'function'
    || !environmentRegistry || typeof environmentRegistry.materializeEnvironment !== 'function'
    || !credentialRegistry || typeof credentialRegistry.listCredentials !== 'function'
    || typeof credentialRegistry.materializeCredential !== 'function'
    || typeof validateDockerCompose !== 'function') {
    throw new DockerComposeMaterializerError('docker_compose_materializer_dependencies_invalid', 'Docker Compose materializer dependencies are invalid', 503);
  }

  return async function materializeDockerCompose(requested) {
    const request = pinnedRequest(requested);
    let project;
    let environment;
    let publicCredentials;
    try {
      [project, environment, publicCredentials] = await Promise.all([
        projectRegistry.materializeProject(request.projectId, { expectedRevision: request.expectedProjectRevision }),
        environmentRegistry.materializeEnvironment(request.projectId, { expectedRevision: request.expectedEnvironmentRevision }),
        credentialRegistry.listCredentials({ projectId: request.projectId }),
      ]);
    } catch {
      throw new DockerComposeMaterializerError('docker_compose_desired_state_stale', 'Docker Compose desired state changed after the job was queued');
    }
    if (!project || project.id !== request.projectId || project.revision !== request.expectedProjectRevision
      || project.composeSha256 !== request.expectedComposeSha256 || typeof project.document !== 'string'
      || !environment || environment.projectId !== request.projectId
      || environment.revision !== request.expectedEnvironmentRevision || !environment.variables
      || typeof environment.variables !== 'object' || Array.isArray(environment.variables)
      || !Array.isArray(publicCredentials)) {
      throw new DockerComposeMaterializerError('docker_compose_desired_state_stale', 'Docker Compose desired state no longer matches the queued revision');
    }
    const actualPins = publicCredentials
      .map((item) => ({ registryHost: item.registryHost, revision: item.revision }))
      .sort((left, right) => left.registryHost.localeCompare(right.registryHost));
    if (JSON.stringify(actualPins) !== JSON.stringify(request.credentialRevisions)) {
      throw new DockerComposeMaterializerError('docker_compose_credentials_stale', 'Docker registry credentials changed after the job was queued');
    }

    const credentials = [];
    for (const pin of request.credentialRevisions) {
      let credential;
      try {
        credential = await credentialRegistry.materializeCredential(request.projectId, pin.registryHost, {
          expectedRevision: pin.revision,
        });
      } catch {
        throw new DockerComposeMaterializerError('docker_compose_credentials_stale', 'Docker registry credentials changed after the job was queued');
      }
      if (!credential || credential.projectId !== request.projectId || credential.registryHost !== pin.registryHost
        || credential.revision !== pin.revision || typeof credential.username !== 'string'
        || typeof credential.secret !== 'string') {
        throw new DockerComposeMaterializerError('docker_compose_credentials_stale', 'Docker registry credential material is inconsistent');
      }
      credentials.push(Object.freeze({
        registryHost: credential.registryHost,
        username: credential.username,
        secret: credential.secret,
      }));
    }

    try {
      const validation = await validateDockerCompose({
        projectName: project.projectName,
        document: project.document,
        environment: environment.variables,
        interpolate: true,
      });
      if (!validation || validation.validated !== true || validation.sideEffects !== false
        || validation.projectName !== project.projectName || validation.composeSha256 !== request.expectedComposeSha256) {
        throw new Error('validation mismatch');
      }
    } catch {
      throw new DockerComposeMaterializerError('docker_compose_runtime_validation_failed', 'Docker Compose desired state is no longer valid for execution');
    }

    return Object.freeze({
      projectId: project.id,
      projectName: project.projectName,
      projectRevision: project.revision,
      environmentRevision: environment.revision,
      composeSha256: project.composeSha256,
      document: project.document,
      environment: Object.freeze({ ...environment.variables }),
      credentials: Object.freeze(credentials),
    });
  };
}

export const dockerComposeMaterializerInternals = Object.freeze({ pinnedRequest });
