import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mountWebsiteProvisioningRoutes,
  WebsiteProvisioningHttpError,
  websiteProvisioningHttpInternals,
} from '../src/website-provisioning-http.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';

function fakeApp() {
  const routes = { get: new Map(), post: new Map() };
  return {
    routes,
    get(path, ...handlers) { routes.get.set(path, handlers.at(-1)); },
    post(path, ...handlers) { routes.post.set(path, handlers.at(-1)); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

const ownerAuth = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  user: Object.freeze({ id: '22222222-2222-4222-8222-222222222222', role: 'owner' }),
});

async function invoke(handler, request) {
  const response = fakeResponse();
  let nextError = null;
  const submitted = { auth: ownerAuth, ...request };
  await handler(submitted, response, (error) => { nextError = error; });
  if (nextError) throw nextError;
  return response;
}

function durableOperation(overrides = {}) {
  return {
    operationId,
    websiteId,
    ready: false,
    status: 'partial',
    progress: { required: 2, completed: 1, remaining: 1 },
    createdAt: '2026-09-14T01:00:00.000Z',
    updatedAt: '2026-09-14T01:01:00.000Z',
    resources: { database: { password: 'must-never-reach-browser' } },
    steps: [
      {
        id: 'unix_identity',
        kind: 'unix_identity',
        required: true,
        state: 'succeeded',
        intent: { password: 'intent-secret' },
        evidence: { uid: 1201, token: 'evidence-secret' },
        error: null,
        compensation: { state: 'pending', evidence: null, error: null },
      },
      {
        id: 'nginx',
        kind: 'nginx',
        required: true,
        state: 'failed',
        intent: { privateDirective: 'hidden' },
        evidence: null,
        error: 'website_nginx_activation_failed',
        compensation: { state: 'failed', evidence: { private: true }, error: 'website_nginx_compensation_failed' },
      },
    ],
    ...overrides,
  };
}

function registry(overrides = {}) {
  return {
    get: async () => durableOperation(),
    getLatestForWebsite: async () => durableOperation(),
    ...overrides,
  };
}

function orchestrator(overrides = {}) {
  return {
    runNext: async () => ({}),
    retryStep: async () => ({}),
    compensateStep: async () => ({}),
    supportsCompensation: (kind) => ['unix_identity', 'nginx'].includes(kind),
    ...overrides,
  };
}

function assertSecretSafeOperation(value) {
  assert.equal(value.operationId, operationId);
  assert.equal(value.websiteId, websiteId);
  assert.equal(value.ready, false);
  assert.equal(value.status, 'partial');
  assert.deepEqual(value.progress, { required: 2, completed: 1, remaining: 1 });
  assert.equal('resources' in value, false);
  assert.equal('intent' in value.steps[0], false);
  assert.equal('evidence' in value.steps[0], false);
  assert.equal('evidence' in value.steps[0].compensation, false);
  assert.equal(value.steps[0].canRetry, false);
  assert.equal(value.steps[0].canCompensate, false);
  assert.deepEqual(value.steps[1], {
    id: 'nginx',
    kind: 'nginx',
    required: true,
    state: 'failed',
    error: 'website_nginx_activation_failed',
    compensation: {
      state: 'failed',
      error: 'website_nginx_compensation_failed',
    },
    canRetry: false,
    canCompensate: true,
  });
  assert.equal(JSON.stringify(value).includes('must-never-reach-browser'), false);
  assert.equal(JSON.stringify(value).includes('intent-secret'), false);
  assert.equal(JSON.stringify(value).includes('evidence-secret'), false);
}

test('status route returns only secret-safe durable provisioning state', async () => {
  const app = fakeApp();
  const operation = durableOperation();
  mountWebsiteProvisioningRoutes(app, {
    registry: registry({ get: async (id) => id === operationId ? operation : null }),
    orchestrator: orchestrator(),
  });

  const response = await invoke(
    app.routes.get.get('/api/sites/provisioning/:operationId'),
    { params: { operationId: operationId.toUpperCase() } },
  );
  assert.equal(response.statusCode, 200);
  assertSecretSafeOperation(response.payload.data);
});

test('Website latest provisioning route is restart-safe and returns null when no operation exists', async () => {
  const app = fakeApp();
  const calls = [];
  mountWebsiteProvisioningRoutes(app, {
    registry: registry({
      getLatestForWebsite: async (id) => {
        calls.push(id);
        return calls.length === 1 ? durableOperation() : null;
      },
    }),
    orchestrator: orchestrator(),
  });
  const handler = app.routes.get.get('/api/sites/:websiteId/provisioning/latest');

  const found = await invoke(handler, { params: { websiteId: websiteId.toUpperCase() } });
  assert.equal(found.statusCode, 200);
  assertSecretSafeOperation(found.payload.data);

  const missing = await invoke(handler, { params: { websiteId } });
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.payload, { data: null });
  assert.deepEqual(calls, [websiteId, websiteId]);
});

test('Website latest provisioning route rejects malformed Website ids before registry access', async () => {
  const app = fakeApp();
  let calls = 0;
  mountWebsiteProvisioningRoutes(app, {
    registry: registry({ getLatestForWebsite: async () => { calls += 1; return null; } }),
    orchestrator: orchestrator(),
  });

  await assert.rejects(
    invoke(app.routes.get.get('/api/sites/:websiteId/provisioning/latest'), { params: { websiteId: '../etc' } }),
    (error) => error instanceof WebsiteProvisioningHttpError
      && error.code === 'website_provisioning_website_invalid',
  );
  assert.equal(calls, 0);
});

test('public projection does not advertise compensation without a concrete handler', () => {
  const operation = durableOperation({
    steps: [{
      id: 'runtime',
      kind: 'runtime',
      required: true,
      state: 'failed',
      intent: { secret: true },
      evidence: null,
      error: 'runtime_failed',
      compensation: { state: 'pending', evidence: null, error: null },
    }],
  });
  const projected = websiteProvisioningHttpInternals.publicOperation(operation, () => false);
  assert.equal(projected.steps[0].canRetry, true);
  assert.equal(projected.steps[0].canCompensate, false);
});

test('public projection advertises earlier compensation only after later host-owning steps are compensated', () => {
  const operation = durableOperation({
    steps: [
      durableOperation().steps[0],
      {
        ...durableOperation().steps[1],
        state: 'compensated',
        error: null,
        compensation: {
          state: 'succeeded',
          evidence: { private: 'must-stay-server-side' },
          error: null,
        },
      },
    ],
  });

  const projected = websiteProvisioningHttpInternals.publicOperation(
    operation,
    (kind) => ['unix_identity', 'nginx'].includes(kind),
  );
  assert.equal(projected.steps[0].canCompensate, true);
  assert.equal(projected.steps[1].canCompensate, false);
  assert.equal(JSON.stringify(projected).includes('must-stay-server-side'), false);
});

test('continue route requires exact operation-bound confirmation', async () => {
  const app = fakeApp();
  let runCalls = 0;
  mountWebsiteProvisioningRoutes(app, {
    registry: registry(),
    orchestrator: orchestrator({ runNext: async () => { runCalls += 1; return {}; } }),
  });
  const handler = app.routes.post.get('/api/sites/provisioning/:operationId/continue');

  await assert.rejects(
    invoke(handler, { params: { operationId }, body: { confirmation: 'continue-site-provisioning:wrong' } }),
    (error) => error instanceof WebsiteProvisioningHttpError
      && error.code === 'website_provisioning_confirmation_required',
  );
  assert.equal(runCalls, 0);
});

test('continue route returns accepted while more provisioning work remains and redacts result state', async () => {
  const app = fakeApp();
  const result = {
    outcome: 'progressed',
    operation: durableOperation(),
    stepId: 'unix_identity',
  };
  mountWebsiteProvisioningRoutes(app, {
    registry: registry(),
    orchestrator: orchestrator({
      runNext: async (id) => {
        assert.equal(id, operationId);
        return result;
      },
    }),
  });

  const response = await invoke(
    app.routes.post.get('/api/sites/provisioning/:operationId/continue'),
    { params: { operationId }, body: { confirmation: `continue-site-provisioning:${operationId}` } },
  );
  assert.equal(response.statusCode, 202);
  assert.equal(response.payload.data.outcome, 'progressed');
  assert.equal(response.payload.data.stepId, 'unix_identity');
  assertSecretSafeOperation(response.payload.data.operation);
});

test('retry route requires confirmation bound to operation and step', async () => {
  const app = fakeApp();
  let retryCalls = 0;
  mountWebsiteProvisioningRoutes(app, {
    registry: registry(),
    orchestrator: orchestrator({ retryStep: async () => { retryCalls += 1; return {}; } }),
  });
  const handler = app.routes.post.get('/api/sites/provisioning/:operationId/steps/:stepId/retry');

  await assert.rejects(
    invoke(handler, {
      params: { operationId, stepId: 'unix_identity' },
      body: { confirmation: `retry-site-provisioning:${operationId}:runtime` },
    }),
    (error) => error instanceof WebsiteProvisioningHttpError
      && error.code === 'website_provisioning_retry_confirmation_required',
  );
  assert.equal(retryCalls, 0);
});

test('retry route re-runs only the confirmed failed step', async () => {
  const app = fakeApp();
  const result = {
    outcome: 'progressed',
    operation: durableOperation(),
    stepId: 'unix_identity',
  };
  const calls = [];
  mountWebsiteProvisioningRoutes(app, {
    registry: registry(),
    orchestrator: orchestrator({
      retryStep: async (id, provisioningStepId) => {
        calls.push([id, provisioningStepId]);
        return result;
      },
    }),
  });

  const response = await invoke(
    app.routes.post.get('/api/sites/provisioning/:operationId/steps/:stepId/retry'),
    {
      params: { operationId, stepId: 'unix_identity' },
      body: { confirmation: `retry-site-provisioning:${operationId}:unix_identity` },
    },
  );
  assert.equal(response.statusCode, 202);
  assert.deepEqual(calls, [[operationId, 'unix_identity']]);
  assertSecretSafeOperation(response.payload.data.operation);
});

test('compensation route requires confirmation bound to operation and step', async () => {
  const app = fakeApp();
  let compensationCalls = 0;
  mountWebsiteProvisioningRoutes(app, {
    registry: registry(),
    orchestrator: orchestrator({ compensateStep: async () => { compensationCalls += 1; return {}; } }),
  });
  const handler = app.routes.post.get('/api/sites/provisioning/:operationId/steps/:stepId/compensate');

  await assert.rejects(
    invoke(handler, {
      params: { operationId, stepId: 'nginx' },
      body: { confirmation: `compensate-site-provisioning:${operationId}:runtime` },
    }),
    (error) => error instanceof WebsiteProvisioningHttpError
      && error.code === 'website_provisioning_compensation_confirmation_required',
  );
  assert.equal(compensationCalls, 0);
});

test('compensation route invokes only the exactly confirmed step and redacts result state', async () => {
  const app = fakeApp();
  const result = {
    outcome: 'compensated',
    operation: durableOperation(),
    stepId: 'nginx',
  };
  const calls = [];
  mountWebsiteProvisioningRoutes(app, {
    registry: registry(),
    orchestrator: orchestrator({
      compensateStep: async (id, provisioningStepId) => {
        calls.push([id, provisioningStepId]);
        return result;
      },
    }),
  });

  const response = await invoke(
    app.routes.post.get('/api/sites/provisioning/:operationId/steps/:stepId/compensate'),
    {
      params: { operationId, stepId: 'nginx' },
      body: { confirmation: `compensate-site-provisioning:${operationId}:nginx` },
    },
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [[operationId, 'nginx']]);
  assertSecretSafeOperation(response.payload.data.operation);
});

test('continue body helper rejects additional fields', () => {
  assert.throws(
    () => websiteProvisioningHttpInternals.continueBody({
      confirmation: `continue-site-provisioning:${operationId}`,
      extra: true,
    }, operationId),
    (error) => error instanceof WebsiteProvisioningHttpError,
  );
});

test('compensation body helper rejects additional fields', () => {
  assert.throws(
    () => websiteProvisioningHttpInternals.compensateBody({
      confirmation: `compensate-site-provisioning:${operationId}:nginx`,
      extra: true,
    }, operationId, 'nginx'),
    (error) => error instanceof WebsiteProvisioningHttpError,
  );
});

test('retry helper rejects malformed step ids before any orchestration', () => {
  assert.throws(
    () => websiteProvisioningHttpInternals.stepId('../runtime'),
    (error) => error instanceof WebsiteProvisioningHttpError
      && error.code === 'website_provisioning_step_invalid',
  );
});


test('site_manager cannot read or mutate a foreign provisioning operation by operationId', async () => {
  const app = fakeApp();
  let runCalls = 0;
  mountWebsiteProvisioningRoutes(app, {
    registry: registry(),
    orchestrator: orchestrator({ runNext: async () => { runCalls += 1; return {}; } }),
    websiteRegistry: {
      getWebsite: async (id) => id === websiteId ? { id: websiteId, serverId: 'server-a' } : null,
    },
    localServerId: 'server-a',
  });
  const auth = {
    id: '33333333-3333-4333-8333-333333333333',
    user: { id: '44444444-4444-4444-8444-444444444444', role: 'site_manager', websiteIds: ['foreign-site'] },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };

  await assert.rejects(
    invoke(app.routes.get.get('/api/sites/provisioning/:operationId'), {
      auth,
      params: { operationId },
    }),
    (error) => error instanceof WebsiteProvisioningHttpError
      && error.code === 'website_provisioning_not_found'
      && error.status === 404,
  );

  await assert.rejects(
    invoke(app.routes.post.get('/api/sites/provisioning/:operationId/continue'), {
      auth,
      params: { operationId },
      body: { confirmation: `continue-site-provisioning:${operationId}` },
    }),
    (error) => error instanceof WebsiteProvisioningHttpError
      && error.code === 'website_provisioning_not_found',
  );
  assert.equal(runCalls, 0);
});

test('site_manager provisioning mutation passes exact live session actor to runtime', async () => {
  const app = fakeApp();
  const calls = [];
  const auth = {
    id: '33333333-3333-4333-8333-333333333333',
    user: { id: '44444444-4444-4444-8444-444444444444', role: 'site_manager', websiteIds: [websiteId] },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const result = { outcome: 'progressed', operation: durableOperation(), stepId: 'unix_identity' };
  mountWebsiteProvisioningRoutes(app, {
    registry: registry(),
    orchestrator: orchestrator({
      runNext: async (id, actor) => {
        calls.push({ id, actor });
        return result;
      },
    }),
    websiteRegistry: {
      getWebsite: async (id) => id === websiteId ? { id: websiteId, serverId: 'server-a' } : null,
    },
    localServerId: 'server-a',
  });

  const response = await invoke(
    app.routes.post.get('/api/sites/provisioning/:operationId/continue'),
    {
      auth,
      params: { operationId },
      body: { confirmation: `continue-site-provisioning:${operationId}` },
    },
  );
  assert.equal(response.statusCode, 202);
  assert.deepEqual(calls, [{
    id: operationId,
    actor: {
      sessionId: auth.id,
      userId: auth.user.id,
      role: 'site_manager',
    },
  }]);
});

test('site_manager latest route requires current Website grant and live local Website', async () => {
  const app = fakeApp();
  const auth = {
    id: '33333333-3333-4333-8333-333333333333',
    user: { id: '44444444-4444-4444-8444-444444444444', role: 'site_manager', websiteIds: [websiteId] },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  let websitePresent = true;
  mountWebsiteProvisioningRoutes(app, {
    registry: registry(),
    orchestrator: orchestrator(),
    websiteRegistry: {
      getWebsite: async () => websitePresent ? { id: websiteId, serverId: 'server-a' } : null,
    },
    localServerId: 'server-a',
  });
  const handler = app.routes.get.get('/api/sites/:websiteId/provisioning/latest');
  assert.equal((await invoke(handler, { auth, params: { websiteId } })).statusCode, 200);
  websitePresent = false;
  await assert.rejects(
    invoke(handler, { auth, params: { websiteId } }),
    (error) => error instanceof WebsiteProvisioningHttpError
      && error.code === 'website_provisioning_not_found',
  );
});
