import assert from 'node:assert/strict';
import test from 'node:test';
import { WebsiteIsolationAuditError } from '../src/website-isolation-audit.js';
import {
  mountWebsiteIsolationAuditRoutes,
  websiteIsolationAuditHttpInternals,
} from '../src/website-isolation-audit-http.js';
import { WebsiteRegistryError } from '../src/website-registry.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const localServerId = '28dc1532-a2cb-4f29-9e0d-05f793652fa3';

function fakeApp() {
  const routes = { get: new Map(), post: new Map() };
  return {
    routes,
    get(path, ...handlers) { routes.get.set(path, handlers); },
    post(path, ...handlers) { routes.post.set(path, handlers); },
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
  return { response, nextError };
}

test('Website isolation audit route is panel-auth guarded and returns local audit data', async () => {
  const app = fakeApp();
  const calls = [];
  mountWebsiteIsolationAuditRoutes(app, {
    websiteRegistry: {
      getWebsite: async (id) => ({ id, serverId: localServerId }),
    },
    auditService: {
      audit: async (id) => {
        calls.push(id);
        return { websiteId: id, status: 'isolated', migrationRequired: false };
      },
    },
    localServerId,
  });

  const handlers = app.routes.get.get('/api/websites/:websiteId/isolation-audit');
  assert.equal(handlers.length, 2);
  assert.equal(typeof handlers[0], 'function');
  const { response, nextError } = await invoke(handlers[1], { params: { websiteId } });
  assert.equal(nextError, null);
  assert.deepEqual(calls, [websiteId]);
  assert.deepEqual(response.payload, {
    data: { websiteId, status: 'isolated', migrationRequired: false },
  });
});

test('Website isolation audit hides Websites outside the local panel host', async () => {
  const app = fakeApp();
  let audited = false;
  mountWebsiteIsolationAuditRoutes(app, {
    websiteRegistry: {
      getWebsite: async (id) => ({ id, serverId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7' }),
    },
    auditService: {
      audit: async () => { audited = true; return {}; },
    },
    localServerId,
  });

  const handler = app.routes.get.get('/api/websites/:websiteId/isolation-audit').at(-1);
  const { nextError } = await invoke(handler, { params: { websiteId } });
  assert.equal(audited, false);
  assert.ok(nextError instanceof WebsiteRegistryError);
  assert.equal(nextError.code, 'website_not_found');
  assert.equal(nextError.status, 404);
});

test('Website isolation audit service errors map into the existing Website HTTP error contract', async () => {
  const app = fakeApp();
  mountWebsiteIsolationAuditRoutes(app, {
    websiteRegistry: {
      getWebsite: async (id) => ({ id, serverId: localServerId }),
    },
    auditService: {
      audit: async () => {
        throw new WebsiteIsolationAuditError(
          'website_isolation_binding_drift',
          'Website isolation binding drifted',
          409,
        );
      },
    },
    localServerId,
  });

  const handler = app.routes.get.get('/api/websites/:websiteId/isolation-audit').at(-1);
  const { nextError } = await invoke(handler, { params: { websiteId } });
  assert.ok(nextError instanceof WebsiteRegistryError);
  assert.equal(nextError.code, 'website_isolation_binding_drift');
  assert.equal(nextError.status, 409);
});

test('audit error mapper leaves unrelated failures untouched', () => {
  const error = new Error('boom');
  assert.equal(websiteIsolationAuditHttpInternals.mappedAuditError(error), error);
});

test('Website isolation migration routes forward exact apply and rollback contracts', async () => {
  const app = fakeApp();
  const calls = [];
  const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
  const previewDigest = 'a'.repeat(64);
  mountWebsiteIsolationAuditRoutes(app, {
    auditService: { audit: async () => ({}) },
    migrationRuntime: {
      async start(input) {
        calls.push(['start', input]);
        return { id: operationId, websiteId, status: 'succeeded' };
      },
      async rollback(input) {
        calls.push(['rollback', input]);
        return { id: operationId, websiteId, status: 'compensated' };
      },
      async get(id) { return { id, websiteId, status: 'succeeded' }; },
      async listForWebsite(id) { return [{ id: operationId, websiteId: id }]; },
    },
  });

  const apply = app.routes.post.get('/api/websites/:websiteId/isolation-migrations').at(-1);
  const applied = await invoke(apply, {
    params: { websiteId },
    body: { expectedPreviewDigest: previewDigest, confirmation: `migrate-isolation:${websiteId}:3:${previewDigest}` },
  });
  assert.equal(applied.nextError, null);
  assert.equal(applied.response.payload.data.status, 'succeeded');

  const rollback = app.routes.post.get('/api/websites/:websiteId/isolation-migrations/:operationId/rollback').at(-1);
  const rolledBack = await invoke(rollback, {
    params: { websiteId, operationId },
    body: { confirmation: `rollback-isolation-migration:${operationId}:${previewDigest}` },
  });
  assert.equal(rolledBack.nextError, null);
  assert.equal(rolledBack.response.payload.data.status, 'compensated');
  assert.deepEqual(calls, [
    ['start', {
      websiteId,
      previewDigest,
      confirmation: `migrate-isolation:${websiteId}:3:${previewDigest}`,
    }],
    ['rollback', {
      operationId,
      confirmation: `rollback-isolation-migration:${operationId}:${previewDigest}`,
    }],
  ]);
});

test('Website isolation migration routes reject expanded apply bodies before runtime', async () => {
  const app = fakeApp();
  let started = false;
  mountWebsiteIsolationAuditRoutes(app, {
    auditService: { audit: async () => ({}) },
    migrationRuntime: {
      async start() { started = true; return {}; },
      async rollback() { return {}; },
      async get() { return { websiteId }; },
      async listForWebsite() { return []; },
    },
  });
  const apply = app.routes.post.get('/api/websites/:websiteId/isolation-migrations').at(-1);
  const result = await invoke(apply, {
    params: { websiteId },
    body: { expectedPreviewDigest: 'a'.repeat(64), confirmation: 'value', recursive: true },
  });
  assert.equal(started, false);
  assert.ok(result.nextError instanceof WebsiteRegistryError);
  assert.equal(result.nextError.code, 'website_isolation_migration_input_invalid');
});

test('Website isolation migration apply hides remote Website before mutation', async () => {
  const app = fakeApp();
  let started = false;
  mountWebsiteIsolationAuditRoutes(app, {
    websiteRegistry: {
      getWebsite: async (id) => ({ id, serverId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7' }),
    },
    localServerId,
    auditService: { audit: async () => ({}) },
    migrationRuntime: {
      async start() { started = true; return {}; },
      async rollback() { return {}; },
      async get() { return { websiteId }; },
      async listForWebsite() { return []; },
    },
  });

  const apply = app.routes.post.get('/api/websites/:websiteId/isolation-migrations').at(-1);
  const result = await invoke(apply, {
    params: { websiteId },
    body: { expectedPreviewDigest: 'a'.repeat(64), confirmation: 'value' },
  });
  assert.equal(started, false);
  assert.ok(result.nextError instanceof WebsiteRegistryError);
  assert.equal(result.nextError.code, 'website_not_found');
  assert.equal(result.nextError.status, 404);
});
