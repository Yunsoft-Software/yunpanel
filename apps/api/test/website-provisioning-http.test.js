import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mountWebsiteProvisioningRoutes,
  WebsiteProvisioningHttpError,
  websiteProvisioningHttpInternals,
} from '../src/website-provisioning-http.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';

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

async function invoke(handler, request) {
  const response = fakeResponse();
  let nextError = null;
  await handler(request, response, (error) => { nextError = error; });
  if (nextError) throw nextError;
  return response;
}

function orchestrator(overrides = {}) {
  return {
    runNext: async () => ({}),
    retryStep: async () => ({}),
    compensateStep: async () => ({}),
    ...overrides,
  };
}

test('status route returns durable provisioning state', async () => {
  const app = fakeApp();
  const operation = { operationId, ready: false, status: 'partial' };
  mountWebsiteProvisioningRoutes(app, {
    registry: { get: async (id) => id === operationId ? operation : null },
    orchestrator: orchestrator(),
  });

  const response = await invoke(
    app.routes.get.get('/api/sites/provisioning/:operationId'),
    { params: { operationId: operationId.toUpperCase() } },
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { data: operation });
});

test('continue route requires exact operation-bound confirmation', async () => {
  const app = fakeApp();
  let runCalls = 0;
  mountWebsiteProvisioningRoutes(app, {
    registry: { get: async () => ({}) },
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

test('continue route returns accepted while more provisioning work remains', async () => {
  const app = fakeApp();
  const result = { outcome: 'progressed', operation: { operationId, ready: false, status: 'partial' }, stepId: 'unix_identity' };
  mountWebsiteProvisioningRoutes(app, {
    registry: { get: async () => result.operation },
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
  assert.deepEqual(response.payload, { data: result });
});

test('retry route requires confirmation bound to operation and step', async () => {
  const app = fakeApp();
  let retryCalls = 0;
  mountWebsiteProvisioningRoutes(app, {
    registry: { get: async () => ({}) },
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
    operation: { operationId, ready: false, status: 'partial' },
    stepId: 'unix_identity',
  };
  const calls = [];
  mountWebsiteProvisioningRoutes(app, {
    registry: { get: async () => result.operation },
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
  assert.deepEqual(response.payload, { data: result });
});

test('compensation route requires confirmation bound to operation and step', async () => {
  const app = fakeApp();
  let compensationCalls = 0;
  mountWebsiteProvisioningRoutes(app, {
    registry: { get: async () => ({}) },
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

test('compensation route invokes only the exactly confirmed step', async () => {
  const app = fakeApp();
  const result = {
    outcome: 'compensated',
    operation: { operationId, ready: false, status: 'partial' },
    stepId: 'nginx',
  };
  const calls = [];
  mountWebsiteProvisioningRoutes(app, {
    registry: { get: async () => result.operation },
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
  assert.deepEqual(response.payload, { data: result });
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
