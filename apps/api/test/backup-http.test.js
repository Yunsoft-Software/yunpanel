import assert from 'node:assert/strict';
import test from 'node:test';
import { BackupHttpError, backupHttpInternals, mountBackupRoutes } from '../src/backup-http.js';
import { requirePanelRouteAccess } from '../src/panel-http-guard.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const operationId = '2c387b02-8747-458a-b509-8f531d4d149e';

function routeFixture(preview = async (input) => ({ ...input, previewDigest: 'a'.repeat(64), sideEffects: false })) {
  const routes = [];
  const app = {
    post(path, ...handlers) { routes.push({ method: 'post', path, handlers }); },
  };
  mountBackupRoutes(app, { backupResourceProvider: { preview } });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/backups/preview');
  assert.equal(routes[0].handlers[0], requirePanelRouteAccess);
  return routes[0].handlers[1];
}

function requestScopedRouteFixture(factory) {
  const routes = [];
  const app = {
    post(path, ...handlers) { routes.push({ method: 'post', path, handlers }); },
  };
  mountBackupRoutes(app, { backupResourceProviderForRequest: factory });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/backups/preview');
  assert.equal(routes[0].handlers[0], requirePanelRouteAccess);
  return routes[0].handlers[1];
}

function storedOperation(status = 'running') {
  const terminal = status === 'succeeded';
  return {
    id: operationId,
    serverId,
    executionDigest: 'e'.repeat(64),
    idempotencyKey: `general-backup:${'e'.repeat(64)}`,
    previewDigest: 'a'.repeat(64),
    status,
    plan: {
      steps: [{
        stepId: `backup-step:${'b'.repeat(64)}`,
        resourceIdentity: `database:${serverId}:novasis`,
        resourceType: 'database',
        executorKind: 'database_backup',
        input: { databaseName: 'novasis', privatePath: '/must/not/leak' },
      }],
    },
    steps: [{
      stepId: `backup-step:${'b'.repeat(64)}`,
      status: terminal ? 'succeeded' : 'dispatched',
      workRef: { kind: 'job', id: `general-backup-step:${'b'.repeat(64)}` },
      evidence: terminal ? {
        artifactId: 'backup-12345678',
        contentSha256: 'c'.repeat(64),
        bytes: 2048,
        createdAt: '2026-09-14T00:01:00.000Z',
      } : null,
      error: null,
      updatedAt: '2026-09-14T00:01:00.000Z',
    }],
    createdAt: '2026-09-14T00:00:00.000Z',
    startedAt: '2026-09-14T00:00:01.000Z',
    finishedAt: terminal ? '2026-09-14T00:01:01.000Z' : null,
    error: null,
  };
}

function executionRouteFixture() {
  const routes = [];
  const operation = storedOperation('running');
  const app = {
    post(path, ...handlers) { routes.push({ method: 'post', path, handlers }); },
    get(path, ...handlers) { routes.push({ method: 'get', path, handlers }); },
  };
  const orchestrator = {
    async create(input) {
      assert.equal(input.serverId, serverId);
      return operation;
    },
    async advance(id) {
      assert.equal(id, operationId);
      return {
        operation,
        waiting: true,
        childJob: {
          id: '0bb78242-03a6-429f-9d17-7725c521437c',
          status: 'queued',
          operation: 'database.backup',
          resourceType: 'database',
          resourceId: 'novasis',
          payload: { privatePath: '/must/not/leak' },
        },
      };
    },
  };
  mountBackupRoutes(app, {
    backupResourceProvider: { async preview() { return { previewDigest: 'a'.repeat(64) }; } },
    backupOperationRegistry: {
      async getOperation(id) { return id === operationId ? operation : null; },
      async listOperations() { return [operation]; },
    },
    async backupOrchestratorForRequest(_request, provider) {
      assert.equal(typeof provider.preview, 'function');
      return orchestrator;
    },
  });
  return { routes, operation };
}

async function invoke(handler, body, requestFields = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  let forwarded = null;
  await handler({ body, params: {}, ...requestFields }, response, (error) => { forwarded = error; });
  return { response, forwarded };
}

test('general backup preview route is management guarded and forwards exact selection intent', async () => {
  let received = null;
  const handler = routeFixture(async (input) => {
    received = input;
    return { serverId: input.serverId, selectionMode: 'explicit', previewDigest: 'b'.repeat(64), sideEffects: false };
  });
  const selectedResourceIdentities = ['application:84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8'];
  const { response, forwarded } = await invoke(handler, { serverId, selectedResourceIdentities });

  assert.equal(forwarded, null);
  assert.deepEqual(received, { serverId, selectedResourceIdentities });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.serverId, serverId);
  assert.equal(response.body.data.selectionMode, 'explicit');
  assert.equal(response.body.data.sideEffects, false);
});

test('general backup preview route defaults to all managed resources', async () => {
  let received = null;
  const handler = routeFixture(async (input) => {
    received = input;
    return { previewDigest: 'c'.repeat(64), sideEffects: false };
  });
  const { forwarded } = await invoke(handler, { serverId });
  assert.equal(forwarded, null);
  assert.deepEqual(received, { serverId, selectedResourceIdentities: null });
});

test('general backup preview route resolves a provider from the authenticated request context', async () => {
  const requestMarker = Symbol('request-marker');
  let factoryRequest = null;
  let received = null;
  const handler = requestScopedRouteFixture(async (request) => {
    factoryRequest = request;
    return {
      async preview(input) {
        received = input;
        return { serverId: input.serverId, previewDigest: 'd'.repeat(64), sideEffects: false };
      },
    };
  });
  const { response, forwarded } = await invoke(handler, { serverId }, { [requestMarker]: true });

  assert.equal(forwarded, null);
  assert.equal(factoryRequest[requestMarker], true);
  assert.deepEqual(received, { serverId, selectedResourceIdentities: null });
  assert.equal(response.body.data.previewDigest, 'd'.repeat(64));
});

test('general backup preview route fails closed when request-scoped provider is unavailable', async () => {
  const handler = requestScopedRouteFixture(async () => null);
  const { forwarded } = await invoke(handler, { serverId });
  assert.ok(forwarded instanceof BackupHttpError);
  assert.equal(forwarded.code, 'backup_preview_unavailable');
  assert.equal(forwarded.status, 503);
});

test('general backup preview route rejects malformed or expanded request bodies', async () => {
  const handler = routeFixture();
  for (const body of [
    null,
    {},
    { serverId: 'not-a-uuid' },
    { serverId, selectedResourceIdentities: [], force: true },
  ]) {
    const { forwarded } = await invoke(handler, body);
    assert.ok(forwarded instanceof BackupHttpError);
    assert.equal(forwarded.code, 'backup_preview_input_invalid');
    assert.equal(forwarded.status, 400);
  }
  const invalidSelection = await invoke(handler, { serverId, selectedResourceIdentities: 'all' });
  assert.equal(invalidSelection.forwarded.code, 'backup_resource_selection_invalid');
});

test('general backup preview route forwards provider failure without rewriting evidence errors', async () => {
  const expected = new Error('provider failed');
  const handler = routeFixture(async () => { throw expected; });
  const { forwarded } = await invoke(handler, { serverId });
  assert.equal(forwarded, expected);
});

test('execution input requires exact typed confirmation and unique bounded resource selection', () => {
  const digest = 'a'.repeat(64);
  const confirmation = `backup:${serverId}:${digest}`;
  assert.deepEqual(backupHttpInternals.executionBody({
    serverId,
    selectedResourceIdentities: [`database:${serverId}:novasis`],
    expectedPreviewDigest: digest,
    confirmation,
  }), {
    serverId,
    selectedResourceIdentities: [`database:${serverId}:novasis`],
    expectedPreviewDigest: digest,
    confirmation,
  });
  assert.throws(
    () => backupHttpInternals.executionBody({ serverId, expectedPreviewDigest: digest, confirmation: 'backup:wrong' }),
    (error) => error instanceof BackupHttpError && error.code === 'backup_execution_confirmation_invalid' && error.status === 409,
  );
});

test('execution and history routes expose only bounded resource progress and evidence', async () => {
  const { routes } = executionRouteFixture();
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`), [
    'post /api/backups/preview',
    'post /api/backups',
    'post /api/backups/:operationId/advance',
    'get /api/backups',
    'get /api/backups/:operationId',
  ]);

  const start = routes.find((route) => route.path === '/api/backups' && route.method === 'post');
  const digest = 'a'.repeat(64);
  const { response, forwarded } = await invoke(start.handlers[1], {
    serverId,
    expectedPreviewDigest: digest,
    confirmation: `backup:${serverId}:${digest}`,
  });
  assert.equal(forwarded, null);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.data.id, operationId);
  assert.deepEqual(response.body.data.progress, { total: 1, pending: 0, dispatched: 1, succeeded: 0, failed: 0 });
  assert.equal(response.body.execution.waiting, true);
  assert.equal(response.body.execution.childJob.status, 'queued');
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /privatePath|must\/not\/leak|workRef|idempotencyKey|executorKind/);
});

test('operation view strips durable execution input and work references while retaining checksum evidence', () => {
  const view = backupHttpInternals.operationView(storedOperation('succeeded'));
  assert.equal(view.status, 'succeeded');
  assert.equal(view.steps[0].resourceType, 'database');
  assert.equal(view.steps[0].evidence.contentSha256, 'c'.repeat(64));
  assert.deepEqual(view.progress, { total: 1, pending: 0, dispatched: 0, succeeded: 1, failed: 0 });
  assert.doesNotMatch(JSON.stringify(view), /privatePath|must\/not\/leak|workRef|idempotencyKey|executorKind/);
});
