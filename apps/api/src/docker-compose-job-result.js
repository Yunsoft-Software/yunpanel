import { OPERATIONS } from '@yunpanel/protocol';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIONS = new Map([
  [OPERATIONS.DOCKER_COMPOSE_BUILD, ['build', null]],
  [OPERATIONS.DOCKER_COMPOSE_PULL, ['pull', null]],
  [OPERATIONS.DOCKER_COMPOSE_START, ['start', 'running']],
  [OPERATIONS.DOCKER_COMPOSE_STOP, ['stop', 'stopped']],
  [OPERATIONS.DOCKER_COMPOSE_RESTART, ['restart', 'running']],
]);

export class DockerComposeJobResultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DockerComposeJobResultError';
    this.code = code;
  }
}

function invalid() {
  throw new DockerComposeJobResultError('invalid_job_result', 'Docker Compose job result does not match the queued desired state');
}

export function sanitizeDockerComposeJobResult(job, result) {
  const expected = ACTIONS.get(job?.operation);
  const fields = [
    'version', 'projectId', 'projectRevision', 'environmentRevision', 'composeSha256',
    'action', 'runtimeState', 'executed', 'sideEffects',
  ];
  if (!expected || !job?.payload || !result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== fields.length || fields.some((field) => !Object.hasOwn(result, field))
    || result.version !== 1 || result.projectId !== job.payload.projectId || result.projectId !== job.resourceId
    || result.projectRevision !== job.payload.expectedProjectRevision
    || result.environmentRevision !== job.payload.expectedEnvironmentRevision
    || result.composeSha256 !== job.payload.expectedComposeSha256
    || typeof result.composeSha256 !== 'string' || !SHA256_PATTERN.test(result.composeSha256)
    || result.action !== expected[0] || result.runtimeState !== expected[1]
    || result.executed !== true || result.sideEffects !== true) {
    invalid();
  }
  return Object.freeze({
    version: 1,
    projectId: result.projectId,
    projectRevision: result.projectRevision,
    environmentRevision: result.environmentRevision,
    composeSha256: result.composeSha256,
    action: expected[0],
    runtimeState: expected[1],
    executed: true,
    sideEffects: true,
  });
}

export const dockerComposeJobResultInternals = Object.freeze({ actions: ACTIONS });
