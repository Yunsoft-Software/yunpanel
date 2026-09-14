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

test('status route returns durable provisioning state', async () => {
  const app = fakeApp();
  const operation = { operationId, ready: false, status: 'partial' };
  mountWebsiteProvisioningRoutes(app, {
    registry: { get: async (id) => id === operationId ? operation : null },
    orchestrator: { runNext: async () => ({}) },
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
    orchestrator: { runNext: async () => { runCalls += 1; return {}; } },
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
    orchestrator: { runNext: async (id) => {
      assert.equal(id, operationId);
      return result;
    } },
  });

  const response = await invoke(
    app.routes.post.get('/api/sites/provisioning/:operationId/continue'),
    { params: { operationId }, body: { confirmation: `continue-site-provisioning:${operationId}` } },
  );
  assert.equal(response.statusCode, 202);
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
