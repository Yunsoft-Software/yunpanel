import assert from 'node:assert/strict';
import test from 'node:test';
import { mountApplicationPassengerMigrationRoutes } from '../src/application-passenger-migration-http.js';

function captureApp() {
  const routes = [];
  return {
    routes,
    get(path, ...handlers) { routes.push({ method: 'GET', path, handlers }); },
    post(path, ...handlers) { routes.push({ method: 'POST', path, handlers }); },
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('mounts preview and apply routes and forwards canonical apply input', async () => {
  const app = captureApp();
  const calls = [];
  const preview = { previewDigest: 'a'.repeat(64), ready: true };
  const applied = { preview, job: { id: 'job-1', status: 'queued' } };
  mountApplicationPassengerMigrationRoutes(app, {
    previewService: {
      async preview(applicationId) {
        calls.push({ type: 'preview', applicationId });
        return preview;
      },
    },
    migrationService: {
      async apply(applicationId, input) {
        calls.push({ type: 'apply', applicationId, input });
        return applied;
      },
    },
  });

  assert.deepEqual(app.routes.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/api/applications/:applicationId/passenger-migration-preview' },
    { method: 'POST', path: '/api/applications/:applicationId/passenger-migration' },
  ]);

  const applyRoute = app.routes[1];
  const request = {
    params: { applicationId: 'app-1' },
    body: { previewDigest: 'a'.repeat(64), confirmation: 'migrate-node-passenger:app-1:digest' },
  };
  const response = responseRecorder();
  let forwardedError = null;
  await applyRoute.handlers.at(-1)(request, response, (error) => { forwardedError = error; });

  assert.equal(forwardedError, null);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, { data: applied });
  assert.deepEqual(calls, [{ type: 'apply', applicationId: 'app-1', input: request.body }]);
});

test('forwards apply service failures to Express error handling', async () => {
  const app = captureApp();
  const failure = Object.assign(new Error('stale'), { code: 'node_passenger_migration_preview_stale' });
  mountApplicationPassengerMigrationRoutes(app, {
    previewService: { async preview() { return {}; } },
    migrationService: { async apply() { throw failure; } },
  });

  const response = responseRecorder();
  let forwardedError = null;
  await app.routes[1].handlers.at(-1)(
    { params: { applicationId: 'app-1' }, body: {} },
    response,
    (error) => { forwardedError = error; },
  );

  assert.equal(forwardedError, failure);
  assert.equal(response.body, null);
});
