import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalDockerComposeOperation } from '../src/local-docker-compose-operation.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const jobId = '12345678-1234-4234-8234-123456789012';
const sha = 'a'.repeat(64);
const payload = Object.freeze({
  projectId,
  expectedProjectRevision: 3,
  expectedEnvironmentRevision: 2,
  expectedComposeSha256: sha,
  credentialRevisions: [],
});
const bundle = Object.freeze({
  projectId,
  projectName: 'shop_app',
  projectRevision: 3,
  environmentRevision: 2,
  composeSha256: sha,
  document: 'services: {}',
  environment: Object.freeze({}),
  credentials: Object.freeze([]),
});

function result(action, runtimeState) {
  return {
    version: 1,
    projectId,
    projectRevision: 3,
    environmentRevision: 2,
    composeSha256: sha,
    action,
    runtimeState,
    executed: true,
    sideEffects: true,
  };
}

test('local compose operation materializes pinned state, executes manager and writes safe recovery receipt', async () => {
  const calls = [];
  const operation = createLocalDockerComposeOperation({
    materialize: async (input) => { calls.push(['materialize', input]); return bundle; },
    manager: {
      build: async () => result('build', null),
      pull: async () => result('pull', null),
      start: async (input) => { calls.push(['start', input]); return result('start', 'running'); },
      stop: async () => result('stop', 'stopped'),
      restart: async () => result('restart', 'running'),
    },
    receiptStore: {
      async write(input) { calls.push(['receipt', input]); return input; },
    },
  });
  const terminal = await operation.execute(
    OPERATIONS.DOCKER_COMPOSE_START,
    payload,
    { jobId, serverId, resourceType: 'docker_project', resourceId: projectId },
  );
  assert.deepEqual(calls[0], ['materialize', payload]);
  assert.deepEqual(calls[1], ['start', bundle]);
  assert.equal(calls[2][1].operation, OPERATIONS.DOCKER_COMPOSE_START);
  assert.deepEqual(terminal, result('start', 'running'));
  assert.equal(JSON.stringify(terminal).includes('document'), false);
  assert.equal(JSON.stringify(terminal).includes('credentials'), false);
});

test('local compose operation rejects execution context and bundle drift before host mutation', async () => {
  let executions = 0;
  const base = {
    build: async () => { executions += 1; return result('build', null); },
    pull: async () => { executions += 1; return result('pull', null); },
    start: async () => { executions += 1; return result('start', 'running'); },
    stop: async () => { executions += 1; return result('stop', 'stopped'); },
    restart: async () => { executions += 1; return result('restart', 'running'); },
  };
  const badContext = createLocalDockerComposeOperation({
    materialize: async () => bundle,
    manager: base,
    receiptStore: { write: async () => {} },
  });
  await assert.rejects(
    badContext.execute(
      OPERATIONS.DOCKER_COMPOSE_START,
      payload,
      { jobId, serverId, resourceType: 'docker_project', resourceId: '22345678-1234-4234-8234-123456789012' },
    ),
    { code: 'docker_compose_execution_context_invalid' },
  );
  const badBundle = createLocalDockerComposeOperation({
    materialize: async () => ({ ...bundle, projectRevision: 4 }),
    manager: base,
    receiptStore: { write: async () => {} },
  });
  await assert.rejects(
    badBundle.execute(
      OPERATIONS.DOCKER_COMPOSE_START,
      payload,
      { jobId, serverId, resourceType: 'docker_project', resourceId: projectId },
    ),
    { code: 'docker_compose_bundle_mismatch' },
  );
  assert.equal(executions, 0);
});

test('receipt persistence failure does not recast completed host work as failed', async () => {
  const operation = createLocalDockerComposeOperation({
    materialize: async () => bundle,
    manager: {
      build: async () => result('build', null), pull: async () => result('pull', null),
      start: async () => result('start', 'running'), stop: async () => result('stop', 'stopped'),
      restart: async () => result('restart', 'running'),
    },
    receiptStore: { async write() { throw new Error('disk unavailable'); } },
  });
  const terminal = await operation.execute(
    OPERATIONS.DOCKER_COMPOSE_RESTART,
    payload,
    { jobId, serverId, resourceType: 'docker_project', resourceId: projectId },
  );
  assert.deepEqual(terminal, result('restart', 'running'));
});
