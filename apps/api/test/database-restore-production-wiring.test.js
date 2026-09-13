import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobRegistry } from '../src/job-registry.js';
import { mountDatabaseRoutes } from '../src/database-http.js';

const serverId = '12345678-1234-4234-8234-123456789012';

function routeCollector() {
  const routes = [];
  return {
    routes,
    app: {
      get(path, ...handlers) { routes.push(['GET', path, handlers]); },
      post(path, ...handlers) { routes.push(['POST', path, handlers]); },
      delete(path, ...handlers) { routes.push(['DELETE', path, handlers]); },
    },
  };
}

test('database routes mount restore preview and apply when the durable job contract is available', async () => {
  const registry = createJobRegistry();
  await registry.init();
  const fx = routeCollector();
  mountDatabaseRoutes(fx.app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    jobRegistry: registry,
  });

  const paths = fx.routes.map(([method, path]) => `${method} ${path}`);
  assert.ok(paths.includes('POST /api/servers/:serverId/databases/:name/restore-preview'));
  assert.ok(paths.includes('POST /api/servers/:serverId/databases/:name/restore'));
});

test('database routes preserve compatibility with read-light job adapters that cannot verify restore evidence', () => {
  const fx = routeCollector();
  mountDatabaseRoutes(fx.app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    jobRegistry: {
      async listJobs() { return []; },
      async enqueue(input) { return { id: 'job-12345678', ...input, status: 'queued' }; },
    },
  });

  const paths = fx.routes.map(([method, path]) => `${method} ${path}`);
  assert.equal(paths.includes('POST /api/servers/:serverId/databases/:name/restore-preview'), false);
  assert.equal(paths.includes('POST /api/servers/:serverId/databases/:name/restore'), false);
});
