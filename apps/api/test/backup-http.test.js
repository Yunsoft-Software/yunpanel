import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobRegistry } from '../src/job-registry.js';
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

// ============================================================================
// BACKUP-UI-03: Website Backup & Restore Durable Operations & Recovery Tests
// ============================================================================

import {
  createWebsiteBackupOperationRegistry,
  WebsiteBackupOperationRegistryError,
  websiteBackupOperationPublicView,
} from '../src/website-backup-operation-registry.js';
import {
  createWebsiteBackupOperationService,
  WebsiteBackupOperationServiceError,
} from '../src/website-backup-operation-service.js';
import {
  mountWebsiteBackupRoutes,
  WebsiteBackupHttpError,
  isWebsiteBackupHttpError,
} from '../src/website-backup-http.js';

const websiteActor = { sessionId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'owner' };
function websiteFixture() {
  const targetWebsiteId = '550e8400-e29b-41d4-a716-446655440000';
  const targetRepoId = '660e8400-e29b-41d4-a716-446655440001';
  const targetSnapshotId = '770e8400-e29b-41d4-a716-446655440002';
  const backupDigest = 'b'.repeat(64);
  const restoreDigest = 'f'.repeat(64);

  const mockBackupPreview = {
    websiteId: targetWebsiteId,
    repositoryId: targetRepoId,
    backupSetDigest: backupDigest,
    targetPaths: ['/var/lib/yunpanel/apps/target'],
    excludePatterns: ['.git'],
    tags: [`website:${targetWebsiteId}`],
    databases: ['novasis'],
    composeHooksEnabled: false,
    confirmation: `backup:${targetWebsiteId}:${targetRepoId}:${backupDigest}`,
  };

  const mockRestorePreview = {
    websiteId: targetWebsiteId,
    websiteRevision: 1,
    repositoryId: targetRepoId,
    snapshotId: targetSnapshotId,
    snapshotTime: '2026-09-30T00:00:00.000Z',
    snapshotTags: [`website:${targetWebsiteId}`],
    snapshotPaths: ['/var/lib/yunpanel/apps/target'],
    healthSpec: { primaryDomain: 'example.com', healthPath: '/health', timeoutSeconds: 30 },
    previewDigest: restoreDigest,
    confirmation: `restore:${targetWebsiteId}:${targetSnapshotId}:${restoreDigest}`,
  };

  const mockBackupService = {
    async previewBackup({ websiteId, repositoryId }) {
      assert.equal(websiteId, targetWebsiteId);
      return mockBackupPreview;
    },
    async executeBackup({ websiteId, repositoryId, expectedPreviewDigest, confirmation }) {
      return {
        status: 'succeeded',
        websiteId,
        repositoryId,
        snapshot: { snapshotId: 'snap-created-123' },
        backupSetDigest: expectedPreviewDigest,
        createdAt: '2026-09-30T01:00:00.000Z',
      };
    },
  };

  const mockRestoreService = {
    healthSatisfied: true,
    async previewRestore({ websiteId, repositoryId, snapshotId }) {
      assert.equal(websiteId, targetWebsiteId);
      return mockRestorePreview;
    },
    async executeRestore({ websiteId, repositoryId, snapshotId, expectedPreviewDigest, confirmation }) {
      if (!this.healthSatisfied) {
        return {
          status: 'rolled_back',
          websiteId,
          snapshotId,
          preRestoreSnapshotId: 'pre-snap-rollback-1',
          rollbackReason: 'health_check_failed',
          healthCheck: { satisfied: false, statusCode: 500, error: 'Health check failed' },
          rolledBackAt: '2026-09-30T01:05:00.000Z',
        };
      }
      return {
        status: 'succeeded',
        websiteId,
        snapshotId,
        preRestoreSnapshotId: 'pre-snap-success-1',
        healthCheck: { satisfied: true, statusCode: 200, attempts: 1 },
        restoredAt: '2026-09-30T01:05:00.000Z',
      };
    },
  };

  const registry = createWebsiteBackupOperationRegistry();
  const jobs = createJobRegistry();
  const operationService = createWebsiteBackupOperationService({
    registry, jobRegistry: jobs,
    websiteRegistry: { getWebsite: async id => ({ id, serverId }) },
    resticRepositoryRegistry: { getRepository: async id => ({ id, serverId }) },
    authorizeActor: async value => value, siteMutationLock: { withSiteLock: async (_identity, action) => action() },
    websiteBackupService: mockBackupService,
    websiteRestoreService: mockRestoreService,
  });

  const routes = [];
  const fakeApp = {
    get(path, ...handlers) { routes.push({ method: 'get', path, handlers }); },
    post(path, ...handlers) { routes.push({ method: 'post', path, handlers }); },
  };

  mountWebsiteBackupRoutes(fakeApp, {
    websiteBackupSetProvider: { async getWebsiteBackupSet() { return {}; } },
    websiteBackupService: mockBackupService,
    websiteBackupOperationService: operationService,
  });

  return {
    targetWebsiteId,
    targetRepoId,
    targetSnapshotId,
    backupDigest,
    restoreDigest,
    mockBackupPreview,
    mockRestorePreview,
    mockBackupService,
    mockRestoreService,
    registry,
    operationService,
    executeNext: async () => {
      const { job, envelope } = await jobs.claimNext(serverId);
      const result = await operationService.execute(envelope.payload, { jobId: job.id, serverId, resourceType: 'backup', resourceId: job.resourceId });
      await jobs.complete({ serverId, jobId: job.id, status: 'succeeded', result });
    },
    routes,
  };
}

test('website backup durable queue route enforces owner permission and exact typed confirmation', async () => {
  const fixture = websiteFixture();
  const queueRoute = fixture.routes.find((r) => r.path === '/api/websites/:websiteId/backup-operations' && r.method === 'post');
  assert.ok(queueRoute, 'backup-operations route should be registered');

  // Verify non-owner is rejected with 403
  let authDenied = null;
  const nonOwnerResponse = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { authDenied = body; return this; },
  };
  queueRoute.handlers[0]({
    auth: { user: { role: 'viewer' }, access: { mode: 'view' }, security: { managementAllowed: true } },
  }, nonOwnerResponse, () => {});
  assert.equal(nonOwnerResponse.statusCode, 403);
  assert.equal(authDenied.error.code, 'forbidden');

  // Verify typed confirmation mismatch is rejected
  await assert.rejects(
    async () => fixture.operationService.queueBackup({
      actor: websiteActor,
      websiteId: fixture.targetWebsiteId,
      repositoryId: fixture.targetRepoId,
      expectedPreviewDigest: fixture.backupDigest,
      confirmation: 'backup:wrong:confirmation',
    }),
    (err) => err instanceof WebsiteBackupOperationServiceError && err.code === 'backup_confirmation_invalid' && err.status === 409,
  );

  // Verify stale preview digest is rejected
  await assert.rejects(
    async () => fixture.operationService.queueBackup({
      actor: websiteActor,
      websiteId: fixture.targetWebsiteId,
      repositoryId: fixture.targetRepoId,
      expectedPreviewDigest: '0'.repeat(64),
      confirmation: fixture.mockBackupPreview.confirmation,
    }),
    (err) => err instanceof WebsiteBackupOperationServiceError && err.code === 'backup_preview_stale' && err.status === 409,
  );

  // Verify exact typed confirmation is accepted with 202
  const handler = queueRoute.handlers[1];
  const { response, forwarded } = await invoke(handler, {
    kind: 'backup',
    repositoryId: fixture.targetRepoId,
    expectedPreviewDigest: fixture.backupDigest,
    confirmation: fixture.mockBackupPreview.confirmation,
  }, {
    params: { websiteId: fixture.targetWebsiteId },
    auth: { id: websiteActor.sessionId, user: { role: 'owner', id: websiteActor.userId }, access: { mode: 'management', permissions: ['*'] }, security: { managementAllowed: true } },
  });

  assert.equal(forwarded, null);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.data.websiteId, fixture.targetWebsiteId);
  assert.equal(response.body.data.kind, 'backup');
  assert.ok(['queued', 'running', 'succeeded'].includes(response.body.data.status));
  assert.equal(response.body.data.previewDigest, fixture.backupDigest);
});

test('website backup same-job result flow tracks progress and rejects concurrent operations', async () => {
  const fixture = websiteFixture();
  const queueRoute = fixture.routes.find((r) => r.path === '/api/websites/:websiteId/backup-operations' && r.method === 'post');
  const getRoute = fixture.routes.find((r) => r.path === '/api/websites/:websiteId/backup-operations/:operationId' && r.method === 'get');

  // Start operation
  const { response } = await invoke(queueRoute.handlers[1], {
    kind: 'backup',
    repositoryId: fixture.targetRepoId,
    expectedPreviewDigest: fixture.backupDigest,
    confirmation: fixture.mockBackupPreview.confirmation,
  }, {
    params: { websiteId: fixture.targetWebsiteId },
    auth: { id: websiteActor.sessionId, user: { role: 'owner', id: websiteActor.userId } },
  });
  const operationId = response.body.data.id;

  // Poll same job via getRoute
  const pollResult = await invoke(getRoute.handlers[1], {}, {
    params: { websiteId: fixture.targetWebsiteId, operationId },
    auth: { id: websiteActor.sessionId, user: { role: 'owner', id: websiteActor.userId } },
  });
  assert.equal(pollResult.forwarded, null);
  assert.equal(pollResult.response.statusCode, 200);
  assert.equal(pollResult.response.body.data.id, operationId);
  assert.equal(pollResult.response.body.data.kind, 'backup');

  // Verify concurrent operation for the same website is rejected with 409
  // Put active operation in running status
  await fixture.registry.updateOperation(operationId, { status: 'running' });
  await assert.rejects(
    async () => fixture.operationService.queueBackup({
      actor: { ...websiteActor, sessionId: '33333333-3333-4333-8333-333333333333' },
      websiteId: fixture.targetWebsiteId,
      repositoryId: fixture.targetRepoId,
      expectedPreviewDigest: fixture.backupDigest,
      confirmation: fixture.mockBackupPreview.confirmation,
    }),
    (err) => err.code === 'website_backup_operation_conflict' && err.status === 409,
  );
});

test('website restore durable queue route supports health check rollback', async () => {
  const fixture = websiteFixture();
  fixture.mockRestoreService.healthSatisfied = false; // Trigger unhealthy rollback

  const op = await fixture.operationService.queueRestore({
    actor: websiteActor,
    websiteId: fixture.targetWebsiteId,
    repositoryId: fixture.targetRepoId,
    snapshotId: fixture.targetSnapshotId,
    expectedPreviewDigest: fixture.restoreDigest,
    confirmation: fixture.mockRestorePreview.confirmation,
  });

  assert.equal(op.kind, 'restore');
  assert.equal(op.websiteId, fixture.targetWebsiteId);
  assert.equal(op.snapshotId, fixture.targetSnapshotId);

  await fixture.executeNext();
  let completed = await fixture.operationService.getOperation(op.id);
  for (let i = 0; i < 20 && (completed.status === 'queued' || completed.status === 'running'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    completed = await fixture.operationService.getOperation(op.id);
  }
  assert.equal(completed.status, 'rolled_back');
  assert.equal(completed.result.status, 'rolled_back');
  assert.equal(completed.result.rollbackReason, 'health_check_failed');
  assert.equal(completed.result.healthCheck.satisfied, false);
});

test('legacy interrupted restore without a verified Website scope never reaches Restic', async () => {
  const registry = createWebsiteBackupOperationRegistry();
  const websiteId = '550e8400-e29b-41d4-a716-446655440000';
  const repositoryId = '660e8400-e29b-41d4-a716-446655440001';
  const operation = await registry.createOperation({ websiteId, repositoryId, kind: 'restore', snapshotId: 'snapshot-owned', previewDigest: 'c'.repeat(64), confirmation: 'restore-confirm' });
  await registry.updateOperation(operation.id, { status: 'running' });
  let mutations = 0;
  await assert.rejects(registry.reconcileInterruptedOperations({ resticManager: { restore: async () => { mutations++; } } }), error => error.code === 'website_backup_recovery_scope_unavailable');
  assert.equal(mutations, 0);
  assert.equal((await registry.getOperation(operation.id)).status, 'running');
});

test('an adjacent snapshot without the exact operation tag cannot complete an interrupted backup', async () => {
  const registry = createWebsiteBackupOperationRegistry();
  const websiteId = '550e8400-e29b-41d4-a716-446655440000';
  const repositoryId = '660e8400-e29b-41d4-a716-446655440001';
  const operation = await registry.createOperation({ websiteId, serverId, repositoryId, kind: 'backup', previewDigest: 'e'.repeat(64), confirmation: 'backup-confirm' });
  await registry.updateOperation(operation.id, { status: 'running', startedAt: new Date().toISOString() });
  await registry.reconcileInterruptedOperations({
    websiteRegistry: { getWebsite: async () => ({ id: websiteId, serverId }) },
    websiteBackupSetProvider: { getWebsiteBackupSet: async () => ({ targetPaths: ['/owned/site'] }) },
    siteMutationLock: { withSiteLock: async (_identity, action) => action() },
    resticManager: { listSnapshots: async () => [{ id: 'adjacent-snapshot', time: new Date().toISOString(), tags: [`website:${websiteId}`] }] },
    resticRepositoryRegistry: { getRepository: async () => ({ serverId, target: '/owned/repository' }), revealPassword: async () => 'fixture-private-repository-password' },
  });
  const recovered = await registry.getOperation(operation.id);
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.snapshotId, null);
  assert.equal(recovered.error.code, 'interrupted_by_restart');
});

test('operation public view strips repository target and private filesystem paths', () => {
  const rawOperation = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    websiteId: '660e8400-e29b-41d4-a716-446655440001',
    serverId: '770e8400-e29b-41d4-a716-446655440002',
    repositoryId: '880e8400-e29b-41d4-a716-446655440003',
    kind: 'backup',
    snapshotId: 'snap-1',
    preRestoreSnapshotId: null,
    previewDigest: 'a'.repeat(64),
    confirmation: 'backup:...',
    status: 'succeeded',
    progress: { phase: 'succeeded', percent: 100 },
    steps: [{ name: 'snapshot', status: 'succeeded' }],
    result: { status: 'succeeded' },
    target: '/private/repository/target/must/not/leak',
    targetPaths: ['/private/path/must/not/leak'],
    password: 'secretPassword',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:01:00.000Z',
  };

  const view = websiteBackupOperationPublicView(rawOperation);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /private|must\/not\/leak|secretPassword/);
  assert.equal(view.id, rawOperation.id);
  assert.equal(view.status, 'succeeded');
});
