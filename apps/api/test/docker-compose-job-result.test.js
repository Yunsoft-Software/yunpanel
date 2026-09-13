import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  DockerComposeJobResultError,
  sanitizeDockerComposeJobResult,
} from '../src/docker-compose-job-result.js';

const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const payload = {
  projectId,
  expectedProjectRevision: 3,
  expectedEnvironmentRevision: 2,
  expectedComposeSha256: 'a'.repeat(64),
  credentialRevisions: [],
};

function result(action, runtimeState, overrides = {}) {
  return {
    version: 1,
    projectId,
    projectRevision: 3,
    environmentRevision: 2,
    composeSha256: 'a'.repeat(64),
    action,
    runtimeState,
    executed: true,
    sideEffects: true,
    ...overrides,
  };
}

test('compose sanitizer pins action, runtime state and desired-state revisions', () => {
  const cases = [
    [OPERATIONS.DOCKER_COMPOSE_BUILD, 'build', null],
    [OPERATIONS.DOCKER_COMPOSE_PULL, 'pull', null],
    [OPERATIONS.DOCKER_COMPOSE_START, 'start', 'running'],
    [OPERATIONS.DOCKER_COMPOSE_STOP, 'stop', 'stopped'],
    [OPERATIONS.DOCKER_COMPOSE_RESTART, 'restart', 'running'],
  ];
  for (const [operation, action, runtimeState] of cases) {
    const job = { operation, resourceId: projectId, payload };
    assert.deepEqual(sanitizeDockerComposeJobResult(job, result(action, runtimeState)), result(action, runtimeState));
  }
});

test('compose sanitizer rejects private output and desired-state drift', () => {
  const job = { operation: OPERATIONS.DOCKER_COMPOSE_START, resourceId: projectId, payload };
  for (const candidate of [
    result('start', 'running', { projectRevision: 4 }),
    result('start', 'running', { environmentRevision: 3 }),
    result('start', 'running', { composeSha256: 'b'.repeat(64) }),
    result('restart', 'running'),
    result('start', 'stopped'),
    { ...result('start', 'running'), composePath: '/private/compose.yaml' },
    { ...result('start', 'running'), output: 'raw docker output' },
  ]) {
    assert.throws(
      () => sanitizeDockerComposeJobResult(job, candidate),
      (error) => error instanceof DockerComposeJobResultError && error.code === 'invalid_job_result',
    );
  }
});
