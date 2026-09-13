import assert from 'node:assert/strict';
import test from 'node:test';
import { mountDockerComposeRoutes } from '../src/docker-compose-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const document = 'services:\n  web:\n    image: nginx\n';

function mounted() {
  const routes = [];
  const calls = [];
  const project = {
    id: projectId,
    serverId,
    projectName: 'shop_app',
    revision: 1,
    composeSha256: 'a'.repeat(64),
    composeBytes: Buffer.byteLength(document),
    services: [{ name: 'web', imageConfigured: true, buildConfigured: false }],
    networks: [],
    volumes: [],
    secretCount: 0,
    configCount: 0,
    documentConfigured: true,
    createdAt: '2026-09-13T06:00:00.000Z',
    updatedAt: '2026-09-13T06:00:00.000Z',
  };
  const environmentState = {
    projectId, revision: 0, keys: [], variableCount: 0, configured: false, updatedAt: null,
  };
  const operationPreview = {
    version: 1,
    action: 'start',
    operation: 'docker.compose.start',
    serverId,
    projectId,
    projectName: 'shop_app',
    projectRevision: 1,
    environmentRevision: 0,
    composeSha256: 'a'.repeat(64),
    credentialRevisions: [],
    previewDigest: 'b'.repeat(64),
    confirmation: `docker-compose:start:shop_app:${'b'.repeat(64)}`,
    sideEffects: false,
  };
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers]); },
    put(path, ...handlers) { routes.push(['PUT', path, handlers]); },
  };
  const projectRegistry = {
    async createProject(input) { calls.push(['createProject', input]); return project; },
    async updateProject(id, input) { calls.push(['updateProject', id, input]); return { ...project, revision: 2 }; },
    async getProject(id) { return id === projectId ? project : null; },
    async listProjects() { return [project]; },
    async materializeProject() { return { ...project, document }; },
  };
  const environmentRegistry = {
    async getEnvironment() { return environmentState; },
    async replaceEnvironment(id, input) {
      calls.push(['replaceEnvironment', id, input]);
      return { ...environmentState, revision: 1, keys: Object.keys(input.variables), configured: true };
    },
    async materializeEnvironment() { return { projectId, revision: 0, variables: {} }; },
  };
  const credentialRegistry = {
    async listCredentials() { return []; },
    async setCredential(id, input) {
      calls.push(['setCredential', id, input]);
      return { projectId: id, registryHost: input.registryHost, revision: 1, configured: true, usernameConfigured: true };
    },
  };
  const operationsService = {
    async preview(input) {
      calls.push(['operationPreview', input]);
      return { ...operationPreview, action: input.action };
    },
    async queue(input) {
      calls.push(['operationQueue', input]);
      return {
        previewDigest: input.expectedPreviewDigest,
        job: {
          id: '420e65d7-3205-43d7-89aa-8f2d66714ee0',
          operation: `docker.compose.${input.action}`,
          resourceType: 'docker_project',
          resourceId: input.projectId,
          status: 'queued',
        },
      };
    },
  };
  const validateDockerCompose = async (input) => {
    calls.push(['validate', input]);
    return {
      version: 1,
      projectName: input.projectName,
      composeSha256: 'a'.repeat(64),
      composeBytes: Buffer.byteLength(input.document),
      serviceCount: 1,
      services: [{ name: 'web', imageConfigured: true, buildConfigured: false }],
      networks: [], volumes: [], secretCount: 0, configCount: 0, validated: true, sideEffects: false,
    };
  };
  mountDockerComposeRoutes(app, {
    dockerComposeProjectRegistry: projectRegistry,
    dockerComposeEnvironmentRegistry: environmentRegistry,
    dockerRegistryCredentialRegistry: credentialRegistry,
    dockerComposeOperationsService: operationsService,
    validateDockerCompose,
    localServerId: serverId,
  });
  return { routes, calls, operationPreview };
}

function route(fx, method, suffix) {
  const match = fx.routes.find(([candidateMethod, path]) => candidateMethod === method && path.endsWith(suffix));
  assert.ok(match, `route ${method} ${suffix} missing`);
  return match[2].at(-1);
}

async function invoke(handler, { body = {}, params = {}, query = {} } = {}) {
  let status = 200;
  let payload = null;
  let error = null;
  const response = {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  };
  await handler({ body, params, query }, response, (value) => { error = value; });
  return { status, payload, error };
}

test('compose project create performs structural validation and reports no host side effects', async () => {
  const fx = mounted();
  const response = await invoke(route(fx, 'POST', '/api/docker/projects'), {
    body: { serverId, projectName: 'shop_app', document },
  });
  assert.equal(response.error, null);
  assert.equal(response.status, 201);
  const validation = fx.calls.find(([name]) => name === 'validate')[1];
  assert.equal(validation.interpolate, false);
  assert.deepEqual(validation.environment, {});
  assert.equal(response.payload.sideEffects, false);
  assert.equal(JSON.stringify(response.payload).includes(document), false);
});

test('compose environment is fully validated before revisioned values are persisted', async () => {
  const fx = mounted();
  const variables = { IMAGE: 'nginx:1.28' };
  const response = await invoke(route(fx, 'PUT', '/environment'), {
    params: { dockerProjectId: projectId },
    body: { expectedRevision: 0, variables },
  });
  assert.equal(response.error, null);
  const validation = fx.calls.find(([name]) => name === 'validate')[1];
  assert.equal(validation.interpolate, true);
  assert.deepEqual(validation.environment, variables);
  assert.ok(fx.calls.some(([name]) => name === 'replaceEnvironment'));
  assert.equal(response.payload.sideEffects, false);
});

test('compose lifecycle preview is side-effect free and bound to the local project', async () => {
  const fx = mounted();
  const response = await invoke(route(fx, 'POST', '/operations/:action/preview'), {
    params: { dockerProjectId: projectId, action: 'start' },
    body: {},
  });
  assert.equal(response.error, null);
  assert.equal(response.status, 200);
  assert.equal(response.payload.sideEffects, false);
  assert.equal(response.payload.data.previewDigest, fx.operationPreview.previewDigest);
  assert.deepEqual(fx.calls.find(([name]) => name === 'operationPreview')[1], {
    projectId,
    action: 'start',
  });
});

test('compose lifecycle queue requires the preview digest and confirmation', async () => {
  const fx = mounted();
  const response = await invoke(route(fx, 'POST', '/operations/:action'), {
    params: { dockerProjectId: projectId, action: 'start' },
    body: {
      expectedPreviewDigest: fx.operationPreview.previewDigest,
      confirmation: fx.operationPreview.confirmation,
    },
  });
  assert.equal(response.error, null);
  assert.equal(response.status, 202);
  assert.equal(response.payload.sideEffects, false);
  assert.equal(response.payload.data.job.status, 'queued');
  assert.deepEqual(fx.calls.find(([name]) => name === 'operationQueue')[1], {
    projectId,
    action: 'start',
    expectedPreviewDigest: fx.operationPreview.previewDigest,
    confirmation: fx.operationPreview.confirmation,
  });
});

test('registry credential route returns public metadata only', async () => {
  const fx = mounted();
  const response = await invoke(route(fx, 'PUT', '/credentials'), {
    params: { dockerProjectId: projectId },
    body: { registryHost: 'ghcr.io', expectedRevision: 0, username: 'user', secret: 'opaque' },
  });
  assert.equal(response.error, null);
  assert.equal(response.payload.data.configured, true);
  assert.equal(Object.hasOwn(response.payload.data, 'username'), false);
  assert.equal(Object.hasOwn(response.payload.data, 'secret'), false);
  assert.equal(response.payload.sideEffects, false);
});
