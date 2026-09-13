import assert from 'node:assert/strict';
import test from 'node:test';
import { mountDockerComposeRoutes } from '../src/docker-compose-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';

function fixture() {
  const routes = [];
  const calls = [];
  const project = {
    id: projectId,
    serverId,
    projectName: 'shop_app',
    revision: 1,
    services: [{
      name: 'web',
      imageConfigured: true,
      buildConfigured: false,
      publishedPorts: [{ hostIp: '0.0.0.0', publishedPort: 49152, targetPort: 3000, protocol: 'tcp' }],
    }],
  };
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers]); },
    put(path, ...handlers) { routes.push(['PUT', path, handlers]); },
  };
  const projectRegistry = {
    async createProject() { return project; },
    async updateProject() { return project; },
    async getProject(id) { return id === projectId ? project : null; },
    async listProjects() { return [project]; },
    async materializeProject() { return { ...project, document: 'services: {}' }; },
  };
  const environmentRegistry = {
    async getEnvironment() { return { projectId, revision: 0, keys: [], configured: false }; },
    async replaceEnvironment() { return { projectId, revision: 1, keys: [], configured: false }; },
    async materializeEnvironment() { return { projectId, revision: 0, variables: {} }; },
  };
  const credentialRegistry = {
    async listCredentials() { return []; },
    async setCredential() { return { projectId, revision: 1, configured: true }; },
  };
  const operationsService = {
    async history() { return []; },
    async preview() { return {}; },
    async queue() { return {}; },
  };
  const observer = {
    async inspect(input) {
      calls.push(['inspect', input]);
      return {
        version: 1,
        projectName: project.projectName,
        service: input.service,
        status: 'running',
        containerCount: 1,
        containers: [{
          runtime: {
            status: 'running', running: true, paused: false, restarting: false,
            oomKilled: false, dead: false, exitCode: 0,
            health: { status: 'healthy', failingStreak: 0 },
          },
        }],
      };
    },
    async logs() { return { containers: [] }; },
  };
  mountDockerComposeRoutes(app, {
    dockerComposeProjectRegistry: projectRegistry,
    dockerComposeEnvironmentRegistry: environmentRegistry,
    dockerRegistryCredentialRegistry: credentialRegistry,
    dockerComposeOperationsService: operationsService,
    dockerComposeObserver: observer,
    validateDockerCompose: async () => ({}),
    localServerId: serverId,
  });
  const entry = routes.find(([method, path]) => method === 'GET' && path === '/api/docker/projects/:dockerProjectId/diagnosis');
  assert.ok(entry);
  return { handler: entry[2].at(-1), calls };
}

async function invoke(handler, query) {
  let status = 200;
  let payload = null;
  let error = null;
  const response = {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  };
  await handler({ params: { dockerProjectId: projectId }, query }, response, (value) => { error = value; });
  return { status, payload, error };
}

test('compose diagnosis resolves current loopback target and service-scoped runtime health', async () => {
  const fx = fixture();
  const result = await invoke(fx.handler, { service: 'web', targetPort: '3000' });
  assert.equal(result.error, null);
  assert.equal(result.status, 200);
  assert.equal(result.payload.data.status, 'ready');
  assert.deepEqual(result.payload.data.target, { ready: true, host: '127.0.0.1', port: 49152 });
  assert.deepEqual(result.payload.data.binding, {
    projectId,
    serviceName: 'web',
    targetPort: 3000,
    protocol: 'tcp',
  });
  assert.deepEqual(fx.calls, [['inspect', { projectName: 'shop_app', service: 'web' }]]);
});

test('compose diagnosis rejects missing, extra and out-of-range query fields before inspection', async () => {
  for (const query of [
    { service: 'web' },
    { service: 'web', targetPort: '0' },
    { service: 'web', targetPort: '65536' },
    { service: 'web', targetPort: '3000', extra: 'x' },
  ]) {
    const fx = fixture();
    const result = await invoke(fx.handler, query);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error.code, 'docker_compose_diagnosis_query_invalid');
    assert.equal(fx.calls.length, 0);
  }
});
