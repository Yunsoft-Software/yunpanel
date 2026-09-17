import assert from 'node:assert/strict';
import test from 'node:test';
import { mountWebsiteProvisioningRoutes } from '../src/website-provisioning-http.js';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const localServerId = '28dc1532-a2cb-4f29-9e0d-05f793652fa3';
const remoteServerId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

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

function orchestrator() {
  return {
    runNext: async () => ({}),
    retryStep: async () => ({}),
    compensateStep: async () => ({}),
    supportsCompensation: () => false,
  };
}

test('provisioning HTTP automatically exposes configured isolation audit capability', async () => {
  const app = fakeApp();
  const calls = [];
  const registry = {
    get: async () => null,
    getLatestForWebsite: async () => null,
    auditIsolation: async (id) => {
      calls.push(id);
      return { websiteId: id, status: 'isolated', migrationRequired: false };
    },
  };

  mountWebsiteProvisioningRoutes(app, { registry, orchestrator: orchestrator() });

  const handler = app.routes.get.get('/api/websites/:websiteId/isolation-audit');
  assert.equal(typeof handler, 'function');
  const response = await invoke(handler, { params: { websiteId: websiteId.toUpperCase() } });
  assert.deepEqual(calls, [websiteId]);
  assert.deepEqual(response.payload, {
    data: { websiteId, status: 'isolated', migrationRequired: false },
  });
});

test('runtime exposes isolation audit only after configuration and scopes it to the local host', async () => {
  const runtime = createWebsiteProvisioningRuntime();
  assert.equal(runtime.registry.auditIsolation, null);

  let currentServerId = localServerId;
  const websiteRegistry = {
    getWebsite: async (id) => ({
      id,
      serverId: currentServerId,
      runtimeType: 'proxy',
      applicationId: null,
      revision: 1,
    }),
  };
  const applicationRegistry = { getApplication: async () => null };

  runtime.configureIsolationAudit({ websiteRegistry, applicationRegistry, localServerId });
  assert.equal(typeof runtime.registry.auditIsolation, 'function');
  assert.equal(typeof runtime.isolationMigration?.start, 'function');
  assert.equal(typeof runtime.isolationMigration?.rollback, 'function');

  const local = await runtime.registry.auditIsolation(websiteId);
  assert.equal(local.websiteId, websiteId);
  assert.equal(local.applicable, false);
  assert.equal(local.status, 'not_applicable');

  currentServerId = remoteServerId;
  await assert.rejects(
    runtime.registry.auditIsolation(websiteId),
    (error) => error?.code === 'website_not_found' && error?.status === 404,
  );
});
