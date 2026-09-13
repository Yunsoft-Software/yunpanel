import { createDockerComposeManager } from '@yunpanel/host-runtime';
import { DOCKER_COMPOSE_OPERATIONS, OPERATIONS } from '@yunpanel/protocol';
import { createDockerComposeOperationReceiptStore } from './docker-compose-operation-receipt.js';

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_SET = new Set(DOCKER_COMPOSE_OPERATIONS);
const ACTIONS = new Map([
  [OPERATIONS.DOCKER_COMPOSE_BUILD, 'build'],
  [OPERATIONS.DOCKER_COMPOSE_PULL, 'pull'],
  [OPERATIONS.DOCKER_COMPOSE_START, 'start'],
  [OPERATIONS.DOCKER_COMPOSE_STOP, 'stop'],
  [OPERATIONS.DOCKER_COMPOSE_RESTART, 'restart'],
]);

export class LocalDockerComposeOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalDockerComposeOperationError';
    this.code = code;
  }
}

function assertExecution(execution, payload) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || typeof execution.jobId !== 'string' || !EXECUTION_ID_PATTERN.test(execution.jobId)
    || typeof execution.serverId !== 'string' || !UUID_PATTERN.test(execution.serverId)
    || execution.resourceType !== 'docker_project' || execution.resourceId !== payload?.projectId
    || typeof execution.resourceId !== 'string' || !UUID_PATTERN.test(execution.resourceId)) {
    throw new LocalDockerComposeOperationError(
      'docker_compose_execution_context_invalid',
      'Docker Compose execution context does not match the queued project',
    );
  }
  return execution;
}

function confirmBundle(bundle, payload) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
    || bundle.projectId !== payload.projectId
    || bundle.projectRevision !== payload.expectedProjectRevision
    || bundle.environmentRevision !== payload.expectedEnvironmentRevision
    || bundle.composeSha256 !== payload.expectedComposeSha256
    || typeof bundle.projectName !== 'string' || !bundle.projectName
    || typeof bundle.document !== 'string' || !bundle.document
    || !bundle.environment || typeof bundle.environment !== 'object' || Array.isArray(bundle.environment)
    || !Array.isArray(bundle.credentials)) {
    throw new LocalDockerComposeOperationError(
      'docker_compose_bundle_mismatch',
      'Docker Compose private runtime bundle does not match the queued desired state',
    );
  }
  return bundle;
}

function confirmResult(result, payload, action) {
  const expectedState = action === 'start' || action === 'restart' ? 'running' : action === 'stop' ? 'stopped' : null;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.projectId !== payload.projectId
    || result.projectRevision !== payload.expectedProjectRevision
    || result.environmentRevision !== payload.expectedEnvironmentRevision
    || result.composeSha256 !== payload.expectedComposeSha256
    || result.action !== action || result.runtimeState !== expectedState
    || result.executed !== true || result.sideEffects !== true) {
    throw new LocalDockerComposeOperationError(
      'docker_compose_execution_unconfirmed',
      'Docker Compose host mutation did not confirm the queued desired state',
    );
  }
  return Object.freeze({
    version: 1,
    projectId: result.projectId,
    projectRevision: result.projectRevision,
    environmentRevision: result.environmentRevision,
    composeSha256: result.composeSha256,
    action,
    runtimeState: expectedState,
    executed: true,
    sideEffects: true,
  });
}

export function createLocalDockerComposeOperation({
  materialize,
  manager = createDockerComposeManager(),
  receiptStore = createDockerComposeOperationReceiptStore(),
} = {}) {
  if (typeof materialize !== 'function'
    || !manager || !['build', 'pull', 'start', 'stop', 'restart'].every((method) => typeof manager[method] === 'function')
    || !receiptStore || typeof receiptStore.write !== 'function') {
    throw new LocalDockerComposeOperationError(
      'docker_compose_operation_dependencies_invalid',
      'Docker Compose local operation dependencies are invalid',
    );
  }

  async function execute(operation, payload, execution) {
    const context = assertExecution(execution, payload);
    if (!OPERATION_SET.has(operation)) {
      throw new LocalDockerComposeOperationError('docker_compose_operation_invalid', 'Docker Compose operation is invalid');
    }
    const action = ACTIONS.get(operation);
    const bundle = confirmBundle(await materialize(payload), payload);
    const safeResult = confirmResult(await manager[action](bundle), payload, action);
    try {
      await receiptStore.write({
        serverId: context.serverId,
        jobId: context.jobId,
        operation,
        result: safeResult,
      });
    } catch {
      // The host mutation already finished. Durable completion still proceeds;
      // missing receipt keeps a later lost-ack recovery unresolved instead of
      // reclassifying successful host work as a failure here.
    }
    return safeResult;
  }

  return Object.freeze({ execute });
}

export const localDockerComposeOperationInternals = Object.freeze({
  assertExecution,
  confirmBundle,
  confirmResult,
  actions: ACTIONS,
});
