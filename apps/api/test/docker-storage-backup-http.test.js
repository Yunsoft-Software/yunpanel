import assert from 'node:assert/strict';
import test from 'node:test';
import { mountDockerStorageBackupRoutes } from '../src/docker-storage-backup-http.js';
import { requirePanelRouteAccess } from '../src/panel-http-guard.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';

function project(overrides = {}) {
  return {
    id: projectId,
    serverId,
    projectName: 'shop_app',
    revision: 3,
    services: [{
      name: 'web',
      storageMounts: [
        { kind: 'named_volume', source: 'data', sourceScope: 'project', target: '/data', readOnly: false },
        { kind: 'bind', source: '/srv/shared', sourceScope: 'host', target: '/shared', readOnly: false },
        { kind: 'ephemeral', source: null, sourceScope: null, target: '/run/cache', readOnly: false },
      ],
    }],
    ...overrides,
  };
}

function routeFixture(projectValue = project()) {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push({ path, handlers }); },
  };
  const registry = {
    async getProject(id) {
      return id === projectId ? projectValue : null;
    },
  };
  mountDockerStorageBackupRoutes(app, {
    dockerComposeProjectRegistry: registry,
    localServerId: serverId,
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/docker/projects/:dockerProjectId/storage-backup');
  assert.equal(routes[0].handlers[0], requirePanelRouteAccess);
  return routes[0].handlers[1];
}

async function invoke(handler, { id = projectId, query = {} } = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let forwarded = null;
  await handler({ params: { dockerProjectId: id }, query }, response, (error) => { forwarded = error; });
  if (forwarded) throw forwarded;
  return response;
}

test('Docker storage backup policy route is guarded and returns the derived versioned policy', async () => {
  const response = await invoke(routeFixture());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.manifestVersion, 1);
  assert.equal(response.body.data.projectId, projectId);
  assert.deepEqual(response.body.data.counts, { total: 3, included: 1, excluded: 1, rejected: 1 });
  assert.equal(
    response.body.data.resources.find((resource) => resource.storage.source === '/srv/shared').policy.disposition,
    'reject',
  );
  assert.equal(
    response.body.data.resources.find((resource) => resource.storage.kind === 'ephemeral').policy.disposition,
    'exclude',
  );
});

test('Docker storage backup policy route rejects query parameters', async () => {
  const response = await invoke(routeFixture(), { query: { include: 'all' } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    error: {
      code: 'docker_storage_backup_query_invalid',
      message: 'Docker storage backup policy does not accept query parameters',
    },
  });
});

test('Docker storage backup policy route hides foreign-server projects as not found', async () => {
  const response = await invoke(routeFixture(project({
    serverId: 'd0bc7f95-bdbd-4375-904f-50c532fc3faa',
  })));
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error.code, 'docker_compose_project_not_found');
});

test('Docker storage backup policy route fails closed on invalid persisted storage state', async () => {
  const response = await invoke(routeFixture(project({
    services: [{
      name: 'web',
      storageMounts: [{ kind: 'bind', source: './../outside', sourceScope: 'project', target: '/data', readOnly: false }],
    }],
  })));
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    error: {
      code: 'docker_storage_backup_state_invalid',
      message: 'Docker storage backup state is invalid',
    },
  });
});
