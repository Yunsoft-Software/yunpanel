import { createHash } from 'node:crypto';
import { DOCKER_COMPOSE_OPERATIONS, OPERATIONS } from '@yunpanel/protocol';

const ACTION_TO_OPERATION = Object.freeze({
  build: OPERATIONS.DOCKER_COMPOSE_BUILD,
  pull: OPERATIONS.DOCKER_COMPOSE_PULL,
  start: OPERATIONS.DOCKER_COMPOSE_START,
  stop: OPERATIONS.DOCKER_COMPOSE_STOP,
  restart: OPERATIONS.DOCKER_COMPOSE_RESTART,
});
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const DOCKER_OPERATION_SET = new Set(DOCKER_COMPOSE_OPERATIONS);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DockerComposeOperationsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerComposeOperationsError';
    this.code = code;
    this.status = status;
  }
}

function requireAction(value) {
  if (typeof value !== 'string' || !Object.hasOwn(ACTION_TO_OPERATION, value)) {
    throw new DockerComposeOperationsError('docker_compose_action_invalid', 'Docker Compose action is invalid');
  }
  return value;
}

function previewDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function credentialPins(value) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new DockerComposeOperationsError('docker_compose_credentials_invalid', 'Docker registry credential metadata is invalid', 409);
  }
  return value.map((item) => {
    if (!item || typeof item.registryHost !== 'string'
      || !Number.isSafeInteger(item.revision) || item.revision < 1 || item.configured !== true) {
      throw new DockerComposeOperationsError('docker_compose_credentials_invalid', 'Docker registry credential metadata is invalid', 409);
    }
    return { registryHost: item.registryHost, revision: item.revision };
  }).sort((left, right) => left.registryHost.localeCompare(right.registryHost));
}

export function createDockerComposeOperationsService({
  projectRegistry,
  environmentRegistry,
  credentialRegistry,
  jobRegistry,
} = {}) {
  if (!projectRegistry || typeof projectRegistry.getProject !== 'function'
    || !environmentRegistry || typeof environmentRegistry.getEnvironment !== 'function'
    || !credentialRegistry || typeof credentialRegistry.listCredentials !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function') {
    throw new DockerComposeOperationsError('docker_compose_operations_dependencies_invalid', 'Docker Compose operation dependencies are unavailable', 503);
  }

  async function assertIdle(projectId) {
    let jobs;
    try { jobs = await jobRegistry.listJobs({ resourceType: 'docker_project', resourceId: projectId }); }
    catch {
      throw new DockerComposeOperationsError('docker_compose_job_state_unavailable', 'Docker Compose job state could not be inspected', 503);
    }
    if (!Array.isArray(jobs)) {
      throw new DockerComposeOperationsError('docker_compose_job_state_unavailable', 'Docker Compose job state is invalid', 503);
    }
    if (jobs.some((job) => DOCKER_OPERATION_SET.has(job.operation) && ACTIVE_STATUSES.has(job.status))) {
      throw new DockerComposeOperationsError('docker_compose_job_conflict', 'Another Docker Compose operation is already queued or running', 409);
    }
  }

  async function preview({ projectId, action: requestedAction } = {}) {
    const action = requireAction(requestedAction);
    await assertIdle(projectId);
    let project;
    let environment;
    let credentials;
    try {
      [project, environment, credentials] = await Promise.all([
        projectRegistry.getProject(projectId),
        environmentRegistry.getEnvironment(projectId),
        credentialRegistry.listCredentials({ projectId }),
      ]);
    } catch {
      throw new DockerComposeOperationsError('docker_compose_desired_state_unavailable', 'Docker Compose desired state could not be read', 503);
    }
    if (!project || project.id !== projectId || typeof project.serverId !== 'string' || !project.serverId
      || !Number.isSafeInteger(project.revision) || project.revision < 1
      || typeof project.composeSha256 !== 'string' || !SHA256_PATTERN.test(project.composeSha256)
      || !environment || environment.projectId !== projectId
      || !Number.isSafeInteger(environment.revision) || environment.revision < 0) {
      throw new DockerComposeOperationsError('docker_compose_desired_state_invalid', 'Docker Compose desired state is invalid', 409);
    }
    const pins = credentialPins(credentials);
    const identity = Object.freeze({
      version: 1,
      action,
      operation: ACTION_TO_OPERATION[action],
      serverId: project.serverId,
      projectId,
      projectName: project.projectName,
      projectRevision: project.revision,
      environmentRevision: environment.revision,
      composeSha256: project.composeSha256,
      credentialRevisions: Object.freeze(pins),
    });
    const digest = previewDigest(identity);
    return Object.freeze({
      ...identity,
      previewDigest: digest,
      confirmation: `docker-compose:${action}:${project.projectName}:${digest}`,
      sideEffects: false,
    });
  }

  async function queue({ projectId, action: requestedAction, expectedPreviewDigest, confirmation } = {}) {
    const action = requireAction(requestedAction);
    if (typeof expectedPreviewDigest !== 'string' || !SHA256_PATTERN.test(expectedPreviewDigest)) {
      throw new DockerComposeOperationsError('docker_compose_preview_digest_invalid', 'Docker Compose preview digest is invalid');
    }
    const current = await preview({ projectId, action });
    if (current.previewDigest !== expectedPreviewDigest) {
      throw new DockerComposeOperationsError('docker_compose_preview_stale', 'Docker Compose operation preview is stale', 409);
    }
    if (confirmation !== current.confirmation) {
      throw new DockerComposeOperationsError('docker_compose_confirmation_invalid', 'Docker Compose operation confirmation is invalid', 409);
    }
    const job = await jobRegistry.enqueue({
      serverId: current.serverId,
      type: current.operation,
      operation: current.operation,
      payload: {
        projectId,
        expectedProjectRevision: current.projectRevision,
        expectedEnvironmentRevision: current.environmentRevision,
        expectedComposeSha256: current.composeSha256,
        credentialRevisions: current.credentialRevisions.map((item) => ({ ...item })),
      },
      resourceType: 'docker_project',
      resourceId: projectId,
      idempotencyKey: `docker-compose:${action}:${projectId}:${current.previewDigest}`,
    });
    return Object.freeze({ previewDigest: current.previewDigest, job });
  }

  return Object.freeze({ assertIdle, preview, queue });
}

export const dockerComposeOperationsInternals = Object.freeze({
  actionToOperation: ACTION_TO_OPERATION,
  requireAction,
  previewDigest,
  credentialPins,
});
