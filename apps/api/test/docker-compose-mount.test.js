import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mountDockerWorkloadRoutes } from '../src/docker-workload-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const management = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function listen(t) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = management; next(); });
  const project = {
    id: projectId, serverId, projectName: 'app', revision: 1,
    composeSha256: 'a'.repeat(64), composeBytes: 10,
    services: [{ name: 'web', imageConfigured: true, buildConfigured: false }],
    networks: [], volumes: [], secretCount: 0, configCount: 0,
    documentConfigured: true, createdAt: '2026-09-13T06:00:00.000Z', updatedAt: '2026-09-13T06:00:00.000Z',
  };
  const projectRegistry = {
    async createProject() { return project; },
    async updateProject() { return project; },
    async getProject(id) { return id === projectId ? project : null; },
    async listProjects() { return [project]; },
    async materializeProject() { return { ...project, document: 'services: {}' }; },
  };
  const environmentRegistry = {
    async getEnvironment() { return { projectId, revision: 0, keys: [], variableCount: 0, configured: false, updatedAt: null }; },
    async replaceEnvironment() { return { projectId, revision: 1, keys: [], variableCount: 0, configured: false, updatedAt: null }; },
    async materializeEnvironment() { return { projectId, revision: 0, variables: {} }; },
  };
  const credentialRegistry = {
    async listCredentials() { return []; },
    async setCredential() { return { projectId, registryHost: 'docker.io', revision: 1, configured: true, usernameConfigured: true }; },
  };
  mountDockerWorkloadRoutes(app, {
    dockerWorkloadRegistry: {
      async createWorkload(input) { return { id: 'external-1', state: 'unverified', ...input }; },
      async getWorkload() { return null; },
      async listWorkloads() { return []; },
    },
    localServerId: serverId,
    dockerComposeProjectRegistry: projectRegistry,
    dockerComposeEnvironmentRegistry: environmentRegistry,
    dockerRegistryCredentialRegistry: credentialRegistry,
    validateDockerCompose: async ({ projectName }) => ({
      version: 1, projectName, composeSha256: 'a'.repeat(64), composeBytes: 10,
      serviceCount: 1, services: [{ name: 'web', imageConfigured: true, buildConfigured: false }],
      networks: [], volumes: [], secretCount: 0, configCount: 0, validated: true, sideEffects: false,
    }),
  });
  app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({ error: { code: error.code ?? 'internal_error' } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Docker workload mount exposes managed Compose routes without replacing external tracking', async (t) => {
  const base = await listen(t);
  const projects = await fetch(`${base}/api/docker/projects`);
  assert.equal(projects.status, 200);
  assert.equal((await projects.json()).data[0].id, projectId);

  const external = await fetch(`${base}/api/docker/workloads`);
  assert.equal(external.status, 200);
  assert.deepEqual((await external.json()).data, []);
});
